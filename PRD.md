# Async Workflow Backend Challenge — PRD

## Original Challenge Brief (from Readme.md)

The following six tasks are reproduced verbatim from `Readme.md` and constitute the canonical challenge brief.

### **Coding Challenge Tasks for the Interviewee**

The following tasks must be completed to enhance the backend system:

---

### **1. Add a New Job to Calculate Polygon Area**

**Objective:**
Create a new job class to calculate the area of a polygon from the GeoJSON provided in the task.

#### **Steps:**

1. Create a new job file `PolygonAreaJob.ts` in the `src/jobs/` directory.
2. Implement the `Job` interface in this new class.
3. Use `@turf/area` to calculate the polygon area from the `geoJson` field in the task.
4. Save the result in the `output` field of the task.

#### **Requirements:**

- The `output` should include the calculated area in square meters.
- Ensure that the job handles invalid GeoJSON gracefully and marks the task as failed.

---

### **2. Add a Job to Generate a Report**

**Objective:**
Create a new job class to generate a report by aggregating the outputs of multiple tasks in the workflow.

#### **Steps:**

1. Create a new job file `ReportGenerationJob.ts` in the `src/jobs/` directory.
2. Implement the `Job` interface in this new class.
3. Aggregate outputs from all preceding tasks in the workflow into a JSON report. For example:
   ```json
   {
     "workflowId": "<workflow-id>",
     "tasks": [
       { "taskId": "<task-1-id>", "type": "polygonArea", "output": "<area>" },
       {
         "taskId": "<task-2-id>",
         "type": "dataAnalysis",
         "output": "<analysis result>"
       }
     ],
     "finalReport": "Aggregated data and results"
   }
   ```
4. Save the report as the `output` of the `ReportGenerationJob`.

#### **Requirements:**

- Ensure the job runs only after all preceding tasks are complete.
- Handle cases where tasks fail, and include error information in the report.

---

### **3. Support Interdependent Tasks in Workflows**

**Objective:**
Modify the system to support workflows with tasks that depend on the outputs of earlier tasks.

#### **Steps:**

1. Update the `Task` entity to include a `dependency` field that references another task
2. Modify the `TaskRunner` to wait for dependent tasks to complete and pass their outputs as inputs to the current task.
3. Extend the workflow YAML format to specify task dependencies (e.g., `dependsOn`).
4. Update the `WorkflowFactory` to parse dependencies and create tasks accordingly.

#### **Requirements:**

- Ensure dependent tasks do not execute until their dependencies are completed.
- Test workflows where tasks are chained through dependencies.

---

### **4. Ensure Final Workflow Results Are Properly Saved**

**Objective:**
Save the aggregated results of all tasks in the workflow as the `finalResult` field of the `Workflow` entity.

#### **Steps:**

1. Modify the `Workflow` entity to include a `finalResult` field:
2. Aggregate the outputs of all tasks in the workflow after the last task completes.
3. Save the aggregated results in the `finalResult` field.

#### **Requirements:**

- The `finalResult` must include outputs from all completed tasks.
- Handle cases where tasks fail, and include failure information in the final result.

---

### **5. Create an Endpoint for Getting Workflow Status**

**Objective:**
Implement an API endpoint to retrieve the current status of a workflow.

#### **Endpoint Specification:**

- **URL:** `/workflow/:id/status`
- **Method:** `GET`
- **Response Example:**
  ```json
  {
    "workflowId": "3433c76d-f226-4c91-afb5-7dfc7accab24",
    "status": "in_progress",
    "completedTasks": 3,
    "totalTasks": 5
  }
  ```

#### **Requirements:**

- Include the number of completed tasks and the total number of tasks in the workflow.
- Return a `404` response if the workflow ID does not exist.

---

### **6. Create an Endpoint for Retrieving Workflow Results**

**Objective:**
Implement an API endpoint to retrieve the final results of a completed workflow.

#### **Endpoint Specification:**

- **URL:** `/workflow/:id/results`
- **Method:** `GET`
- **Response Example:**
  ```json
  {
    "workflowId": "3433c76d-f226-4c91-afb5-7dfc7accab24",
    "status": "completed",
    "finalResult": "Aggregated workflow results go here"
  }
  ```

#### **Requirements:**

- Return the `finalResult` field of the workflow if it is completed.
- Return a `404` response if the workflow ID does not exist.
- Return a `400` response if the workflow is not yet completed.

---

## Design Decisions Summary

This section summarizes the nine design decisions locked in during the design phase. Full rationale, edge cases, and code-level shapes live in the workspace spec note (canonical source).

