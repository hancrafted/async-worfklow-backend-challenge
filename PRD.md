# Async Workflow Backend Challenge — PRD

## Problem Statement

A platform consumer who submits an analysis workflow today gets a single, linear pipeline of independent tasks with no way to express step-to-step dependencies, no aggregated report, no persisted final result, and no HTTP visibility into progress or outputs. Real workflows need branching/joining steps (e.g. polygon-area feeding into a report), a way to know whether a workflow is done, and a way to retrieve its result without tailing logs.

## Solution

Extend the backend so workflows can declare task dependencies in YAML, run dependency-aware via an in-process worker pool, and produce a denormalized framework-synthesized `finalResult` written once at terminal transition (with a lazy fallback patch on read). Add a polygon-area job, a report-generation job, and two HTTP endpoints (`GET /workflow/:id/status` and `GET /workflow/:id/results`) so consumers can monitor progress and retrieve outputs without ever reading the database directly. Workflows are fail-fast (CI-pipeline semantics): the first task failure halts the workflow and sweeps remaining work to `skipped`.

## User Stories

1. As a platform consumer, I want a polygon-area job, so that my workflows can compute polygon area in square meters from the GeoJSON I submitted.
2. As a platform consumer, I want the polygon-area job to fail gracefully on invalid GeoJSON, so that one bad input does not crash the worker or hang the workflow.
3. As a platform consumer, I want a report-generation job, so that a workflow can produce a single aggregated JSON report summarizing every task's output.
4. As a result consumer, I want failed task entries in `finalResult` to include their error info, so that I can diagnose partial failures from the result alone.
5. As a workflow author, I want to declare task dependencies in YAML using `dependsOn: [stepNumber, ...]`, so that I can express multi-step pipelines with branching and joining.
6. As a workflow author, I want a task to depend on multiple upstream tasks (many-to-one), so that join-style steps can wait for several producers.
7. As a workflow author, I want `dependsOn` to always be an array (never a scalar) and to be omitted entirely when a task has no dependencies, so that the YAML format is unambiguous.
8. As a workflow author, I want invalid dependencies (referencing a non-existent step, or forming a cycle) to be rejected at workflow-creation time with a clear error code, so that I learn about mistakes immediately rather than at runtime.
9. As an operator, I want any task failure to halt the workflow and mark all non-terminal tasks as `skipped`, so that doomed branches do not waste work (CI-pipeline semantics).
10. As an operator, I want a `GET /workflow/:id/status` endpoint that returns workflow status plus a per-task list keyed by `stepNumber`, so that I can monitor progress without database access.
11. As an operator, I want the status endpoint to include each task's `dependsOn` (as step numbers) and a `failureReason` field on failed tasks, so that I can see at a glance why a task did not produce output.
12. As an operator, I want a `GET /workflow/:id/results` endpoint that returns the workflow's `finalResult` for any terminal workflow (completed or failed), so that I can retrieve results uniformly regardless of success.
13. As an operator, I want `/results` to return `400` when the workflow is still in progress and `404` when it does not exist, so that the response codes have unambiguous meaning.
14. As an operator, I want `finalResult` to be a uniform framework-synthesized aggregation of every task's output, so that the result shape is predictable across all workflows.
15. As an operator, I want `failedAtStep` on `finalResult` to point to the earliest failing step, so that I can see immediately where the pipeline broke.
16. As an operator, I want internal task UUIDs never to appear in API responses or `finalResult` payloads, so that the public contract speaks only in `stepNumber`s.
17. As a platform operator, I want the worker to handle multiple concurrent tasks via a configurable in-process pool, so that independent ready tasks are not serialized behind each other.
18. As a platform operator, I want concurrent workers to claim tasks atomically, so that two workers never run the same task and post-task workflow updates do not race.
19. As a platform operator, I want unified API error responses of the shape `{ error: CODE, message }` across all endpoints (new and existing), so that callers can handle errors consistently.
20. As a developer, I want job exceptions to be caught per-worker and persisted on `Result.error`, so that one bad job never crashes its worker or leaks across siblings.
21. As a developer, I want runner-level exceptions (DB errors, framework bugs) to be caught by the worker loop and treated as transient, so that the worker can never die from an uncaught exception.
22. As a developer, I want structured JSON-line logs with workflow/task identifiers, so that I can grep or pipe through `jq` operationally without adding a logging dependency.
23. As a developer, I want stack traces stored on `Result.error` for debugging but stripped before they reach API responses or `finalResult`, so that internals do not leak into externally-visible payloads.
24. As a developer, I want to start the system with a clean SQLite database on every restart (no migrations, no drain), so that the challenge harness stays simple and reproducible.

