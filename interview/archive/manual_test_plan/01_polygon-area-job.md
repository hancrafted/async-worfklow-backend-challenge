# §Task 1 — PolygonAreaJob

**Branch:** `task-1-polygonareajob`
**Issue:** [#2](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/2)
**PRD:** §Task 1 (US1, US2, US20)

## Setup

The shipped `src/workflows/example_workflow.yml` is hardcoded for the
`POST /analysis` route and uses `analysis` + `notification` tasks. To exercise
`polygonArea` end-to-end via curl, temporarily edit it (revert before commit):

```yaml
# src/workflows/example_workflow.yml
name: "example_workflow"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
```

Boot the server:

```bash
npm install   # only on a fresh clone
npm start
# → Server is running at http://localhost:3000
```

The worker polls the queue every 5s; give each step that long to transition.

## 1. Happy path — valid GeoJSON polygon

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-test-happy",
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
  "SELECT taskId, status, resultId FROM tasks WHERE taskType='polygonArea';"
# → status = 'completed', resultId = '<uuid>'

sqlite3 data/database.sqlite \
  "SELECT data, error FROM results;"
# → data = '{"areaSqMeters":12363718145.180046}', error = (NULL)
```

In the server logs you should see:

```
Starting job polygonArea for task <uuid>...
Job polygonArea for task <uuid> completed successfully.
```

## 2. Sad path — malformed GeoJSON

Re-run the same curl with a body that won't parse as a Polygon (here a Point;
malformed JSON works too):

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-test-sad",
    "geoJson": { "type": "Point", "coordinates": [0,0] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s, then in the DB:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskId, status, resultId FROM tasks WHERE clientId='manual-test-sad';"
# → status = 'failed', resultId = '<uuid>' (linked, not NULL)

sqlite3 data/database.sqlite \
  "SELECT data, error FROM results WHERE resultId IN (
     SELECT resultId FROM tasks WHERE clientId='manual-test-sad'
   );"
# → data = (NULL)
# → error = '{"message":"Invalid GeoJSON: ...","reason":"job_error","stack":"..."}'
```

Server logs include the runner's `Error running job polygonArea ...` line. The
worker continues running — issue another `POST /analysis` and confirm a new
task is picked up on the next 5s tick.

## 3. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.
Revert any edits to `src/workflows/example_workflow.yml` before committing:

```bash
git checkout -- src/workflows/example_workflow.yml
```
