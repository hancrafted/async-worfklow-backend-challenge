# Design Decisions

This document records pragmatic choices made for the scope of this coding challenge. Each entry pairs the chosen approach with the production-grade alternative we would consider in a real setting. The PRD (`PRD.md`) is the high-level summary; this file carries the rationale and trade-off bookkeeping that would otherwise pollute it.

## General Assumptions

- **Single-process Node, in-process worker pool.** Default `N=3`, override via `WORKER_POOL_SIZE`. All workers share one `AppDataSource` and run as coroutines on the same event loop.
  - *Production-grade:* horizontal scaling via N processes / containers; cross-process claim via a DB advisory lock or an external queue (Redis Streams, SQS, RabbitMQ).
- **Fresh SQLite DB on every restart** (`synchronize: true` against a file that is reset on boot). No migrations, no claim recovery, no lease/heartbeat on `in_progress` rows. Prepared defense for the *"where's the lease?"* objection — including the four-layer rebuttal, when-to-add-a-lease conditions, and why a per-job timeout is the right answer to hangs — lives in [`no-lease-and-heartbeat.md`](./no-lease-and-heartbeat.md).
  - *Production-grade:* persistent DB + TypeORM migrations + boot-time recovery sweep that resets stale `in_progress` rows older than the worker heartbeat back to `queued`.
- **No graceful shutdown.** `SIGINT` / `SIGTERM` cause `process.exit` immediately. In-flight tasks during shutdown are abandoned; the next boot starts from an empty DB so their state is irrelevant.
  - *Production-grade:* drain workers, refuse new claims, wait for in-flight tasks up to a configurable timeout, then exit.
- **No authentication / authorization** on any endpoint.
  - *Production-grade:* API keys, JWT, or mTLS depending on deployment context; per-client rate limiting.
- **Structured JSON-line logs to stdout** via a tiny in-house wrapper around `console.log` / `console.error`. No new dependencies; `jq` is the dev-mode pretty-printer.
  - *Production-grade:* swap the wrapper for `pino` (or similar) for zero-cost structured logging, log routing, correlation IDs, OpenTelemetry traces.
- **Inline error helper, no Express error middleware.** A small `errorResponse(res, status, code, message)` is called from each route handler.
  - *Production-grade:* typed error classes + centralized middleware + RFC 7807 (problem+json) compliance with consistent logging hooks.
- **No retries, no exponential backoff, no circuit breaker, no dead-letter queue.** Runner-level exceptions are treated as transient (log + sleep 5s + retry); job-level exceptions go straight to `failed`.
  - *Production-grade:* per-task retry policy with bounded attempts + exp backoff + jitter; DLQ for poison messages.
- **No health-check endpoint.**
  - *Production-grade:* `/healthz` reflecting worker liveness (e.g., flips `unhealthy` if no claim has occurred in K minutes).
- **TDD-first development** with the `tdd` skill (red → green → refactor). Test framework is **Vitest**. New fixture YAMLs live in `tests/test-workflows/`. The HTTP `POST /analysis` endpoint stays hardcoded to load `src/workflows/example_workflow.yml`; tests load other YAMLs directly via `WorkflowFactory`.
  - *Production-grade:* workflow templates indexed by name in a config service; `POST /analysis` accepts a `workflowName` parameter from a registered set.

## Per-Task Decisions

### Task 0 — Test Harness & Quality Gates (PRD §Task 0)

- **Vitest over Jest.** Faster cold start, native ESM/TS, identical mocking surface for the scope we need. No production-grade alternative — Vitest is also production-grade.
- **Manual drain over real / fake timers in integration tests.** Tests invoke the worker tick synchronously in a loop until the queue empties, instead of letting the production 5s sleep elapse or stubbing it with fake timers. Rejected alternatives:
  - *Real timers:* turns a 50ms test into a 5s test; unworkable for a >50-test suite.
  - *Fake timers:* leaks Vitest's `vi.useFakeTimers()` into worker code paths and forces every async primitive in the runner (timers, promises, queue microtasks) to be aware of the fake clock. Brittle.
  - *Production-grade:* tests use real timers; the worker pool is replaced by an external queue (Redis Streams / SQS) whose driver exposes a synchronous "drain" hook for integration testing.