## Implementation Decisions

The sub-decisions below are the locked design. The spec note (`spec`) remains the canonical source of truth; if anything in this section drifts from the spec, the spec wins. Production-grade alternatives for every pragmatic choice live in `interview/design_decisions.md`.

### 1. Task dependencies are many-to-one

A task can depend on multiple prior tasks. Once **all** declared dependencies are in `completed` state, the dependent task becomes eligible to run. Dependency outputs are passed to the task as inputs.

- **Storage:** the `Task` entity gains a `dependsOn` `simple-json` array column holding the dependency taskIds (UUIDs).
- **YAML format:** `dependsOn` is **always an array** of step numbers (e.g. `dependsOn: [1, 2]`). Single-value scalars are not supported; omit the field entirely to mean "no dependencies."

### 2. Fail-fast on any task failure (CI-pipeline semantics)

When any task transitions to `failed`, the workflow halts: the runner sweeps every `waiting`/`queued` sibling to `skipped` in the same post-task transaction, and the workflow itself transitions to `failed`.

- **`skipped` is a new terminal `TaskStatus`.** Skipped tasks produce no `Result` row — the status itself is the explanation.
- **Sweep mechanism:** `UPDATE tasks SET status='skipped' WHERE workflowId=? AND status IN ('waiting','queued')`. Naturally idempotent — a second concurrently-failing task's sweep is a no-op.
- **In-progress tasks are not cancelled.** Jobs are async functions on a shared event loop with no cancellation interface; they run to completion. The workflow stays `failed` regardless of their outcome.
- **No `dependency_failed` reason.** A dep can only ever be `completed` by the time its dependents become eligible — otherwise the workflow has aborted and the dependent is `skipped`.

### 3. Eager dependency resolution

`Task.dependsOn` stores **taskIds** (UUIDs), resolved from YAML `stepNumber`s once when the workflow is created.

- **WorkflowFactory** does a two-pass save: first create all tasks with empty deps to capture the `stepNumber → taskId` map, then resolve each task's `dependsOn` step numbers to taskIds and save again.
- **Validation at creation time** (returns `400` to the API caller if violated):
  - Every referenced `stepNumber` must exist in the workflow → `{ error: "INVALID_DEPENDENCY", message: "Step N references non-existent step M" }`
  - The dependency graph must be a DAG (no cycles, no self-deps) → `{ error: "DEPENDENCY_CYCLE", message: "Cycle detected: 2 → 3 → 2" }`
  - Duplicate `stepNumber`s, missing `taskType`, or unknown `taskType` → `{ error: "INVALID_WORKFLOW_FILE", message: "..." }`
- **Cross-workflow dependencies are forbidden** — this falls out for free because YAML only knows step numbers within its own workflow.
- **Runner readiness check** collapses to a single indexed query: "are all tasks with id ∈ `task.dependsOn` in `completed` state?"

### 4. `stepNumber` is the user-facing identifier

UUIDs are an internal detail. Anywhere a workflow's task structure is exposed to an API caller — status response, results response, `finalResult` payload — tasks are identified by their `stepNumber` (with `taskType` included for readability). The internal `taskId` is never surfaced.

### 5. `JobContext` shape — uniform, no failure variants

