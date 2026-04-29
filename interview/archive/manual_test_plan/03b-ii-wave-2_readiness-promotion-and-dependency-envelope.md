# §Task 3b-ii Wave 2 — Readiness promotion + dependency envelope

**Branch:** `promotion,-sweep,-lifecycle`
**PRD:** §Implementation Decisions 5, 7, 9 (Wave 2 of 3)

This wave wires `dependsOn` into actual scheduling. After every `completed`
task transition, the runner promotes any waiting sibling whose deps are all
satisfied (`waiting → queued`) inside the same post-task transaction as the
terminal write and lifecycle eval. The dependent's `JobContext` now carries
a real `dependencies[]` envelope built from upstream `Result.data`, sorted by
`stepNumber` ascending.

Wave 3 (fail-fast sweep + `finalResult`) is still pending; on a failure step 2
remains `waiting` and the workflow stays `in_progress` until then.

## Setup

Stage a 2-step `dependsOn` workflow that exercises both deliverables (step 2
depends on step 1 and receives step 1's output via the dep envelope):

```yaml
# src/workflows/example_workflow.yml
name: "wave_2_promotion_envelope"
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

The worker polls every 5s; allow ~5s per tick.

## 1. Happy path — multi-step `dependsOn` runs end-to-end via promotion

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-wave2-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Immediately:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: queued
# → step 2: waiting   (dependsOn: [step 1])
```

Wait ~5s for tick 1:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: completed
# → step 2: queued    (promoted by Wave 2 — was waiting)
sqlite3 data/database.sqlite "SELECT status FROM workflows;"
# → in_progress
```

Wait ~5s for tick 2:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: completed
# → step 2: completed
sqlite3 data/database.sqlite "SELECT status FROM workflows;"
# → completed
```

The workflow ran end-to-end via Wave 2 promotion — proves both deliverables.

## 2. Envelope contents — step 2 received step 1's output

Inspect the persisted `Result.data` rows to reconstruct what step 2's
`context.dependencies[0].output` was at runtime. The envelope is built from
the upstream `Result.data` JSON-parsed verbatim.

```bash
sqlite3 -header -column data/database.sqlite \
  "SELECT t.stepNumber, t.taskType, r.data
   FROM tasks t JOIN results r ON r.resultId = t.resultId
   ORDER BY t.stepNumber;"
# → step 1 polygonArea  {"areaSqMeters":...}   ← passed to step 2 as
#                                                context.dependencies[0].output
# → step 2 analysis     {"country":"...",...}  ← analysis's own output
```

The integration test
`tests/03b-ii-Dependency/02-promotion-envelope.test.ts` (happy path) asserts
the envelope shape (`{ stepNumber, taskType, taskId, output }`),
`stepNumber` ascending sort, and `output` fidelity against the JSON-parsed
upstream `Result.data`.

## 3. Error path — failure on step 1 leaves step 2 unpromoted

```yaml
# src/workflows/example_workflow.yml — same 2-step shape
# We trigger the failure by submitting a malformed GeoJSON so polygonArea
# rejects in its own validator (Result.error written, task → failed).
```

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-wave2-error",
    "geoJson": { "type": "NotAPolygon" }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s:

```bash
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: failed
# → step 2: waiting   (NOT promoted — promotion only fires on Completed)
sqlite3 data/database.sqlite "SELECT status FROM workflows;"
# → in_progress       (Wave 3 sweep will flip this to failed)
```

> **Wave 2 scope note:** the workflow stays `in_progress` because step 2 is
> still `waiting` (non-terminal), so the lifecycle eval sees `allTerminal=false`.
> Wave 3's fail-fast sweep flips waiting/queued siblings to `skipped` and
> closes the workflow as `failed` immediately on the first failure.

## 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 16 files / 73 tests passed (was 66) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
