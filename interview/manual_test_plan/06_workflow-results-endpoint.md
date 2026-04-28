## §Task 6 — `GET /workflow/:id/results`

**Branch:** `tasks-4-6-sequential-delivery`
**PRD:** §Implementation Decisions 8, 12, 13 — US12, US13, US19 (reinforces US14, US15, US16)
**Issue:** [#11](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/11)

`GET /workflow/:id/results` returns the framework-synthesized `finalResult`
for `completed` workflows. Per the literal Readme §Task 6 contract —
*"Return a 400 response if the workflow is not yet completed."* — `failed`
workflows return `400 WORKFLOW_FAILED` (failure detail still surfaces via
`GET /workflow/:id/status` under `failureReason`). The handler is
read-only — it never advances workflow lifecycle. If a `completed`
workflow has `finalResult IS NULL` (rare race or a row from before §Task 4
landed), the handler synthesizes it on the fly via the same
`synthesizeFinalResult(...)` helper the runner uses, persists it under
`WHERE finalResult IS NULL`, and returns the payload.

> Replaces the interim SQLite-inspection step from
> [`04_workflow-final-result-synthesis.md`](./04_workflow-final-result-synthesis.md).

### Setup

```bash
npm install   # only on a fresh clone
npm start
# → server listening at http://localhost:3000
```

The worker polls every 5s.

### 1. Happy path — completed workflow → `200` with full `finalResult`

Submit the shipped 6-step workflow and wait ~30s for it to drain:

```bash
WORKFLOW_ID=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task6-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }' | jq -r .workflowId)
echo "$WORKFLOW_ID"
sleep 35
curl -sS "http://localhost:3000/workflow/$WORKFLOW_ID/results" | jq .
```

Confirm:

- HTTP `200`.
- `status` is `"completed"`.
- `finalResult.workflowId` matches `$WORKFLOW_ID`.
- `finalResult.tasks` is sorted by `stepNumber` ascending; every entry has
  `status: "completed"` with an `output`.
- `finalResult` has **no** `failedAtStep` (US15 — omitted on success).
- The blob contains no `taskId` substring (US16 — UUIDs do not leak).

### 2. Error path — failed workflow → `400 WORKFLOW_FAILED`

Edit `src/workflows/example_workflow.yml` to a 2-step chain whose first
step rejects malformed GeoJSON:

```yaml
# src/workflows/example_workflow.yml — TEMPORARY for the failure flow
name: "task_6_failure_chain"
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
    "clientId": "manual-task6-fail",
    "geoJson": { "type": "Point", "coordinates": [0, 0] }
  }' | jq -r .workflowId)
sleep 6
curl -sS -i "http://localhost:3000/workflow/$WORKFLOW_ID/results"
```

Confirm:

- HTTP `400` (literal Readme §Task 6 — `failed` is not `completed`).
- Body: `{ "error": "WORKFLOW_FAILED", "message": "Workflow with id '...'
  failed; results are unavailable. Inspect /workflow/<id>/status for
  per-task failureReason." }`.
- A follow-up `GET /workflow/$WORKFLOW_ID/status` reports
  `status: "failed"`, the `stepNumber=1` entry carries
  `failureReason: "job_error"`, and the `stepNumber=2` entry is
  `status: "skipped"`.

### 3. Error path — non-terminal workflow → `400 WORKFLOW_NOT_TERMINAL`

Submit a fresh workflow and immediately (within the first ~5s, before the
first tick) hit `/results`:

```bash
WORKFLOW_ID=$(curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task6-pending",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }' | jq -r .workflowId)
curl -sS -i "http://localhost:3000/workflow/$WORKFLOW_ID/results"
```

Confirm:

- HTTP `400`.
- Body: `{ "error": "WORKFLOW_NOT_TERMINAL", "message": "Workflow with id
  '...' is not terminal (status: initial)" }` (or `status: in_progress` if
  the first tick already fired).
- A follow-up `GET /workflow/$WORKFLOW_ID/status` confirms the workflow's
  status was **not** advanced by the `/results` call (US19).

### 4. Error path — workflow not found → `404 WORKFLOW_NOT_FOUND`

```bash
curl -sS -i "http://localhost:3000/workflow/00000000-0000-0000-0000-000000000000/results"
```

Confirm:

- HTTP `404`.
- Body: `{ "error": "WORKFLOW_NOT_FOUND", "message": "Workflow with id
  '...' was not found" }`.

### 5. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

### Automated checks

```bash
npx vitest run tests/06-workflow-results/
# → 2 files / 9 tests passed (2 unit + 7 integration)
npm test
# → all suites green
```
