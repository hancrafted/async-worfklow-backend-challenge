# Manual Test Plan

Per-task, step-by-step instructions to manually verify each implemented task. One section per task.

---

## §Task 0 — Test Harness & Quality Gates

**Branch:** `task-0-quality-gates`
**Issue:** [#1](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/1)
**PRD:** §Task 0

### Setup

```bash
npm install
```

### 1. Static checks and tests are green on a clean tree

```bash
npm run lint       # → exit 0, no errors
npm run typecheck  # → exit 0, no errors
npm test           # → exit 0, 1 passing test (tests/smoke.test.ts)
```

**Expected:** all three commands exit 0.

### 2. `pre-commit` hook blocks a deliberate lint error

```bash
echo 'export const x: any = 1' > src/_bad.ts
git add src/_bad.ts
git commit -m "chore: should fail lint"
```

**Expected:** non-zero exit; commit aborted. Output includes:

```
✖ eslint --fix --max-warnings=0:
  src/_bad.ts
    1:17  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
husky - pre-commit script failed (code 1)
```

**Cleanup:**

```bash
git restore --staged src/_bad.ts && rm src/_bad.ts
```

### 3. `pre-commit` hook is a no-op for doc-only commits

```bash
echo "# test doc" > _doc_test.md
git add _doc_test.md
git commit -m "docs: doc-only commit test"
```

**Expected:** commit succeeds and lint-staged emits:

```
→ lint-staged could not find any staged files matching configured tasks.
```

No `eslint`, `tsc`, or `vitest` invocation appears in the output.

**Cleanup:**

```bash
git reset --soft HEAD~1
git restore --staged _doc_test.md
rm _doc_test.md
```

### 4. `pre-push` hook blocks a failing test

Direct invocation of the hook script (equivalent to what `git push` runs, since
Husky 9 sets `git config core.hooksPath` to `.husky/_` and that wrapper
delegates to `.husky/pre-push`):

```bash
cat > tests/_failing.test.ts <<'EOF'
import { describe, it, expect } from "vitest";
describe("deliberately failing", () => {
  it("fails on purpose to exercise pre-push", () => {
    expect(1).toBe(2);
  });
});
EOF
bash .husky/pre-push
echo "exit=$?"
```

**Expected:** `exit=1`; output ends with `Test Files  1 failed | 1 passed (2)`.

**Cleanup:**

```bash
rm tests/_failing.test.ts
```

### 5. The workspace `agentCommit` API also respects the hooks

In a workspace MCP context (Intent), invoke:

```js
await ws.file.write("src/_agent_bad.ts", "export const y: any = 3\n");
await ws.git.agentCommit("chore: agent commit test (should be blocked)", {
  files: ["src/_agent_bad.ts"],
  userRequested: true,
});
```

**Expected:** the call rejects with an error whose message starts with
`Failed to commit: Pre-commit hooks failed: ...` — confirming that
`agentCommit` cannot bypass the pre-commit gate. Verified empirically on
2026-04-27 against this repo.

**Cleanup:**

```bash
rm -f src/_agent_bad.ts
git restore --staged src/_agent_bad.ts 2>/dev/null || true
```

### 6. The hook contract is one-way

`--no-verify` is forbidden by `CLAUDE.md`. There is no supported path for an
agent or developer to bypass the hooks in this repo. If a hook reports a real
failure, fix the code; if it reports an environmental issue, surface it to the
parent agent.

### Observed results (2026-04-27, empirical run)

| Check | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0, 1 passing test |
| `git commit` of `src/_bad.ts` (any-typed) | blocked, exit 1, no commit created |
| `git commit` of `_doc_test.md` only | succeeds, lint-staged skipped expensive checks |
| `bash .husky/pre-push` with failing test in tree | exit 1 |
| `ws.git.agentCommit` with bad lint via `ws.file.write` | rejected with `Failed to commit: Pre-commit hooks failed: ...` |

---

## §Task 1 — PolygonAreaJob

**Branch:** `task-1-polygonareajob`
**Issue:** [#2](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/2)
**PRD:** §Task 1 (US1, US2, US20)

### Setup

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

### 1. Happy path — valid GeoJSON polygon

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

### 2. Sad path — malformed GeoJSON

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

### 3. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.
Revert any edits to `src/workflows/example_workflow.yml` before committing:

```bash
git checkout -- src/workflows/example_workflow.yml
```

---

## §Task 3a — Workflow YAML `dependsOn` parsing, validation, transactional creation

**Branch:** `strategy-pattern-refactor`
**Issue:** [#5](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/5)
**PRD:** §Task 3 (US5, US6, US7, US8)

### Setup

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

### 1. Happy path — multi-step workflow with the right `waiting` / `queued` mix

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

### 2. Sad paths — invalid graphs return 400 with no DB writes

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

### 3. Sad paths — request body validation (retrofitted 400s)

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

### 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

---

## §Task 3b-i — Migrate `Job.run` to the `JobContext` signature

**Branch:** `migrate-job.run-to-jobcontext`
**Issue:** [#6](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/6)
**PRD:** §Implementation Decision 5

### Setup

This task is a pure signature migration — no observable behavior change. The
shipped `src/workflows/example_workflow.yml` (single `analysis` step, no
`dependsOn`) is the right fixture for the smoke test; do not edit it.

```bash
npm install   # only on a fresh clone
npm start
# → Server is running at http://localhost:3000
```

The worker polls the queue every 5s; give the step that long to transition.

### 1. Single-step workflow still runs end-to-end after the migration

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

### 2. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.
Nothing to revert — `example_workflow.yml` is left unchanged by this task.

---

## §Pre-#7 — Worker infrastructure prelude

**Branch:** `frozen-bass`
**PRD:** §Implementation Decisions 9, 10
**Spec:** [Pre-#7 worker infrastructure (A1 + A2 + A4)](intent://local/task/56508807-7ef0-4b70-b28c-48b26e122086)

This task lays the structural seams (`tickOnce`, atomic-claim primitive,
`Task.workflowId` join column) that Issue #7 will hook into. There are no
user-visible behavior changes — the worker still runs one queued task per
5s tick. The verification below proves the seams exist and the schema
rename landed.

### Setup

```bash
npm install   # only on a fresh clone
```

### 1. Schema — `Task.workflowId` is a real column

Boot the server (the live worker isn't needed for this check; the schema is
created during `AppDataSource.initialize`):

```bash
npm start   # leave it running long enough for "Server is running…" to print, then Ctrl-C
```

Inspect the SQLite schema:

```bash
sqlite3 data/database.sqlite ".schema tasks" | tr ',' '\n'
```

**Expected:** the output contains a `workflowId` column and **does not**
contain `workflowWorkflowId`. Example excerpt:

```
"workflowId" varchar NOT NULL
CONSTRAINT "FK_…" FOREIGN KEY ("workflowId") REFERENCES "workflows" ("workflowId")
```

### 2. Live worker still drives a workflow end-to-end

The shipped `src/workflows/example_workflow.yml` (single `analysis` step)
is the right fixture; do not edit it.

```bash
npm start
# → Server is running at http://localhost:3000
```

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-pre-7",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Wait ~5s, then:

```bash
sqlite3 data/database.sqlite \
  "SELECT taskType, status, workflowId FROM tasks WHERE clientId='manual-pre-7';"
# → analysis | completed | <same uuid as the response>
```

The `workflowId` column is populated and matches the workflow returned by
the API — proves both the schema rename and the relation are wired
correctly (DOD: `task.workflowId === task.workflow.workflowId`).

### 3. Atomic-claim primitive — covered by automated tests

The race semantics are exercised by `src/workers/taskWorker.test.ts`
("under concurrent ticks against one queued task, exactly one wins"). Run
just that file to verify locally:

```bash
npx vitest run src/workers/taskWorker.test.ts
# → 3 passed (returns true after running, returns false on empty queue,
#            atomic claim under simulated race)
```

A manual two-process race against the SQLite file is intentionally not
documented here — the in-process unit test is the canonical verification
for PRD §10 in this scope (single-process worker today, race-safe primitive
for the worker pool tomorrow per `interview/no-lease-and-heartbeat.md`).

### 4. Cleanup

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the
DB. Nothing to revert.

---

## §Pre-#7 — Shared test helpers

**Branch:** `frozen-bass`
**Spec:** `intent://local/note/spec` — Pre-#7 hardenings (A5)
**Wave:** 3 of 3 (after A1+A2+A4 worker infra and D1+D5 CLAUDE.md)

### What this task adds

Three reusable Vitest helpers under `tests/03-interdependent-tasks/helpers/`
for #7's upcoming integration tests:

- `drainWorker(repository, { maxTicks? })` — manual synchronous drain over
  `tickOnce(...)`; returns the number of tasks executed; throws
  `drainWorker exceeded maxTicks (=N)` once the cap is exceeded (default 50).
- `seedWorkflow(dataSource, fixtureFileName, { clientId?, geoJson? })` —
  thin wrapper over `WorkflowFactory.createWorkflowFromYAML(...)` for files
  in `tests/03-interdependent-tasks/fixtures/`; returns
  `{ workflow, tasks }`.
- `mockJobsByType.ts` exports `setMockJobsByType(jobsByType)` and
  `jobFactoryMockImpl()` — wires `vi.mock("../../../src/jobs/JobFactory")`
  to a `Record<taskType, Job>` registry; throws if a test asks for a
  `taskType` that isn't registered.

Smoke coverage lives in
`tests/03-interdependent-tasks/helpers/helpers.unit.test.ts`: it seeds the
existing `three-step-mixed-deps.yml` fixture, mocks the deps-free step's
job, drains, and asserts `ranCount === 1` plus the expected
completed/waiting status mix. The error describe covers `drainWorker`'s
`maxTicks` overflow and `mockJobsByType`'s missing-type throw.

### How to verify locally

```bash
# All three helpers exist and the smoke test passes
npx vitest run tests/03-interdependent-tasks/helpers/helpers.unit.test.ts
# → 3 passed (1 happy path + 2 error paths)

# Full repo green
npm test         # → 57 passed
npm run lint     # → 0 errors
npm run typecheck
```

The helpers are intentionally **not** used in production code or in
existing #7 test files (#7 itself will adopt them).

### Cleanup

Helpers are pure test-only modules; nothing to revert beyond `git revert`
of the commit if needed.