- **Husky pre-commit + pre-push, layered.** Pre-commit runs `lint-staged` (ESLint + `tsc --noEmit` + `vitest related --run`) on staged `*.ts` only — fast enough that auto-commit on doc edits stays cheap, fast enough on code edits to not discourage atomic commits. Pre-push runs the full `npm test` suite. Branch B verification confirmed both raw `git commit` and the workspace's `agentCommit` API respect the hooks; the hook is an unbypassable gate for the agent.
  - *Production-grade:* CI-on-PR (GitHub Actions) is the real gate. Local hooks are a faster shadow of CI for the developer (and agent) feedback loop. CI is out of scope for this single-developer challenge; if this were a team repo, the hooks would stay (cheap local feedback) and CI would back them up (authoritative gate).
- **`--no-verify` is forbidden.** Reflected in `CLAUDE.md` for the implementor subagents. The hook contract is one-way: a hook failure means fix the code, not skip the hook.
- **ESLint rule baseline.** TypeScript-ESLint with the rules the agent most commonly violates promoted to `error`:
  - `@typescript-eslint/no-unused-vars`, `@typescript-eslint/no-explicit-any`, `@typescript-eslint/explicit-function-return-type` (exported functions only)
  - `complexity: ["error", 10]`, `max-lines-per-function: ["error", 80]`, `max-depth: ["error", 4]`
  - `no-console: ["error", { allow: ["warn", "error"] }]` — production logs go through the JSON-line wrapper, not bare `console.log`.
  - `tests/**` overrides relax `max-lines-per-function`, `complexity`, and `no-explicit-any` (test fixtures legitimately use loose types).
  - *Production-grade:* same baseline plus `eslint-plugin-import` for boundary enforcement, `eslint-plugin-security`, and a custom rule prohibiting direct `Repository.save()` outside the runner's transaction helper.

### Task 1 — PolygonAreaJob (README §1)

- **Output storage.** Task output lives in the existing `Result.data` column rather than a new `Task.output` column. The README phrase *"save the result in the output field of the task"* is interpreted as the *logical* output (Task → Result via `resultId`). Full prepared defense — README internal-consistency argument, four-layer rebuttal, when-to-cave conditions — in [`no-task-output-column.md`](./no-task-output-column.md). Rationale:
  1. **Separation of concerns** — `tasks` is the hot, polled table; outputs can be large JSON blobs and don't belong on every poll.
  2. **Future-proof for retries / multiple attempts** — a production extension can record one `Result` per attempt without touching the task row.
  3. **Storage flexibility** — `Result` rows could later move to object storage keyed by `resultId` while `Task` stays in OLTP.
  4. **Lifecycle clarity** — terminal tasks may have no `Result` (e.g. `skipped`); the absence of `resultId` is meaningful.
  - *Production-grade:* same shape; the choice would be the same.
- **Invalid-GeoJSON handling.** `@turf/area` failures are caught and persisted as `Result.error = { message: "Invalid GeoJSON: …", reason: "job_error", stack }`. Task transitions to `failed`, triggering the workflow-level fail-fast sweep (Task 3).

### Task 2 — ReportGenerationJob (README §2)

- **Two layers of "aggregation."** The `ReportGenerationJob` produces a report-shaped output as its `Result.data` (matching the README example: `{ workflowId, tasks[], finalReport }`). The framework also synthesizes a uniform `finalResult` from every task's output (see Task 4). Slight redundancy, but each satisfies a distinct README task.
- **Report job under fail-fast.** Under the workflow-aborts-on-first-failure semantic (Task 3), `ReportGenerationJob` only ever runs in fully-successful workflows. README §2's *"include error information for failed tasks"* requirement is therefore satisfied via `finalResult` (framework-owned), which always carries `{ status, error }` for failed tasks.
  - *Production-grade:* continue-on-error semantics with per-step `continueOnError: true` annotations would let the report job run with failed-dep envelopes and surface them in its output. The dep-envelope would then carry `status` + `error` (the shape we explicitly removed under fail-fast — see Task 3).

### Task 3 — Interdependent Tasks (README §3)

