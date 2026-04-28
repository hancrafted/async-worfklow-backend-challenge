# §Task 2 — ReportGenerationJob

**Branch:** `feat/task-2-report-generation`
**Issue:** [#3](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/3)
**PRD:** §Task 2 (US3) + §Implementation Decision 4 (`stepNumber`-not-`taskId`)

## Setup

`reportGeneration` is a new task type registered in `JobFactory`. The shipped
`src/workflows/example_workflow.yml` does NOT include a `reportGeneration`
step (deliberately — see `interview/design_decisions.md` §Task 2). To
exercise the job end-to-end via curl, temporarily swap in the manual-test YAML
below and revert before commit.

```yaml
# src/workflows/example_workflow.yml — temporary edit, revert before commit
name: "example_workflow"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
  - taskType: "analysis"
    stepNumber: 2
  - taskType: "reportGeneration"
    stepNumber: 3
    dependsOn: [1, 2]
```

Boot the server:

```bash
npm install   # only on a fresh clone
npm start
# → Server is running at http://localhost:3000
```

The worker pool polls every 5s; allow each step that long to transition.

## 1. Happy path — report aggregates upstream outputs

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-test-report-happy",
    "geoJson": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    }
  }'
# → 202 { "workflowId": "<uuid>" }
```

Wait ~15s for all three steps to drain, then verify in `data/database.sqlite`:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, taskType, status FROM tasks
   WHERE clientId='manual-test-report-happy' ORDER BY stepNumber;"
# → 1 polygonArea       completed
# → 2 analysis          completed
# → 3 reportGeneration  completed

sqlite3 data/database.sqlite \
  "SELECT data FROM results WHERE resultId IN (
     SELECT resultId FROM tasks
     WHERE clientId='manual-test-report-happy' AND taskType='reportGeneration'
   );"
```

The `data` column should contain a JSON document of the locked shape:

```json
{
  "workflowId": "<uuid>",
  "tasks": [
    { "stepNumber": 1, "taskType": "polygonArea", "output": { "areaSqMeters": 12363718145.18 } },
    { "stepNumber": 2, "taskType": "analysis",    "output": "No country found" }
  ],
  "finalReport": "Generated report for workflow <uuid> with 2 tasks"
}
```

Assertions to verify by eye:

- `tasks[]` is sorted by `stepNumber` ascending.
- No `taskId` field appears anywhere in the report (PRD §Decision 4 — internal
  UUIDs never leak).
- `finalReport` is a framework-supplied summary string mentioning the
  workflow id and the task count.

## 2. Sad path — corrupted upstream Result

This sad path is normally unreachable in production (the runner's terminal
transaction commits the upstream `Result` and `Task.status` together), but
proves the runner's defensive envelope-build behavior.

1. Run the happy-path curl above and let step 1 (`polygonArea`) complete.
2. Before the worker drains step 3, surgically corrupt step 1's `Result.data`:

```bash
sqlite3 data/database.sqlite \
  "UPDATE results SET data='not-valid-json{'
   WHERE resultId IN (
     SELECT resultId FROM tasks
     WHERE clientId='manual-test-report-happy' AND taskType='polygonArea'
   );"
```

3. Wait ~5s for the next worker tick and re-inspect:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, taskType, status FROM tasks
   WHERE clientId='manual-test-report-happy' ORDER BY stepNumber;"
# → 3 reportGeneration  failed
```

The server's stderr emits a structured `job failed` line with
`error.message` mentioning `is not valid JSON`. The workflow ends `failed`
because the report task transitions to `failed` and the lifecycle eval flips
the workflow.

## 3. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.
Revert any edits to `src/workflows/example_workflow.yml` before committing:

```bash
git checkout -- src/workflows/example_workflow.yml
```
