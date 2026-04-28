# §Task 3b-ii Wave 3 — Fail-fast sweep + `workflow.failed`

**Branch:** `promotion,-sweep,-lifecycle`
**PRD:** §Implementation Decision 2 (Wave 3 of 3)
**Issue:** [#7](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/7)

When any task transitions to `failed`, the runner sweeps every `waiting`/`queued`
sibling to `skipped` in the same post-task transaction and the lifecycle eval
closes the workflow as `failed`. `in_progress` siblings are left running (PRD
non-goal — no cancellation of in-flight jobs).

## Setup

Stage the same 2-step `dependsOn` workflow as Wave 2; the failure path is
exercised by submitting a malformed GeoJSON that the first step's validator
rejects:

```yaml
# src/workflows/example_workflow.yml
name: "wave_3_fail_fast"
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

## 1. Happy path — step 1 fails → step 2 swept to skipped → workflow failed

Submit a malformed payload (`type: "NotAPolygon"`) so `PolygonAreaJob`'s
validator throws and the runner enters the Failed branch:

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-wave3-happy",
    "geoJson": { "type": "NotAPolygon" }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s, then verify in the DB:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: failed
# → step 2: skipped   (Wave 3 sweep — was waiting before the tick)
sqlite3 data/database.sqlite "SELECT status FROM workflows;"
# → failed            (Wave 3 lifecycle eval flipped this in the same txn)
```

The persisted state proves all three: sweep flipped the waiter to `skipped`,
the lifecycle eval observed `allTerminal && anyFailed`, and the workflow
transitioned to `failed` — all inside the post-task transaction.

Inspect the failed step's persisted error envelope:

```bash
sqlite3 data/database.sqlite \
  "SELECT data, error FROM results WHERE resultId IN (
     SELECT resultId FROM tasks WHERE clientId='manual-wave3-happy' AND status='failed'
   );"
# → data = (NULL)
# → error = '{"message":"Invalid GeoJSON: ...","reason":"job_error","stack":"..."}'
```

`skipped` tasks have no `Result` row — the status itself is the explanation
(PRD §Decision 2). Confirm:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskId, resultId FROM tasks WHERE clientId='manual-wave3-happy' AND status='skipped';"
# → resultId = (NULL)
```

## 2. Error path — successful workflow is unaffected by the sweep code path

Re-submit a valid GeoJSON to confirm the Completed branch is untouched (sweep
only fires on Failed):

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-wave3-control",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
```

Wait ~10s (two ticks), then:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks WHERE clientId='manual-wave3-control'
   ORDER BY stepNumber;"
# → step 1: completed
# → step 2: completed
sqlite3 data/database.sqlite \
  "SELECT status FROM workflows
   WHERE workflowId IN (SELECT workflowId FROM tasks WHERE clientId='manual-wave3-control');"
# → completed
```

The `in_progress`-sibling-survives-the-sweep behavior is covered by the unit
test `src/workers/taskRunner.test.ts` →
"leaves in_progress siblings untouched when the parent transition is Failed":

```bash
npx vitest run src/workers/taskRunner.test.ts \
  -t "leaves in_progress siblings untouched"
# → 1 passed
```

## 3. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 17 files / 78 tests passed (was 73) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run tests/03b-ii-Dependency/` | 3 files / 6 tests passed (Waves 1+2+3) |