- **`Task.dependsOn` storage.** Stored as a `simple-json` array of UUIDs, resolved from YAML `stepNumber`s by `WorkflowFactory` in a **single-pass, transactional save**: UUIDs are minted app-side (`uuid` v4), the `stepNumber → taskId` map is built in memory, `dependsOn` is resolved before any insert, and `Workflow` + all `Task` rows are persisted atomically inside `dataSource.transaction(...)`. Single indexed query for readiness checks. An earlier draft specified a two-pass save (insert-then-update to discover DB-assigned IDs); that was vestigial "let the DB assign IDs" thinking — UUID v4 is decentralized by design, so minting locally and writing once is strictly simpler. Wrapping workflow + tasks in one transaction preserves the *"either fully created (202) or rejected (4xx) — never partial"* invariant that `/status` and `/results` callers assume the moment they see a 202.
  - *Production-grade:* a normalized `task_dependencies` join table with FK constraints, indexed for graph traversal; supports queries like *"all transitive descendants of task X."*
- **YAML format.** `dependsOn` is always an array of step numbers (no scalar shorthand); omit entirely for no deps. Validation at workflow-creation time rejects missing-step refs (`INVALID_DEPENDENCY`), cycles and self-deps (`DEPENDENCY_CYCLE`), and multiple steps with the same `stepNumber` or unknown `taskType` (`INVALID_WORKFLOW_FILE`).
- **Fail-fast on any task failure (CI-pipeline semantics).** When any task transitions to `failed`, the runner sweeps every `waiting`/`queued` sibling to `skipped` in the same post-task transaction; the workflow itself transitions to `failed`. In-progress tasks **run to completion** — jobs are async functions on a shared event loop with no cancellation interface, so hard-cancellation is not pragmatic for this scope.
  - *Production-grade:* per-task `continueOnError`, true cooperative cancellation via cancel tokens (or process-level kill for forked job containers), partial-success reports, branch-level halt instead of workflow-level halt.
- **`JobContext` shape — uniform.** `Job.run({ task, dependencies: [{ stepNumber, taskType, taskId, output }] })`. No `status`/`error` on envelopes — under fail-fast a job only runs when every dep is `completed`.
  - *Production-grade:* per-job typed input schemas (Zod / io-ts) with a runner-side decoder layer for compile-time-checked job inputs.

### Task 4 — Final Workflow Results (README §4)

- **Framework-owned `finalResult` shape.** Synthesized by the runner on terminal transition from every task's output:
  ```json
  {
    "workflowId": "<uuid>",
    "failedAtStep": <stepNumber>,
    "tasks": [{ "stepNumber", "taskType", "status", "output"?, "error"? }]
  }
  ```
  `failedAtStep` is the lowest `stepNumber` among `failed` tasks; omitted on success. Each task entry has exactly one of `output` (when `completed`), `error` (when `failed`), or neither (when `skipped`). `error.stack` is stripped at write time so it never leaves the runner.
- **Eager write + lazy patch.** Eager write inside the post-task transaction that takes the workflow terminal, guarded by `WHERE finalResult IS NULL`. If a terminal workflow somehow has `finalResult IS NULL` when `/results` is hit (rare race or crash), the read handler computes and persists it on the fly under the same idempotent guard. The query handler never advances workflow lifecycle — it only fills content.
  - *Production-grade:* emit a domain event (`workflow.finalized`) when `finalResult` is written; downstream consumers (notification service, BI ETL) subscribe instead of polling.

### Task 5 — `/workflow/:id/status` (README §5)

- **Lightweight payload.** Workflow status + per-task list keyed by `stepNumber`. No payloads (`output`, full error messages); `/status` is for progress tracking, not data retrieval. `failureReason` appears only on `failed` tasks (only value: `job_error`); skipped tasks need no reason — the status itself is the explanation.
  - *Production-grade:* SSE or WebSocket push for real-time progress updates; ETag caching on the GET; per-step duration timestamps.

### Task 6 — `/workflow/:id/results` (README §6)

- **Lenient terminal policy.** `200` for any terminal workflow (`completed` or `failed`); `400` only for non-terminal; `404` for missing. Diverges from a strict reading of the README (which says *"if not completed, 400"*) because under fail-fast `finalResult` carries meaningful failure info — including `failedAtStep` and per-task errors — and shouldn't be hidden behind a `400`.
- **No list endpoint.** `GET /workflow` is out of scope; reviewers have workflow IDs from their `POST /analysis` responses.
  - *Production-grade:* paginated `GET /workflows?status=…&clientId=…` with filtering and date ranges.
- **`POST /analysis` body shape.** Preserved at `202 Accepted` (correct semantic — the workflow is queued, not done). Body is `{ "workflowId": "<uuid>" }`; the legacy `message` field is dropped.
