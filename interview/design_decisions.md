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
- **ESLint rule lock-in.** TypeScript-ESLint flat config (ESLint 9). Rules organized by intent. Locked thresholds — values chosen on the principle that hitting a limit is a refactor signal, not an annoyance. If a rule fires more than twice in Tasks 0–1 we revisit; pre-relaxing buys optionality we may not need.

  **Type safety:**
  - `@typescript-eslint/no-explicit-any`: `error`, `{ ignoreRestArgs: true }` — forces `unknown` + narrowing; `ignoreRestArgs` permits the logger's `(...args: any[])` forwarding.
  - `@typescript-eslint/explicit-module-boundary-types`: `error` — return types on exported functions only; lighter than `explicit-function-return-type`.
  - `@typescript-eslint/no-non-null-assertion`: `warn` — `!` is sometimes legitimate after explicit existence checks; warn keeps it deliberate.
  - `@typescript-eslint/no-unused-vars`: `error`, `{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }`.
  - `@typescript-eslint/consistent-type-imports`: `error`, `{ prefer: "type-imports" }`.

  **Async correctness (the agent's biggest risk area — these are non-negotiable):**
  - `@typescript-eslint/no-floating-promises`: `error` — catches `repository.save(task)` without `await` in the worker loop.
  - `@typescript-eslint/no-misused-promises`: `error`, `{ checksVoidReturn: { arguments: false } }` — carve-out lets async functions be passed as Express middleware.
  - `@typescript-eslint/await-thenable`: `error`.
  - `@typescript-eslint/return-await`: `["error", "in-try-catch"]`.
  - `@typescript-eslint/require-await`: `off` — too noisy; async-without-await is legitimate (e.g. uniform job signatures).

  **Complexity caps (locked):**
  - `complexity`: `["error", 10]` — McCabe default. Most likely flashpoint is `JobFactory.create(taskType)` and the runner's post-task transition logic; if it bites we extract, not relax.
  - `max-lines-per-function`: `["error", { max: 80, skipBlankLines: true, skipComments: true }]` — code-only count; fits a runner method that does txn-open + claim + dispatch + result-write + sweep + txn-commit comfortably.
  - `max-lines`: `["error", { max: 350, skipBlankLines: true, skipComments: true }]`.
  - `max-depth`: `["error", 4]`.
  - `max-params`: `["error", 4]` — 5+ params → take a typed object (the `JobContext` pattern).
  - `max-nested-callbacks`: `["error", 3]`.

  **Code style:**
  - `eqeqeq`: `["error", "smart"]` — `===` always except `== null` for combined null/undefined check.
  - `no-var`: `error`.
  - `prefer-const`: `error`.
  - `no-console`: `["error", { allow: ["warn", "error"] }]` — production logs go through the JSON-line wrapper.
  - `no-throw-literal`: `error` — preserves stack traces.

  **Test file overrides** (`tests/**`, `**/*.test.ts`, `**/*.spec.ts`):
  - All complexity caps off (`complexity`, `max-lines-per-function`, `max-lines`, `max-depth`, `max-params`, `max-nested-callbacks`) — `describe` blocks legitimately get long.
  - `@typescript-eslint/no-explicit-any`: `off` — fixtures use deliberately loose types.
  - `@typescript-eslint/no-non-null-assertion`: `off` — `result!.field` after a null-check assertion is idiomatic test-code.
  - `@typescript-eslint/explicit-module-boundary-types`: `off`.
  - `no-console`: `off`.

  **Config / script file overrides** (`*.config.ts`, `*.config.mjs`, `vitest.config.ts`):
  - `@typescript-eslint/explicit-module-boundary-types`: `off`.
  - `no-console`: `off`.

  **TypeScript-ESLint needs a wider tsconfig.** The repo's `tsconfig.json` has `"include": ["src"]` and `"rootDir": "./src"`, so the linter cannot type-check `tests/**` without help. Task 0 adds a `tsconfig.eslint.json` that extends `tsconfig.json`, drops `rootDir`, and includes `["src", "tests", "*.config.ts"]`. The pre-commit `tsc --noEmit` invocation points at that file; the production `tsc` build keeps using `tsconfig.json`.

  **Deliberately not added** (and why):
  - `eslint-plugin-import`: agent's import sins are unused-only, already covered by `no-unused-vars`. The plugin's perf cost isn't earned.
  - `prefer-readonly` on class properties: TypeORM entity classes use mutable properties; the rule would either force `// eslint-disable` on every entity field or be globally disabled.
  - Custom rule prohibiting direct `Repository.save()` outside the runner's transaction helper: writing a custom rule for one repo is overkill; the integration tests around the claim race + code review are cheaper enforcement.

  *Production-grade:* same baseline plus `eslint-plugin-import` for boundary/cycle enforcement, `eslint-plugin-security` for crypto/regex/eval lints, the custom `Repository.save` rule above, and `eslint-plugin-sonarjs` for cognitive-complexity checks that complement raw McCabe.

- **Legacy `src/**` files are grandfathered into the lint config.** The 14 TypeScript files present at the initial commit (`src/index.ts`, `src/data-source.ts`, `src/jobs/*.ts`, `src/models/*.ts`, `src/routes/*.ts`, `src/workers/*.ts`, `src/workflows/WorkflowFactory.ts`) collectively trigger ~30 errors against the locked rule set (mostly `consistent-type-imports`, `no-console`, `no-unsafe-*`, `no-explicit-any`, and one real `no-floating-promises` in `src/index.ts`). The Task 0 scope explicitly forbids changes to existing `src/**` code, so the legacy files are listed in `eslint.config.js`'s top-level `ignores`. New files added under `src/**` (including the deliberate-error verification file `src/_bad.ts`) are linted normally. As Task 1+ touches each legacy file it will be removed from the ignore list and brought into compliance — the lint debt is intentional, scoped, and visible.
  - *Production-grade:* a one-shot cleanup PR brings every legacy file to compliance up front; no grandfather list ships to `main`.
- **Vitest pinned to `^2`.** Vitest 4.x's bundled type declarations require `moduleResolution: "bundler"` / `node16` / `nodenext`. The repo's `tsconfig.json` uses `moduleResolution: "node"` (the older form), and changing it is out of scope for Task 0 (it would ripple into `ts-node`/runtime resolution behavior). Vitest 2.x ships type declarations that resolve cleanly under `moduleResolution: "node"` with `skipLibCheck: true`. `tsconfig.eslint.json` adds `skipLibCheck: true` and `types: ["node"]` to keep the `tsc --noEmit` gate fast and quiet on third-party `.d.ts` noise.
  - *Production-grade:* migrate the project tsconfig to `moduleResolution: "bundler"` (or `nodenext`) and use the latest Vitest; the `skipLibCheck` carve-out goes away.
- **`eslint.config.js` uses CommonJS (`require`/`module.exports`).** The repo is a CJS project (no `"type": "module"` in `package.json`). Keeping the config in `.js` (per the issue's file list) requires CJS syntax. The `disable-type-checked` overlay plus a small CJS globals block keeps the config self-linting without needing `eslint-plugin-n` or `globals`.
  - *Production-grade:* once the project migrates to ESM, switch to `eslint.config.mjs` with the documented ESM form.

### Task 1 — PolygonAreaJob (README §1)

- **Output storage.** Task output lives in the existing `Result.data` column rather than a new `Task.output` column. The README phrase *"save the result in the output field of the task"* is interpreted as the *logical* output (Task → Result via `resultId`). Full prepared defense — README internal-consistency argument, four-layer rebuttal, when-to-cave conditions — in [`no-task-output-column.md`](./no-task-output-column.md). Rationale:
  1. **Separation of concerns** — `tasks` is the hot, polled table; outputs can be large JSON blobs and don't belong on every poll.
  2. **Future-proof for retries / multiple attempts** — a production extension can record one `Result` per attempt without touching the task row.
  3. **Storage flexibility** — `Result` rows could later move to object storage keyed by `resultId` while `Task` stays in OLTP.
  4. **Lifecycle clarity** — terminal tasks may have no `Result` (e.g. `skipped`); the absence of `resultId` is meaningful.
  - *Production-grade:* same shape; the choice would be the same.
- **Invalid-GeoJSON handling.** `@turf/area` does not throw for malformed inputs — it returns `0` for a degenerate ring and `0` for a `Point`. `PolygonAreaJob` therefore validates structure itself: `JSON.parse` is wrapped to throw `Invalid GeoJSON: failed to parse: …` (with `cause` attached), and a type guard rejects anything that isn't a `Polygon` or `Feature<Polygon>`. A degenerate (collinear) ring is allowed through and returns `0` — the behavior is locked with a unit test so a future `@turf` change is caught. The runner's `catch` branch persists `Result.error = { message, reason: 'job_error', stack }` (stack truncated to ≤10 lines via `split('\n').slice(0, 10).join('\n')`), sets `Task.resultId`, and marks the task `failed`. Worker isolation (US2/US20) — a single failed task must not stop the loop — is asserted by the integration test that drains a fixture with one failing and one passing `polygonArea` step.
- **Test harness — SWC transformer (`unplugin-swc` + `@swc/core`).** Vitest's default esbuild transform does not emit `Reflect.metadata("design:type", …)` for TypeORM's bare `@Column()` — entities fail at `DataSource.initialize` time with `ColumnTypeUndefinedError`. SWC does emit metadata. Adding `unplugin-swc` (test-side only, devDependencies) is the canonical workaround used by the Nest/TypeORM communities. Production paths still use `ts-node` (which emits metadata via TypeScript's emitter) and are unaffected. Documented here as a Task 0 follow-up — the harness gap was not surfaced until Task 1 needed real entities under Vitest.
  - *Production-grade:* migrate the project tsconfig to `moduleResolution: "bundler"` and adopt Vitest 4.x (which can drive a single transformer for both runtime and test); or move to `tsx`/`ts-node` test runners that share TypeScript's metadata emitter end-to-end.
- **Explicit `type: 'varchar'` on string-enum status columns.** `Task.status` (`TaskStatus`) and `Workflow.status` (`WorkflowStatus`) are bare `@Column()`s. `tsc` emits `String` as their `design:type` metadata, but SWC emits the enum object itself, which TypeORM cannot map. Adding an explicit `type: 'varchar'` lets TypeORM bypass metadata reflection for these two fields while leaving SQLite's loose type affinity unchanged at runtime. Scoped to the minimal fix needed for the test harness; no schema migration involved (`synchronize: true` regenerates the DB on every boot).
  - *Production-grade:* if/when migrations exist, prefer `enum` columns with the database's enum type (Postgres) or a typed lookup table; the explicit `varchar` would go away.
- **Result.data made nullable.** The original `@Column('text')` for `Result.data` was NOT NULL even though the TS type already declared `string | null`. The Task 1 sad-path now writes `data = null` alongside a populated `Result.error`, so the column constraint is relaxed to match the type. Existing happy-path code that always writes a JSON string is unaffected.
- **`lint-staged` uses `--no-warn-ignored`.** Task 1 is the first task to stage a legacy-grandfathered file (`src/jobs/JobFactory.ts`, `src/workers/taskRunner.ts`); without the flag, ESLint emits a warning per ignored file and `--max-warnings=0` aborts the commit. `--no-warn-ignored` makes lint-staged a no-op on intentionally ignored files while leaving the full-tree `npm run lint` unaffected. Cleanup follows the Task 0 schedule — each legacy file is brought into compliance and removed from the ignore list as later tasks touch it; this task explicitly preserves `taskRunner.ts`'s `console.log` debt per its scope (Task 11 owns the structured-logger swap).

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


### Task 3b-ii Wave 1 — Lifecycle refactor + initial → in_progress claim bump (PRD §Decisions 8, 9, 10)

- **Lifecycle helper re-reads the full task list on every terminal transition.** `evaluateWorkflowLifecycle` issues a `findOne({ where: { workflowId }, relations: ['tasks'] })` and walks the array to compute `allTerminal` / `anyFailed`. Cheaper than a per-status `COUNT(*)`-style query at this scale, and the entire computation runs inside the post-task transaction so the freshly-saved status of the just-terminated task is visible.
  - *Production-grade:* a single aggregate query (`SELECT status, COUNT(*) ... GROUP BY status`) bounded by an index on `(workflowId, status)`; cheaper at scale and avoids materialising the full task collection. Equivalent semantics either way.
- **Lifecycle helper does NOT issue the `initial → in_progress` bump.** That bump is the **claim transaction's** job (PRD §Decision 9). Splitting the responsibilities keeps each transaction focused: the claim guarantees the workflow reflects "at least one task started" the instant a worker takes a task, even if the job itself is slow; the post-task helper only handles terminal transitions.
- **`console.log` calls in `TaskRunner.executeJob` retained with inline `eslint-disable-next-line no-console` + TODO referencing PRD §Decision 11.** PRD §Decision 11 specifies a structured JSON-line logger; building it is out of scope for Wave 1 (and would balloon this commit beyond its narrow lifecycle/claim mandate). The disables are scoped to the two operational lines so the operator-visible markers documented in the §Task 1 / §Task 3b-i manual test plans keep working until the logger lands.
  - *Production-grade:* swap for the in-house JSON-line wrapper (or `pino`) at the same call sites; the `eslint-disable` lines disappear with it.
- **Wave 1 lifecycle is intentionally incomplete without promotion + sweep.** With no `waiting → queued` promotion (Wave 2) and no fail-fast sweep (Wave 3), a workflow whose first task is `polygonArea` followed by a dependent step will sit at `in_progress` forever — step 2 never leaves `waiting`. Documented in the Wave 1 manual test plan under "scope note." Each wave is a single-commit, single-PR slice; the partial state between waves is observable by design and disappears once Waves 2 and 3 land.

### Task 3b-ii Wave 2 — Readiness promotion + dependency envelope (PRD §Decisions 5, 7, 9)

- **Promotion fires only on `Completed` task transitions.** `Failed` and `Skipped` deliberately do NOT trigger promotion (PRD §Decision 9 — fail-fast halt is Wave 3's sweep, not promotion's responsibility). The runner gates `promoteReadyTasks(...)` on `outcome.status === Completed` so a failure leaves dependent waiters untouched until the sweep flips them to `skipped`.
  - *Production-grade:* same — promotion semantics are universal under fail-fast.
- **Single workflow+tasks read shared between promotion and lifecycle eval.** The post-task transaction does one `findOne({ where: { workflowId }, relations: ['tasks'] })` (via the new `loadWorkflowWithTasks(...)` helper) and reuses that snapshot for both `promoteReadyTasks(...)` and `evaluateWorkflowLifecycle(...)`. Promotion only mutates `waiting → queued` — neither status is terminal — so the snapshot's `allTerminal` / `anyFailed` computation is unaffected by promotion writes that happen between the read and the lifecycle call. Avoids an N+1 read per terminal transition.
  - *Production-grade:* a single aggregate query (`SELECT status, COUNT(*) ... GROUP BY status`) plus a separate batched promotion `UPDATE` keyed off the dep-completion sub-select; promotion + lifecycle stop materialising the task collection at all.
- **Envelope sort key — `stepNumber` ascending.** The envelope is sorted by `stepNumber` ASC (deterministic, user-facing identifier per PRD §Decision 4). `dependsOn` order is an implementation artifact (insertion order from YAML); sorting by `stepNumber` matches the order callers see in `/status` and `finalResult`, removing one source of "why is dep[0] not what I expected?" friction.
  - *Production-grade:* same — `stepNumber` is the documented public identifier.
- **Missing-upstream-Result guard throws a descriptive `Error`.** Defence-in-depth: under correct operation promotion only fires after the parent's terminal transaction has committed Result + Task.status together, so a missing Result row in `buildDependencyEnvelope(...)` indicates a malformed state (corrupted DB, manual SQL surgery, future bug). The thrown error includes both `taskId` and `stepNumber` of the offending upstream so the operator has enough context to debug. The throw flows through `executeJob`'s normal try/catch — the dependent task is persisted as `Failed` with the standard `Result.error` shape.
  - *Production-grade:* same throw-then-Failed contract; an additional structured-log `error` event would carry the upstream metadata for observability pipelines.
- **Builder location — kept as a private method on `TaskRunner` (no standalone file).** The builder is short (≈25 lines), reads via the runner's existing `taskRepository.manager`, and is exercised end-to-end by spy jobs in both unit and integration tests; extracting to `src/workers/dependencyEnvelope.ts` would buy nothing for testing (no extra mock surface needed) and would split a small piece of behaviour across two files for no gain.
  - *Production-grade:* if the builder grows past ~50 lines or sprouts caching / prefetching, extract it then; until then inline keeps the runner's transaction structure readable top-to-bottom.
- **Helpers smoke test (`tests/03-interdependent-tasks/helpers/helpers.unit.test.ts`) updated to reflect post-Wave-2 reality.** The Wave 1 assertion ("ranCount=1, dependents stay waiting") asserted the absence of promotion. With Wave 2 in place that assertion is no longer valid; the test now registers all three task types and asserts the helpers drive the full chain to `completed` (`ranCount=3`). Scope-wise: the file lives in `tests/03-interdependent-tasks/helpers/` and is a smoke test for the helpers themselves, not the README §3 requirement-fulfilling test in `tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts` (which Wave 2 leaves untouched).
  - *Production-grade:* same — helper smoke tests track the helpers' actual behaviour against the current system.
