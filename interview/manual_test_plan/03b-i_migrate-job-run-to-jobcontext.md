# §Task 3b-i — Migrate `Job.run` to the `JobContext` signature

**Branch:** `migrate-job.run-to-jobcontext`
**Issue:** [#6](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/6)
**PRD:** §Implementation Decision 5

## Setup

This task is a pure signature migration — no observable behavior change. The
shipped `src/workflows/example_workflow.yml` (single `analysis` step, no
`dependsOn`) is the right fixture for the smoke test; do not edit it.

```bash
npm install   # only on a fresh clone
npm start
# → Server is running at http://localhost:3000
```

The worker polls the queue every 5s; give the step that long to transition.

## 1. Single-step workflow still runs end-to-end after the migration

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-test-3b-i",
    "geoJson": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    }
  }'
# → 202 { "workflowId": "<uuid>", "message": "Workflow created..." }
```

Wait ~5s, then verify in `data/database.sqlite`:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskType, status, resultId FROM tasks WHERE clientId='manual-test-3b-i';"
# → analysis, completed, <uuid>

sqlite3 data/database.sqlite \
  "SELECT data, error FROM results WHERE resultId IN (
     SELECT resultId FROM tasks WHERE clientId='manual-test-3b-i'
   );"
# → data = '"<country name>"' (or '"No country found"'), error = (NULL)
```

Server logs include:

```
Starting job analysis for task <uuid>...
Running data analysis for task <uuid>...
Job analysis for task <uuid> completed successfully.
```

The single-step workflow reaches a terminal state exactly as it did before
the migration — the task is marked `completed`, the linked `Result` row
carries the same `data` payload, and no behavior depends on the
`dependencies: []` envelope being passed through.

## 2. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.
Nothing to revert — `example_workflow.yml` is left unchanged by this task.