### 1. Task dependencies are many-to-one
A task can declare multiple upstream dependencies. `Task.dependsOn` is a JSON array column holding the dependency taskIds. The YAML format uses `dependsOn: [<stepNumber>, ...]` — always an array, never a scalar; omit the field to mean "no dependencies." A normalized join table is the production-grade alternative and is out of scope.

### 2. Failed-dependency policy
By default, if any declared dependency ends in `failed`, the dependent task is **skipped** — marked `failed` with reason `dependency_failed` and never executed. Jobs flagged as **aggregators** (e.g. `ReportGenerationJob`) are the exception: they always run once all dependencies are terminal and receive each dependency's status + output (or error) as input, so they can surface failure info in their report.

### 3. Eager dependency resolution
YAML `stepNumber`s are resolved to internal `taskId`s once at workflow creation time via a two-pass save in `WorkflowFactory`. The dependency graph is validated as a DAG at the same point: missing-step references return `400 INVALID_DEPENDENCY` and cycles return `400 DEPENDENCY_CYCLE`. The runner's readiness check then collapses to a single indexed query.

### 4. `stepNumber` is the user-facing identifier
Internal `taskId`s (UUIDs) never appear in API responses or aggregator-built reports — they are a DB detail. Anywhere a workflow's task structure is exposed (status response, results response, report payload), tasks are identified by their `stepNumber` (with `taskType` included for readability).

### 5. `JobContext` shape with a uniform dependency envelope
`Job.run(task)` becomes `Job.run(context: JobContext)` where `JobContext = { task, dependencies: DependencyResult[] }`. Each `DependencyResult` carries `{ stepNumber, taskType, status, output | null, error? }` — a uniform envelope shape regardless of success/failure, so aggregators can iterate without conditionals. Existing starter jobs are migrated to accept the context and ignore `dependencies`.

### 6. `Result` entity stays canonical
The existing `Result` entity remains the single source of truth for task outputs — no `Task.output` column is added. `Result` carries **separate `data` and `error` columns** (exactly one non-null per row) so success vs failure is structurally unambiguous and aggregators can read errors directly. The PRD's literal "save the result in the output field of the task" is interpreted as the logical task-output linkage (`Task.resultId → Result.data`); this deviation is documented in `interview/design_decisions.md`.

### 7. Workflow lifecycle, `finalResult`, and status enum
`Workflow.finalResult` is written **once** at terminal transition and is **the aggregator's output verbatim** — the runner does not synthesize an alternative shape. Workflow status is a four-value enum: `initial` → `in_progress` → `completed` (every task succeeded) or `failed` (any task failed, including dependency-skipped failures). An aggregator that runs over partially-failed deps still produces a report in `finalResult`, but the workflow status is `failed` because not every task succeeded. Workflows without an aggregator simply leave `finalResult` as `null`.

### 8. Task readiness and worker pool
A new `waiting` status sits in front of `queued`: tasks with unmet deps are inserted as `waiting` (not picked up), tasks with no deps are inserted as `queued`. After every terminal transition, the runner promotes ready siblings (`waiting → queued`) or skips them (`waiting → failed` with `dependency_failed`). Concurrency is a configurable in-process **worker pool** (`WORKER_POOL_SIZE`, default 3) sharing a single `AppDataSource`; each claim is a short atomic transaction (SQLite write-lock serializes the race), and the post-task block (sibling promotion + status reevaluation + `finalResult` write) is also transactional and idempotent.

### 9. Worker error handling, structured logging, unified API errors
Job exceptions are caught per-worker, persisted to `Result.error` as `{ message, reason: 'job_error', stack }`, logged, and never propagate (`stack` is stripped before reaching API responses or aggregator inputs). Runner-level exceptions are treated as transient — log, sleep one tick, retry; the worker loop body is wrapped in a loop-of-last-resort try/catch. Logging is JSON-line via a small in-house `logger.ts` (no new deps), always one line, always structured. All API error responses use a unified shape `{ error: ERROR_CODE, message }` applied to both new and existing endpoints. `GET /workflow/:id/status` returns a full per-task list keyed by `stepNumber` (with `failureReason` only on failed tasks; no payloads). `GET /workflow/:id/results` is **lenient** — `200` for any terminal workflow (`completed` or `failed`), `400` only when non-terminal, `404` when not found. Graceful shutdown is deliberately **skipped** — the SQLite DB resets on every restart so orphaned `in_progress` rows cannot survive a reboot.

---

## Documentation Conventions

- **Production-grade alternatives** marked "out of scope" in this PRD and the spec are to be captured in `interview/design_decisions.md` once implementation begins, with a back-reference to the relevant PRD task or design decision.
- The **workspace spec note** (`spec`) is the canonical source of truth for design details — shapes, edge cases, validation rules, error codes, and rationale. This PRD.md is a high-level summary intended for reviewers and onboarding; if the two ever drift, the spec note wins.
