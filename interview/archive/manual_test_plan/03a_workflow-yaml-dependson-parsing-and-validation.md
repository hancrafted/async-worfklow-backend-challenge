# §Task 3a — Workflow YAML `dependsOn` parsing, validation, transactional creation

**Branch:** `strategy-pattern-refactor`
**Issue:** [#5](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/5)
**PRD:** §Task 3 (US5, US6, US7, US8)

## Setup

The `POST /analysis` route still loads `src/workflows/example_workflow.yml`.
For Task 3a manual verification, temporarily edit it to a 3-step workflow
with mixed dependencies (revert before committing):

```yaml
# src/workflows/example_workflow.yml
name: "example_workflow"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
  - taskType: "analysis"
    stepNumber: 2
    dependsOn: [1]
  - taskType: "notification"
    stepNumber: 3
    dependsOn: [1, 2]
```

```bash
npm install
npm start
# → Server is running at http://localhost:3000
```

## 1. Happy path — multi-step workflow with the right `waiting` / `queued` mix

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task-3a-happy",
    "geoJson": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    }
  }'
# → 202 { "workflowId": "<uuid>", "message": "Workflow created..." }
```

Verify in the DB:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskId, stepNumber, status, dependsOn FROM tasks ORDER BY stepNumber;"
# → step 1: status='queued',  dependsOn='[]'
# → step 2: status='waiting', dependsOn=JSON UUID array of length 1
# → step 3: status='waiting', dependsOn=JSON UUID array of length 2
sqlite3 data/database.sqlite "SELECT workflowId, status FROM workflows;"
# → status='initial'
```

> **3a scope note:** `waiting` tasks sit unrun until 3b-ii ships runtime
> promotion. After ~5s the `polygonArea` step (`queued`) completes and writes
> a `Result`; steps 2/3 stay `waiting`. That is correct for this slice.

## 2. Sad paths — invalid graphs return 400 with no DB writes

For each error path: copy a fixture YAML over the example, restart the
server (so the schema is fresh), POST, and verify the unified error shape
**plus** zero rows in `workflows` / `tasks`.

| Fixture (copy to `src/workflows/example_workflow.yml`) | Expected `error` |
| --- | --- |
| `tests/03-interdependent-tasks/fixtures/missing-step-ref.yml` | `INVALID_DEPENDENCY` — `Step 2 references non-existent step 9` |
| `tests/03-interdependent-tasks/fixtures/cycle-2-3-2.yml` | `DEPENDENCY_CYCLE` — `Cycle detected: 2 → 3 → 2` (rotation may vary) |
| `tests/03-interdependent-tasks/fixtures/self-dep.yml` | `DEPENDENCY_CYCLE` — `Cycle detected: 1 → 1` |
| `tests/03-interdependent-tasks/fixtures/duplicate-step.yml` | `INVALID_WORKFLOW_FILE` — `Duplicate stepNumber: 1` |
| `tests/03-interdependent-tasks/fixtures/missing-tasktype.yml` | `INVALID_WORKFLOW_FILE` — `Step 1 is missing taskType` |
| `tests/03-interdependent-tasks/fixtures/unknown-tasktype.yml` | `INVALID_WORKFLOW_FILE` — `Step 1 has unknown taskType 'doesNotExist'` |

```bash
cp tests/03-interdependent-tasks/fixtures/cycle-2-3-2.yml src/workflows/example_workflow.yml
# restart npm start so AppDataSource drops the schema fresh
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-task-3a-cycle",
    "geoJson": { "type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 400 { "error": "DEPENDENCY_CYCLE", "message": "Cycle detected: 2 → 3 → 2" }
sqlite3 data/database.sqlite "SELECT COUNT(*) FROM workflows;"
# → 0
sqlite3 data/database.sqlite "SELECT COUNT(*) FROM tasks;"
# → 0
```

## 3. Sad paths — request body validation (retrofitted 400s)

```bash
# missing clientId
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{ "geoJson": { "type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] } }'
# → 400 { "error": "INVALID_PAYLOAD", "message": "Request body is missing required `clientId`" }

# missing geoJson
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{ "clientId": "manual-no-geojson" }'
# → 400 { "error": "INVALID_PAYLOAD", "message": "Request body is missing required `geoJson`" }

sqlite3 data/database.sqlite "SELECT COUNT(*) FROM workflows;"  # → 0
sqlite3 data/database.sqlite "SELECT COUNT(*) FROM tasks;"      # → 0
```

## 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```
