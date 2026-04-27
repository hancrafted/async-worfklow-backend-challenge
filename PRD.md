# Async Workflow Backend Challenge — PRD

## Problem Statement

A platform consumer who submits an analysis workflow today gets a single, linear pipeline of independent tasks with no way to express step-to-step dependencies, no aggregated report, no persisted final result, and no HTTP visibility into progress or outputs. Real workflows need branching/joining steps (e.g. polygon-area feeding into a report), a way to know whether a workflow is done, and a way to retrieve its result without tailing logs.

## Solution

Extend the backend so workflows can declare task dependencies in YAML, run dependency-aware via an in-process worker pool, and produce a denormalized final result written once at terminal transition. Add a polygon-area job, an aggregator-style report job, and two HTTP endpoints (`GET /workflow/:id/status` and `GET /workflow/:id/results`) so consumers can monitor progress and retrieve outputs without ever reading the database directly.

## User Stories

1. As a platform consumer, I want a polygon-area job, so that my workflows can compute polygon area in square meters from the GeoJSON I submitted.
2. As a platform consumer, I want the polygon-area job to fail gracefully on invalid GeoJSON, so that one bad input does not crash the worker or hang the workflow.
3. As a platform consumer, I want a report-generation job, so that a workflow can produce a single aggregated JSON report summarizing every task's output.
4. As a report consumer, I want failed upstream tasks to appear in the report with their error info, so that I can diagnose partial failures from the report alone.
5. As a workflow author, I want to declare task dependencies in YAML using `dependsOn: [stepNumber, ...]`, so that I can express multi-step pipelines with branching and joining.
6. As a workflow author, I want a task to depend on multiple upstream tasks (many-to-one), so that aggregator-style steps can wait for several producers.
7. As a workflow author, I want `dependsOn` to always be an array (never a scalar) and to be omitted entirely when a task has no dependencies, so that the YAML format is unambiguous.
8. As a workflow author, I want invalid dependencies (referencing a non-existent step, or forming a cycle) to be rejected at workflow-creation time with a clear error code, so that I learn about mistakes immediately rather than at runtime.
9. As an operator, I want dependent non-aggregator tasks to be skipped (marked failed with reason `dependency_failed`) when any upstream dep failed, so that doomed branches do not waste work.
10. As a report-job author, I want my aggregator to still run when some upstream tasks failed, so that I can produce a report describing exactly what failed and what succeeded.
11. As an operator, I want a `GET /workflow/:id/status` endpoint that returns workflow status plus a per-task list keyed by `stepNumber`, so that I can monitor progress without database access.
12. As an operator, I want the status endpoint to include each task's `dependsOn` (as step numbers) and a `failureReason` field on failed tasks, so that I can see at a glance why a task did not produce output.
13. As an operator, I want a `GET /workflow/:id/results` endpoint that returns the workflow's `finalResult` for any terminal workflow (completed or failed), so that I can retrieve a successful aggregator's report even when some upstream tasks failed.
14. As an operator, I want `/results` to return `400` when the workflow is still in progress and `404` when it does not exist, so that the response codes have unambiguous meaning.
15. As an operator, I want a workflow's `finalResult` to be the aggregator's output verbatim, so that the shape of the result is fully owned by the report job and not mangled by framework code.
16. As an operator, I want workflows that have no aggregator step to leave `finalResult` as `null`, so that the absence of an aggregator is observable rather than papered over.
17. As an operator, I want internal task UUIDs never to appear in API responses or report payloads, so that the public contract speaks only in `stepNumber`s.
18. As a platform operator, I want the worker to handle multiple concurrent tasks via a configurable in-process pool, so that independent ready tasks are not serialized behind each other.
19. As a platform operator, I want concurrent workers to claim tasks atomically, so that two workers never run the same task and post-task workflow updates do not race.
20. As a platform operator, I want unified API error responses of the shape `{ error: CODE, message }` across all endpoints (new and existing), so that callers can handle errors consistently.
21. As a developer, I want job exceptions to be caught per-worker and persisted on `Result.error`, so that one bad job never crashes its worker or leaks across siblings.
22. As a developer, I want runner-level exceptions (DB errors, framework bugs) to be caught by the worker loop and treated as transient, so that the worker can never die from an uncaught exception.
23. As a developer, I want structured JSON-line logs with workflow/task identifiers, so that I can grep or pipe through `jq` operationally without adding a logging dependency.
24. As a developer, I want stack traces stored on `Result.error` for debugging but stripped before they reach API responses or aggregator inputs, so that internals do not leak into externally-visible payloads.
25. As a developer, I want to start the system with a clean SQLite database on every restart (no migrations, no drain), so that the challenge harness stays simple and reproducible.