`Job.run` receives `{ task, dependencies: [{ stepNumber, taskType, taskId, output }] }`. The previous `Job.run(task)` is migrated to the new signature.

- Under fail-fast (decision 2), a job only runs when every declared dep is `completed`. The dep envelope therefore never carries `status` or `error` — only the upstream `output`.
- **Workflow input** (the original `geoJson` payload) stays on the task itself, accessible via `context.task`. The `dependencies` array carries upstream outputs only.
- Existing starter jobs migrate to the new signature and ignore `dependencies`.

### 6. `Result` entity stays canonical (no `Task.output` column)

The existing `Result` entity remains the single source of truth for task outputs; we do **not** add a `Task.output` column. `Task.resultId` continues to link a task to its (at most one) `Result` row.

- README task #1 says *"save the result in the output field of the task."* We interpret this as the **logical output** (the task's linkage to `Result.data` via `resultId`), not a literal `output` column on `Task`. Rationale and production-grade considerations live in `interview/design_decisions.md` under Task 1.

### 7. `Result` shape — separate `data` and `error` columns

- `Result.data` (nullable JSON-stringified) holds the successful output. Populated when the producing task is `completed`.
- `Result.error` (nullable JSON-stringified `{ message, reason: 'job_error', stack }`) holds the failure record. Populated when the producing task is `failed`. The only `reason` value is `job_error` — fail-fast means `dependency_failed` no longer exists as a state.
- Exactly one of (`data`, `error`) is non-null on any saved `Result`.
- **Skipped tasks produce no `Result` row** — the status itself is the explanation.
- The dep-envelope builder reads each dep's `Result.data` (one extra query per dep, or a single batched query) and parses it into the envelope's `output` field.

### 8. Workflow lifecycle, `finalResult`, and status enum

- **`Workflow.finalResult`** (nullable JSON) is a denormalized snapshot, written once when the workflow transitions to a terminal state. Workflows are immutable once terminal.
- **Framework-owned shape.** `finalResult` is synthesized by the runner from every task's output; no job dictates its shape. The shape is uniform across all workflows:
  ```json
  {
    "workflowId": "<uuid>",
    "failedAtStep": 2,
    "tasks": [
      { "stepNumber": 1, "taskType": "polygonArea",       "status": "completed", "output": { "areaSqMeters": 1234567 } },
      { "stepNumber": 2, "taskType": "analysis",          "status": "failed",    "error": { "message": "Boom", "reason": "job_error" } },
      { "stepNumber": 3, "taskType": "notification",      "status": "skipped" },
      { "stepNumber": 4, "taskType": "reportGeneration",  "status": "skipped" }
    ]
  }
  ```
  - `tasks[]` ordered by `stepNumber` ascending.
  - Each task entry has exactly one of `output` (when `completed`), `error` (when `failed`), or neither (when `skipped`).
  - `error.stack` is stripped at write time so it never reaches the column or any API response.
  - `failedAtStep` is the lowest `stepNumber` among `failed` tasks (deterministic; **omitted** entirely on success).
- **Eager write trigger.** After every task's terminal transition, the runner re-evaluates the workflow inside the post-task transaction. If every task is now terminal, the runner builds `finalResult` and writes it together with the workflow's terminal status. Guarded by `WHERE finalResult IS NULL` so concurrent terminal-transitioning workers don't double-write.
- **Lazy fallback patch.** If `GET /workflow/:id/results` finds a terminal workflow with `finalResult IS NULL` (rare race or crash), the read handler computes and persists `finalResult` before returning, under the same idempotent guard. The query handler **never** advances workflow lifecycle — only the runner does that.
- **Workflow status enum (four-state):**
  - `initial` — created, no task has started.
  - `in_progress` — at least one task started, not all terminal.
  - `completed` — every task ended in `completed`.
  - `failed` — at least one task ended in `failed` (or, equivalently, at least one task was swept to `skipped`, which only happens because some task failed).

### 9. Task readiness — `waiting → queued → in_progress → terminal`

