# §Task 4 — Workflow `finalResult` synthesis with eager write

**Branch:** `tasks-4-6-sequential-delivery`
**PRD:** §Implementation Decision 8, US4, US14, US15, US16, US23
**Issue:** [#9](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/9)

Every workflow now persists a denormalized framework-synthesized
`finalResult` snapshot on its terminal transition. The post-task transaction
synthesizes the payload, strips `error.stack`, and writes it together with
the workflow's terminal status (`completed` / `failed`) under a single
conditional UPDATE guarded by `WHERE finalResult IS NULL`.

> **Interim verification.** The `/results` HTTP endpoint that returns this
> column lands in §Task 6 (#11). Until then, this test plan inspects
> `Workflow.finalResult` directly via SQLite.
>
> **Update (Task 6 shipped):** the SQLite inspection below remains a valid
> low-level check, but the canonical end-to-end verification of the column
> is now `GET /workflow/:id/results` — see
> [`06_workflow-results-endpoint.md`](./06_workflow-results-endpoint.md).

## Setup

Use the shipped `src/workflows/example_workflow.yml` for the happy path; the
6-step DAG drives all four task types to terminal `completed` and produces a
non-empty `finalResult`. For the failure path, temporarily edit it to a
2-step chain whose first step gets a malformed GeoJSON:

```yaml
# src/workflows/example_workflow.yml — TEMPORARY for the failure flow
name: "task_4_failure_chain"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
  - taskType: "analysis"
    stepNumber: 2
    dependsOn: [1]
```

```bash
npm install   # only on a fresh clone
npm start
# → Server is running at http://localhost:3000
```

The worker polls every 5s.

## 1. Happy path — completed workflow has a synthesized finalResult

Submit a valid GeoJSON against the shipped 6-step workflow:

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task4-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait until every step lands (≈30s for the 6-step DAG with the 5s poll), then
inspect `workflows.finalResult`:

```bash
sqlite3 data/database.sqlite \
  "SELECT status, finalResult FROM workflows
   WHERE workflowId IN (SELECT workflowId FROM tasks WHERE clientId='manual-task4-happy');"
# → status     = completed
# → finalResult= '{"workflowId":"...","tasks":[...]}'
```

Pretty-print the column to verify the contract:

```bash
sqlite3 data/database.sqlite \
  "SELECT finalResult FROM workflows
   WHERE workflowId IN (SELECT workflowId FROM tasks WHERE clientId='manual-task4-happy');" \
  | jq .
```

Confirm:

- `workflowId` matches the workflow row.
- `tasks` is sorted by `stepNumber` ascending.
- Every entry has `status: "completed"` with an `output` object — none has `error`.
- `failedAtStep` is **absent** entirely (US15 — omitted on success).
- The blob contains no `taskId` field (US16 — internal UUIDs do not leak).

## 2. Error path — failed workflow surfaces failedAtStep + per-task error (no stack)

Edit `src/workflows/example_workflow.yml` to the 2-step chain in §Setup,
then restart `npm start`. Submit a payload whose first step's validator
rejects:

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task4-fail",
    "geoJson": { "type": "NotAPolygon" }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s, then:

```bash
sqlite3 data/database.sqlite \
  "SELECT status, finalResult FROM workflows
   WHERE workflowId IN (SELECT workflowId FROM tasks WHERE clientId='manual-task4-fail');" \
  | head -c 4000
# → status     = failed
# → finalResult= '{"workflowId":"...","failedAtStep":1,"tasks":[
#       {"stepNumber":1,"taskType":"polygonArea","status":"failed",
#        "error":{"message":"Invalid GeoJSON: ...","reason":"job_error"}},
#       {"stepNumber":2,"taskType":"analysis","status":"skipped"}]}'
```

Verify:

- `failedAtStep` is `1` — the lowest failing `stepNumber` (US15).
- The failed entry's `error` carries `{ message, reason }` only — **no `stack`**.
- The skipped entry has neither `output` nor `error`.

Cross-check that `Result.error` still keeps its `stack` for debugging (US23 —
the strip is only on the public `finalResult` column, not on `Result.error`):

```bash
sqlite3 data/database.sqlite \
  "SELECT error FROM results WHERE resultId IN (
     SELECT resultId FROM tasks WHERE clientId='manual-task4-fail' AND status='failed'
   );"
# → '{"message":"Invalid GeoJSON: ...","reason":"job_error","stack":"Error: ...\n  at ..."}'
```

## 3. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

## Automated checks

```bash
npx vitest run tests/04-final-result/
# → 2 files / 5 tests passed (1 unit + 1 integration with 3 it cases)
npm test
# → all suites green
```