## Implementation Decisions

The 13 sub-decisions below are the locked design from the workspace spec. The spec note remains the canonical source of truth; if anything in this section drifts from the spec, the spec wins.

### 1. Task dependencies are many-to-one

A task can depend on multiple prior tasks. Once **all** declared dependencies are in a terminal state (`completed` or `failed`), the dependent task becomes eligible to run. Dependency outputs are passed to the task as inputs.

- **Storage (pragmatic):** the `Task` entity gains a `dependsOn` JSON-array column holding the dependency taskIds.
- **YAML format:** `dependsOn` is **always an array** of step numbers (e.g. `dependsOn: [1, 2]`). Single-value scalars are not supported; omit the field entirely to mean "no dependencies."
- **Production-grade alternative (out of scope):** a normalized `task_dependencies` join table with FK constraints, indexed for graph traversal. To be captured in `interview/design_decisions.md`.

### 2. Failed-dependency policy

- **Default (non-aggregator tasks):** if any declared dependency ends in `failed`, the dependent task is **skipped** — marked `failed` with reason `dependency_failed` and references to the failed dependency taskIds, and never executed.
- **Aggregator exception:** jobs flagged as aggregators (e.g. the report-generation job) **always run** once all dependencies are terminal, even if some failed. They receive each dependency's status and output (or error) as input and are responsible for surfacing failure info in their output.
- **Mechanism:** aggregator behavior is a property of the Job (e.g. an `isAggregator` flag on the Job interface). The runner consults this flag when deciding skip-vs-run on a failed dep.

### 3. Eager dependency resolution

`Task.dependsOn` stores **taskIds** (UUIDs), resolved from YAML `stepNumber`s once when the workflow is created.

- **WorkflowFactory** does a two-pass save: first create all tasks with empty deps to capture the `stepNumber → taskId` map, then resolve each task's `dependsOn` step numbers to taskIds and save again.
- **Validation at creation time** (returns `400` to the API caller if violated):
  - Every referenced `stepNumber` must exist in the workflow → `{ error: "INVALID_DEPENDENCY", message: "Step N references non-existent step M" }`
  - The dependency graph must be a DAG (no cycles, no self-deps) → `{ error: "DEPENDENCY_CYCLE", message: "Cycle detected: 2 → 3 → 2" }`
- **Cross-workflow dependencies are forbidden** — this falls out for free because YAML only knows step numbers within its own workflow.
- **Runner readiness check** collapses to a single indexed query: "are all tasks with id ∈ `task.dependsOn` in a terminal state?"

### 4. `stepNumber` is the user-facing identifier

UUIDs are an internal detail. Anywhere a workflow's task structure is exposed to an API caller — status response, results response, aggregator-built report payload — tasks are identified by their `stepNumber` (with `taskType` included for readability). The internal `taskId` is never surfaced.

### 5. `JobContext` shape with a uniform dependency envelope

`Job.run` receives a single `JobContext` object containing the executing task and an array of dependency-result envelopes (one per declared dep, empty when the task has no deps). Each envelope carries the dependency's `stepNumber`, `taskType`, terminal `status`, the upstream `output` (null on failure), and an optional `error` object (`{ message, reason? }`, present only on failure). The internal `taskId` is included on the envelope for logs and tests but never surfaced to API callers.

- **Signature change:** the previous `Job.run(task)` becomes `Job.run(context)`. Existing starter jobs are migrated to the new signature and ignore the `dependencies` array.
- **Workflow input** (the original `geoJson` payload) stays on the task itself — accessible via the task on the context. The `dependencies` array carries upstream outputs only.
- **Uniform shape:** aggregators receive entries with `status: 'failed'` for any failed deps; non-aggregators never run when a dep failed (they are skipped per the failed-dependency policy), so for them every entry is `status: 'completed'`. The envelope shape is identical either way, so aggregators and non-aggregators iterate without conditionals.
- **Production-grade alternative (out of scope):** per-job typed input schemas (Zod / io-ts) with a runner-side decoder layer. To be captured in `interview/design_decisions.md`.