The starter's `queued` semantic ("in the worker's pickup queue") is preserved. A new `waiting` status represents tasks blocked on dependencies; a new `skipped` terminal status (decision 2) represents tasks the workflow's halt prevented from running.

- **`TaskStatus` enum:**
  - `waiting` — created, has dependencies that are not all `completed` yet. **Not** picked up by the worker.
  - `queued` — eligible to run; in the worker's pickup queue.
  - `in_progress` — claimed by a worker, executing.
  - `completed` — terminal, success.
  - `failed` — terminal, the task threw (`reason: 'job_error'`).
  - `skipped` — terminal, the workflow aborted before this task ran.
- **`WorkflowFactory` insertion rule:** tasks with no deps insert as `queued`; tasks with declared deps insert as `waiting`.
- **Promotion after each `completed` transition:** scan `waiting` siblings whose deps are all now `completed`; set them to `queued`. There is no `failed`-dep branch — that case is handled by the workflow-level sweep (decision 2).
- **`initial → in_progress` bump:** the same atomic claim transaction that moves a task to `in_progress` also bumps the workflow from `initial → in_progress` if applicable (idempotent: `WHERE status='initial'`).
- **`finalResult` write** happens in the same post-task block once every task is terminal (decision 8).

### 10. Concurrency — in-process worker pool

The system runs a configurable pool of N concurrent workers within the same Node process (default `N=3`, override via `WORKER_POOL_SIZE` env var). All workers share a single `AppDataSource`. Workers are coroutines on the same event loop, not OS threads — appropriate for the DB-bound + light-CPU workload here.

- **Per-worker loop:** atomically claim the next `queued` task → run it → loop immediately. On a lost claim race (`rowsAffected === 0`), immediately try the next candidate; do not sleep. Sleep 5 seconds only when no `queued` task exists at all.
- **Atomic claim:** `UPDATE tasks SET status='in_progress' WHERE taskId=? AND status='queued'`, checking `rowsAffected === 1`. The same transaction also bumps `workflows.status` from `initial → in_progress` when applicable.
- **Post-task workflow update is transactional and idempotent.** Sibling promotion (`UPDATE WHERE status='waiting' AND deps-all-completed`), failure sweep (`UPDATE WHERE status IN ('waiting','queued')` on failure), and `finalResult` write (`WHERE finalResult IS NULL`) are all naturally idempotent and survive concurrent terminal transitions.

### 11. Worker error handling and structured logging

**Job exceptions** (inside `Job.run`) are caught by the worker, persisted on `Result.error`, logged, and never propagate — the worker continues claiming the next task.

- **Persisted shape on `Result.error`:** `{ message, reason: 'job_error', stack }` where `stack` is the first 10 lines of the original stack trace, retained for debugging.
- **API response shaping:** the `/results` endpoint and the `finalResult` writer **strip `stack`** before persisting/returning. Callers see only `{ message, reason }`.
- **Per-worker isolation:** every job invocation lives inside its own try/catch. A job exception → mark the task `failed` → emit error log → continue. A bad job can never crash its worker, and one worker's failures never affect siblings.

**Structured logging** is provided by a small in-house logger wrapper around `console.log` / `console.error` that emits **JSON-line** logs to stdout. No new dependencies.

- **Shape:** `{ level, ts, workflowId?, taskId?, stepNumber?, taskType?, msg, error? }`. Always JSON, always one line, regardless of `NODE_ENV` (no pretty-printing branch — `jq` is the dev-mode pretty-printer).
- **Levels used:**
  - `info` — task start/finish, workflow lifecycle transitions, worker start/stop.
  - `warn` — failure sweeps, no-op claim attempts when the queue is empty.
  - `error` — job exceptions, runner-level exceptions, unexpected state.

**Runner-level exceptions** (DB error during claim or post-task transaction, framework bugs) are **caught by the worker loop and treated as transient** — log at `error`, sleep one tick (5 seconds), retry.

