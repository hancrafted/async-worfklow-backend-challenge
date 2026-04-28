## §Task 5 — `GET /workflow/:id/status`

**Branch:** `tasks-4-6-sequential-delivery`
**PRD:** §Implementation Decisions 4, 12, 13 — US10, US11, US16, US19
**Issue:** [#10](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/10)

`GET /workflow/:id/status` returns the workflow's current lifecycle status
plus a per-task list keyed by `stepNumber`. The endpoint is read-only — it
never advances workflow lifecycle. The shipped 6-step `example_workflow.yml`
exercises the happy path; a temporary 2-step edit drives the failure path.

### Setup

```bash
npm install   # only on a fresh clone
npm start
# → server listening at http://localhost:3000
```

The worker polls every 5s.

### 1. Happy path — progression `in_progress → completed`

Submit the shipped 6-step workflow:

```bash
WORKFLOW_ID=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task5-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }' | jq -r .workflowId)
echo "$WORKFLOW_ID"
```

Poll the status endpoint within the first 5–10s — at least one step should
still be `queued`/`waiting`/`in_progress`:

```bash
curl -sS "http://localhost:3000/workflow/$WORKFLOW_ID/status" | jq .
```

Confirm:

- `status` is `"in_progress"` (US10).
- `totalTasks === 6`, `completedTasks` between `0` and `5`.
- `tasks` ordered by `stepNumber` ascending.
- `dependsOn` is an array of step numbers (e.g. `[1, 2]`) — never UUIDs (US16).
- No `taskId` field appears anywhere in the response payload.
- No `output` field, no `error` field — `/status` is for progress, not data.

After ~30s every step has terminated. Hit the endpoint again:

```bash
curl -sS "http://localhost:3000/workflow/$WORKFLOW_ID/status" | jq .
```

Confirm:

- `status` is `"completed"`.
- `completedTasks === totalTasks` (i.e. `6`).
- Every `tasks[].status` is `"completed"` and no entry carries
  `failureReason`.

### 2. Error path — failed/skipped mix

Edit `src/workflows/example_workflow.yml` to a 2-step chain whose first
step rejects malformed GeoJSON:

```yaml
# src/workflows/example_workflow.yml — TEMPORARY for the failure flow
name: "task_5_failure_chain"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
  - taskType: "analysis"
    stepNumber: 2
    dependsOn: [1]
```

Restart `npm start`, then submit a payload whose first step's validator
rejects (a `Point` is not a `Polygon`):

```bash
WORKFLOW_ID=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task5-fail",
    "geoJson": { "type": "Point", "coordinates": [0, 0] }
  }' | jq -r .workflowId)
```

Wait ~5s, then:

```bash
curl -sS "http://localhost:3000/workflow/$WORKFLOW_ID/status" | jq .
```

Confirm:

- `status` is `"failed"`.
- `totalTasks === 2`, `completedTasks === 0`.
- The `stepNumber=1` entry is `{ "status": "failed", "failureReason":
  "job_error" }` (US11).
- The `stepNumber=2` entry is `{ "status": "skipped" }` — it carries no
  `failureReason`. The status itself is the explanation under fail-fast.
- The blob contains no `error.message` substring (no `output` either) —
  payload retrieval is `/results` (Task 6), not `/status`.

### 3. Error path — workflow not found

```bash
curl -sS -i "http://localhost:3000/workflow/00000000-0000-0000-0000-000000000000/status"
# → HTTP/1.1 404 Not Found
# → { "error": "WORKFLOW_NOT_FOUND", "message": "Workflow with id '...' was not found" }
```

Confirm the unified `{ error, message }` shape (US19).

### 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

### Automated checks

```bash
npx vitest run tests/05-workflow-status/
# → 2 files / 9 tests passed (5 unit + 4 integration)
npm test
# → all suites green
```