### 6. `Result` entity stays canonical (no `Task.output` column)

The existing `Result` entity remains the single source of truth for task outputs; we do **not** add a `Task.output` column. `Task.resultId` continues to link a task to its (at most one) `Result` row.

- **Reasoning** (to be expanded in `interview/design_decisions.md` with reference to PRD task #1):
    1. **Separation of concerns** — the tasks table is the hot, polled table; outputs can be large JSON blobs and keeping them out of the polled table avoids row-size bloat.
    2. **Future-proof for retries / multiple attempts** — a production-grade extension can record one `Result` per attempt without changing the task row.
    3. **Storage flexibility** — `Result` rows could later move to object storage keyed by `resultId` while `Task` stays in OLTP. The `Task → Result` interface is stable.
    4. **Reviewer optics** — the starter scaffolding deliberately separates these concerns; we respect that boundary rather than collapse it.
    5. **Lifecycle clarity** — a task can be in a terminal state with no `Result` (e.g. dependency-skipped failures); absence of a `resultId` is a meaningful signal.
- **PRD wording reconciliation:** Readme task #1 says "save the result in the output field of the task." We interpret "the task's output" as the **logical output** (i.e. the task's linkage to `Result.data` via `resultId`), not a literal `output` column on `Task`. This deviation from a literal reading is documented in `interview/design_decisions.md` against PRD task #1.

### 7. `Result` shape — separate `data` and `error` columns

The `Result` entity carries both columns so that success vs failure is structurally unambiguous and so that aggregators can read upstream errors directly.

- `Result.data` (nullable JSON-stringified) holds the successful output. Populated when the producing task is `completed`.
- `Result.error` (nullable JSON-stringified `{ message, reason? }`) holds the failure record. Populated when the producing task is `failed` and the runner caught a real error — **not** for tasks skipped via `dependency_failed`, which fail without producing a `Result` because there is no original error to record.
- Exactly one of (`data`, `error`) is non-null on any saved `Result`.
- The dep-envelope builder reads the `Result` row (one extra query per dep, or a single batched query) and maps to the envelope shape:
  - `completed` task with `Result` → `{ status: 'completed', output: parsed-data, error: undefined }`
  - `failed` task with `Result` (real error) → `{ status: 'failed', output: null, error: parsed-error }`
  - `failed` task with **no** `Result` (skipped via `dependency_failed`) → `{ status: 'failed', output: null, error: { message: 'Dependency failed', reason: 'dependency_failed' } }` synthesized by the runner.

### 8. Workflow lifecycle, `finalResult`, and status enum

- `Workflow.finalResult` (nullable JSON) is a denormalized snapshot, written **once** when the workflow transitions to a terminal state. Workflows are immutable once terminal, so freshness is not a concern.
- `finalResult`** is the aggregator's output verbatim.** When the workflow contains a job flagged as an aggregator, the runner copies that task's output into `finalResult` once the aggregator completes. The runner does **not** synthesize an alternative shape — the report job fully owns the shape.
- **No-aggregator case:** `finalResult` stays `null`. The starter's `example_workflow.yml` (analysis + notification, no report) is exactly this case and stays valid.
- **Aggregator step pattern.** The aggregator is just a normal task with `isAggregator: true` on its job and `dependsOn: [<all preceding step numbers>]` in YAML. There is no special "terminal step" concept — the existing dependency model handles ordering.
- **Aggregation trigger** is the existing terminal-transition block in the runner: after every task finishes, the runner re-evaluates the workflow; if every task is now in a terminal state and an aggregator task ran successfully, the runner copies the aggregator's output to `finalResult`.
- **Workflow status enum (four-state):**
  - `initial` — created, no task has started.
  - `in_progress` — at least one task started, not all terminal.
  - `completed` — every task in the workflow ended in `completed`.
  - `failed` — at least one task ended in `failed` (this includes dependency-skipped failures and aggregators whose own dep failed). The workflow may still have a meaningful `finalResult` from a successful aggregator that ran over partially-failed upstream tasks.
- **Naming consequence:** in workflows that include an aggregator, an upstream failure → workflow status `failed` even though the aggregator ran and produced a report. Status reflects "did all tasks succeed?"; `finalResult` still carries the aggregator's report describing what failed. Documented in `interview/design_decisions.md` so the reviewer sees this is intentional.

### 9. Task readiness — `waiting → queued → in_progress → terminal`

The starter's `queued` semantic ("in the worker's pickup queue") is preserved. A new `waiting` status represents tasks blocked on dependencies. The worker's pickup query is unchanged.

- `TaskStatus`** enum:**
  - `waiting` — created, has dependencies that are not all terminal yet. **Not** picked up by the worker.
  - `queued` — eligible to run; in the worker's pickup queue.
  - `in_progress` — claimed by a worker, executing.
  - `completed` — terminal, success.
  - `failed` — terminal, failure (real error or `dependency_failed` skip).
- `WorkflowFactory`** insertion rule:** tasks with no deps are inserted as `queued`; tasks with declared deps are inserted as `waiting`. No redundant first-tick promotion needed.
- **Promotion / skip after each terminal transition:** the runner scans `waiting` siblings in the same workflow whose deps are now all terminal. For each:
  - If the sibling's job is **non-aggregator** and any dep ended in `failed` → set sibling to `failed` with `{ reason: 'dependency_failed', failedDeps: [...] }` recorded in its `Result.error`.
  - Otherwise → set sibling to `queued`.
- **Aggregator-triggering and **`finalResult`** promotion** happen in the same post-task block.

### 10. Concurrency — in-process worker pool

The system runs a configurable pool of N concurrent workers within the same Node process (default `N=3`, override via `WORKER_POOL_SIZE` env var). All workers share a single `AppDataSource`. Workers are coroutines on the same event loop, not OS threads — appropriate for the DB-bound + light-CPU workload here.

- **Per-worker loop:** atomically claim the next `queued` task → run it → loop immediately. Sleep 5 seconds only when no `queued` task is available.
- **Atomic claim:** the runner claims a `queued` task in a single short transaction (find → update status to `in_progress` → commit). SQLite's write-lock semantics serialize the claim transaction across workers, ensuring at most one worker claims any given task. Job execution itself runs concurrently outside the transaction.
- **Post-task workflow update is transactional and idempotent.** Two workers finishing two tasks of the same workflow concurrently must not race on the workflow-status reevaluation, sibling promotion, or `finalResult` write. The post-task block runs in a transaction; the `finalResult` write is guarded by a `WHERE status NOT IN terminal_set` so only the first-arriving worker writes it.
- **Sibling promotion is naturally idempotent** (UPDATE WHERE `status='waiting'` AND deps-all-terminal → at-most-one-effective).
- **Production-grade extension (out of scope):** horizontal scaling via multiple OS processes / containers; would require either a DB-level advisory lock for cross-process claim or moving claim to a real queue (Redis, SQS). To be captured in `interview/design_decisions.md`.

### 11. Worker error handling and structured logging

**Job exceptions** (inside `Job.run`) are caught by the worker, persisted on `Result.error`, logged, and never propagate — the worker continues claiming the next task.

- **Persisted shape on **`Result.error`**:** `{ message, reason: 'job_error', stack }` where `stack` is the first 10 lines of the original stack trace, retained for debugging.
- **API response shaping:** the `/results` endpoint and aggregator-built reports **strip **`stack` before returning. Callers see only `{ message, reason }`. The aggregator's dependency-envelope `error` also excludes `stack` to avoid leaking internals into report output.
- **Per-worker isolation:** every job invocation lives inside its own try/catch. A job exception → mark the task `failed` → emit error log → continue. A bad job can never crash its worker, and one worker's failures never affect siblings.

**Structured logging** is provided by a small in-house logger wrapper around `console.log` / `console.error` that emits **JSON-line** logs to stdout. No new dependencies.

- **Shape:** `{ level, ts, workflowId?, taskId?, stepNumber?, taskType?, msg, error? }`. Always JSON, always one line, regardless of `NODE_ENV` (no pretty-printing branch — `jq` is the dev-mode pretty-printer).
- **Levels used:**
  - `info` — task start/finish, workflow lifecycle transitions, worker start/stop.
  - `warn` — `dependency_failed` skips, no-op claim attempts when the queue is empty.
  - `error` — job exceptions, runner-level exceptions (see below), unexpected state.
- **Production-grade alternative (out of scope):** swap the wrapper for `pino` for zero-cost structured logging, log routing, and request correlation IDs. To be captured in `interview/design_decisions.md`.

**Runner-level exceptions** (DB error during claim or post-task transaction, framework bugs) are **caught by the worker loop and treated as transient** — log at `error`, sleep one tick (5 seconds), retry.

- **Loop-of-last-resort:** the per-worker loop body itself is wrapped in try/catch. Even if the inner `runJob` try/catch leaks (it should not), the loop catches, logs, and continues. A worker can only stop via the shutdown signal, never via an uncaught exception.
- **No backoff, no circuit breaker.** If SQLite is genuinely broken, every worker logs an error every 5 seconds; that is loud enough for the operator/reviewer to notice. Adding exponential backoff or "stop after N failures" is overengineering for this scope.
- **Production-grade alternative (out of scope):** exponential backoff + jitter, max-retry-then-quit, health-check endpoint that flips `unhealthy` if the worker has not claimed in K minutes. To be captured in `interview/design_decisions.md`.

### 12. API response shapes

`POST /analysis` — unchanged behavior, but its error responses are retrofitted to the unified shape (see decision 13 below). Returns `{ workflowId }` on success.

`GET /workflow/:id/status` — `200` for any existing workflow; `404` if not found.

```json
{
  "workflowId": "uuid",
  "status": "in_progress",
  "totalTasks": 4,
  "completedTasks": 2,
  "tasks": [
    {
      "stepNumber": 1,
      "taskType": "polygonArea",
      "status": "completed",
      "dependsOn": []
    },
    {
      "stepNumber": 2,
      "taskType": "dataAnalysis",
      "status": "in_progress",
      "dependsOn": [1]
    },
    {
      "stepNumber": 3,
      "taskType": "emailNotification",
      "status": "failed",
      "dependsOn": [2],
      "failureReason": "dependency_failed"
    }
  ]
}
```

- `tasks[]` is ordered by `stepNumber` ascending.
- `dependsOn` is the `stepNumber[]` form (translated from internal taskIds for caller readability).
- `failureReason` is present **only** on `failed` tasks — values are `dependency_failed` or `job_error`. Full error details live on `/results` via the aggregator's report or are otherwise omitted from `/status` to keep it light.
- No payloads (`output`, `error.message`) are returned here — `/status` is for progress tracking, not data retrieval.

`GET /workflow/:id/results` — lenient policy:

- `200` for any **terminal** workflow (`completed` or `failed`). Body always includes `workflowId`, `status`, `finalResult` (which may be `null` if no aggregator ran or the aggregator failed).
- `400` only for non-terminal workflows (`initial` / `in_progress`), with `{ error: "WORKFLOW_NOT_TERMINAL", message: "..." }`.
- `404` if the workflow id does not exist.
- **Reasoning:** terminal means terminal. The `status` field tells the caller whether tasks succeeded; hiding a successful aggregator's report behind a 400 just because one upstream task failed wastes the aggregator's work and gives a worse caller experience. Documented in `interview/design_decisions.md` as a deliberate divergence from a strict reading of PRD task #6.

**No list endpoint.** `GET /workflow` is **not** implemented. Out of scope; reviewers have workflow IDs from their `POST /analysis` responses. Documented in `interview/design_decisions.md`.

### 13. Unified API error format

All `4xx` / `5xx` responses use a single shape, applied to **both new and existing** endpoints:

```json
{ "error": "ERROR_CODE", "message": "Human-readable explanation" }
```

- A small helper (e.g. `errorResponse(res, status, code, message)`) is used inline in route handlers — no centralized error-throwing/catching middleware, no error classes.
- Existing `POST /analysis` 400 cases (malformed YAML, missing `clientId`/`geoJson`) are retrofitted to this shape using error codes like `INVALID_PAYLOAD`, `INVALID_WORKFLOW_FILE`. Existing tests (if any) are updated to match.
- **Catalog of error codes** (lives next to the helper):
  - `INVALID_PAYLOAD` (400) — missing/malformed request body fields
  - `INVALID_WORKFLOW_FILE` (400) — YAML parse failure or missing required fields
  - `INVALID_DEPENDENCY` (400) — `dependsOn` references a non-existent step
  - `DEPENDENCY_CYCLE` (400) — DAG validation failed
  - `WORKFLOW_NOT_FOUND` (404) — used by `/status` and `/results`
  - `WORKFLOW_NOT_TERMINAL` (400) — `/results` called on `initial` / `in_progress` workflow
  - `INTERNAL_ERROR` (500) — fallback for unexpected exceptions
- **Production-grade alternative (out of scope):** typed error classes plus Express error-handling middleware with consistent logging hooks. To be captured in `interview/design_decisions.md`.

### Shutdown semantics — deliberately skipped

The DB is reset on every process restart (TypeORM `synchronize: true` against a fresh SQLite file in dev). Orphaned `in_progress` rows from a hard exit cannot survive a reboot, so there is no recovery problem to design around.

- **Behavior:** `SIGINT` / `SIGTERM` cause `process.exit` (no drain). HTTP server and workers are killed immediately.
- **Implication:** in-flight tasks during shutdown are abandoned; their state is irrelevant because the next boot starts from an empty DB.
- **Production-grade alternative (out of scope):** persistent DB + graceful drain + claim-recovery on boot (reset `in_progress` rows older than the worker heartbeat back to `queued`). To be captured in `interview/design_decisions.md`.

## Testing Decisions

- **TDD-first.** Per the project's `CLAUDE.md`, the implementor agent uses the `/tdd` skill (red → green → refactor) for every implementation task. Tests are written before the production code that satisfies them.
- `npm test`** is the canonical command.** Run frequently during development and always before committing a task. The harness is set up as the very first implementor task because the starter has no tests yet.
- **Test external behavior, not implementation details.** A test asserts what an outside observer can see — task status transitions visible via the status endpoint, the shape of an aggregator's `finalResult`, the HTTP error body of a malformed request — and avoids coupling to private method names or internal call sequences. For example, a "failed dep skips its dependent" test observes the dependent's status via `/status`, not whether a particular promotion method was called.
- **Module coverage:**
  - **Unit tests** for the polygon-area and report-generation jobs (success + error paths), the workflow-factory dependency validator (missing-step, cycle, self-dep), the runner's task readiness / sibling-promotion / `finalResult` write logic, and the dependency-envelope builder (mapping completed/failed/skipped `Result` rows to the uniform envelope).
  - **Integration tests** for the worker-pool atomic-claim race (multiple workers, one queued task), the end-to-end YAML → workflow → tasks → `finalResult` round-trip via HTTP, the status and results endpoints (success + 400 + 404 cases), and the unified error-response shape on existing endpoints.
- **Manual test plan.** Per `CLAUDE.md`, after each implementation task the implementor documents the manual verification steps in `interview/manual_test_plan.md` (one section per task).
- **Prior art.** The starter currently has no tests; the harness setup is itself the first task.

## Out of Scope

The following are explicitly out of scope for this PRD. Production-grade alternatives are noted inline above and will be captured in `interview/design_decisions.md` once implementation begins.

- Multi-process / distributed scaling — the worker pool is single-process. Cross-process claim, advisory locks, and external queues (Redis, SQS) are deferred.
- Retries, exponential backoff, dead-letter handling, circuit breakers.
- Authentication / authorization on any endpoint.
- Optimistic locking on `Task.status` updates beyond the claim transaction (no version columns).
- Graceful shutdown / drain — `SIGINT` / `SIGTERM` exit immediately and the SQLite DB is reset on boot.
- Endpoint to list workflows (`GET /workflow`).
- TypeORM migrations — the project uses `synchronize: true` against a fresh SQLite file.
- Per-job typed input schemas (Zod / io-ts) and runner-side decoder layer.
- Logging routing, `pino`, request/correlation IDs, log destinations beyond stdout.
- Health-check endpoint that flips `unhealthy` when no claim has occurred recently.

## Further Notes

- The **workspace spec note** (`spec`) is the canonical source of truth for design details — shapes, edge cases, validation rules, error codes, and rationale. This PRD is a high-level summary intended for reviewers and onboarding; if the two ever drift, the spec wins.
- **Production-grade alternatives** marked "out of scope" above are to be captured in `interview/design_decisions.md` once implementation begins, with back-references to the relevant PRD task or design decision so a reviewer can trace each pragmatic choice to its production-grade counterpart.
- **Conventional commits, one per task.** Per `CLAUDE.md`, every implementation task lands as a single commit using conventional-commit format with PRD task / user-story references in the commit body. The git log is part of the project's documentation.
- The original challenge brief (the verbatim "Coding Challenge Tasks for the Interviewee" sections 1–6) lives in `Readme.md` and is unchanged. The user stories in this PRD cover the same ground in the format the to-prd template expects.