- **Loop-of-last-resort:** the per-worker loop body itself is wrapped in try/catch. Even if the inner `runJob` try/catch leaks (it should not), the loop catches, logs, and continues. A worker can only stop via the shutdown signal, never via an uncaught exception.
- **No backoff, no circuit breaker.** If SQLite is genuinely broken, every worker logs an error every 5 seconds; that is loud enough for the operator/reviewer to notice.

### 12. API response shapes

`POST /analysis` — preserved at `202 Accepted` (the workflow is queued, not done). Body becomes `{ "workflowId": "<uuid>" }`; the legacy `message` field is dropped. Error responses retrofitted to the unified shape (decision 13).

`GET /workflow/:id/status` — `200` for any existing workflow; `404` if not found.

```json
{
  "workflowId": "uuid",
  "status": "in_progress",
  "totalTasks": 4,
  "completedTasks": 1,
  "tasks": [
    { "stepNumber": 1, "taskType": "polygonArea",       "status": "completed",   "dependsOn": [] },
    { "stepNumber": 2, "taskType": "analysis",          "status": "failed",      "dependsOn": [1], "failureReason": "job_error" },
    { "stepNumber": 3, "taskType": "notification",      "status": "skipped",     "dependsOn": [2] },
    { "stepNumber": 4, "taskType": "reportGeneration",  "status": "in_progress", "dependsOn": [1,2,3] }
  ]
}
```

- `tasks[]` is ordered by `stepNumber` ascending.
- `dependsOn` is the `stepNumber[]` form (translated from internal taskIds for caller readability).
- `failureReason` is present **only** on `failed` tasks; the only value under fail-fast is `job_error`. `skipped` tasks need no reason — the status itself is the explanation.
- No payloads (`output`, `error.message`) are returned here — `/status` is for progress tracking, not data retrieval.

`GET /workflow/:id/results` — lenient terminal policy:

- `200` for any **terminal** workflow (`completed` or `failed`). Body wraps the framework-synthesized `finalResult` (decision 8):
  ```json
  { "workflowId": "uuid", "status": "failed", "finalResult": { /* see decision 8 */ } }
  ```
- `400` only for non-terminal workflows (`initial` / `in_progress`), with `{ "error": "WORKFLOW_NOT_TERMINAL", "message": "..." }`.
- `404` if the workflow id does not exist.
- **Lazy patch:** if a terminal workflow has `finalResult IS NULL`, the handler computes and persists it before returning (see decision 8). The handler never advances workflow lifecycle.
- **Reasoning for lenient terminal:** terminal means terminal. Hiding a meaningful `finalResult` (with `failedAtStep` and per-task error info) behind a 400 just because some tasks failed wastes work and gives a worse caller experience. Recorded in `interview/design_decisions.md` against Task 6.

**No list endpoint.** `GET /workflow` is **not** implemented. Out of scope; reviewers have workflow IDs from their `POST /analysis` responses.

### 13. Unified API error format

All `4xx` / `5xx` responses use a single shape, applied to **both new and existing** endpoints:

```json
{ "error": "ERROR_CODE", "message": "Human-readable explanation" }
```

- A small helper (e.g. `errorResponse(res, status, code, message)`) is used inline in route handlers — no centralized error-throwing/catching middleware, no error classes.
- Existing `POST /analysis` 400 cases (malformed YAML, missing `clientId`/`geoJson`) are retrofitted to this shape using error codes like `INVALID_PAYLOAD`, `INVALID_WORKFLOW_FILE`.
- **Catalog of error codes** (lives next to the helper):
  - `INVALID_PAYLOAD` (400) — missing/malformed request body fields
  - `INVALID_WORKFLOW_FILE` (400) — YAML parse failure, missing required fields, duplicate `stepNumber`, unknown `taskType`
  - `INVALID_DEPENDENCY` (400) — `dependsOn` references a non-existent step
  - `DEPENDENCY_CYCLE` (400) — DAG validation failed (cycle or self-dep)
  - `WORKFLOW_NOT_FOUND` (404) — used by `/status` and `/results`
  - `WORKFLOW_NOT_TERMINAL` (400) — `/results` called on `initial` / `in_progress` workflow
  - `INTERNAL_ERROR` (500) — fallback for unexpected exceptions

### Shutdown semantics — deliberately skipped

The DB is reset on every process restart (TypeORM `synchronize: true` against a fresh SQLite file in dev). Orphaned `in_progress` rows from a hard exit cannot survive a reboot, so there is no recovery problem to design around.

- **Behavior:** `SIGINT` / `SIGTERM` cause `process.exit` (no drain). HTTP server and workers are killed immediately.
- **Implication:** in-flight tasks during shutdown are abandoned; their state is irrelevant because the next boot starts from an empty DB.

## Testing Decisions

- **TDD-first.** Per the project's `CLAUDE.md`, the implementor agent uses the `/tdd` skill (red → green → refactor) for every implementation task. Tests are written before the production code that satisfies them.
- **Vitest is the test framework.** `npm test` is the canonical command — run frequently during development and always before committing a task. The harness is set up as the very first implementor task because the starter has no tests yet.
- **Test external behavior, not implementation details.** A test asserts what an outside observer can see — task status transitions visible via `/status`, the shape of `finalResult` via `/results`, the HTTP error body of a malformed request — and avoids coupling to private method names or internal call sequences.
- **Module coverage:**
  - **Unit tests** for the polygon-area and report-generation jobs (success + error paths), the workflow-factory dependency validator (missing-step, cycle, self-dep, duplicate stepNumber, unknown taskType), the runner's promotion / sweep / `finalResult` write logic, and the dependency-envelope builder.
  - **Integration tests** for the worker-pool atomic-claim race (multiple workers, one queued task), the end-to-end YAML → workflow → tasks → `finalResult` round-trip via HTTP, the status and results endpoints (success + 400 + 404 cases), the fail-fast sweep behavior, and the unified error-response shape.
- **Test fixtures.** New workflow fixtures live in `tests/test-workflows/`. The HTTP `POST /analysis` endpoint stays hardcoded to load `src/workflows/example_workflow.yml`; tests load other YAMLs directly via `WorkflowFactory`.
- **Manual test plan.** Per `CLAUDE.md`, after each implementation task the implementor documents the manual verification steps in `interview/manual_test_plan.md` (one section per task).

## Out of Scope

The following are explicitly out of scope. Production-grade alternatives for every pragmatic choice are catalogued in `interview/design_decisions.md`.

- Multi-process / distributed scaling — the worker pool is single-process.
- Retries, exponential backoff, dead-letter handling, circuit breakers.
- Authentication / authorization on any endpoint.
- Optimistic locking on `Task.status` updates beyond the claim transaction.
- Graceful shutdown / drain — `SIGINT` / `SIGTERM` exit immediately.
- Endpoint to list workflows (`GET /workflow`).
- TypeORM migrations — the project uses `synchronize: true` against a fresh SQLite file.
- Per-job typed input schemas (Zod / io-ts).
- Health-check endpoint.
- True cancellation of `in_progress` jobs when the workflow aborts.

## Further Notes

- The **workspace spec note** (`spec`) is the canonical source of truth for design details — shapes, edge cases, validation rules, error codes, and rationale. This PRD is a high-level summary intended for reviewers and onboarding; if the two ever drift, the spec wins.
- **`interview/design_decisions.md`** holds the pragmatic-vs-production-grade trade-off bookkeeping (General Assumptions + per-Task sections), keeping the PRD focused on the chosen design.
- **Conventional commits, one per task.** Per `CLAUDE.md`, every implementation task lands as a single commit using conventional-commit format with PRD task / user-story references in the commit body. The git log is part of the project's documentation.
- The original challenge brief (the verbatim "Coding Challenge Tasks for the Interviewee" sections 1–6) lives in `Readme.md` and is unchanged.