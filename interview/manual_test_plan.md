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


---

## §Task 3b-ii Wave 1 — Lifecycle refactor + initial → in_progress claim bump

**Branch:** `promotion,-sweep,-lifecycle`
**PRD:** §Implementation Decisions 8, 9, 10 (Wave 1 of 3)

This wave delivers two structural changes; Waves 2 and 3 (promotion, dependency
envelope, fail-fast sweep, `finalResult`) follow.

1. **Lifecycle refactor.** The post-task workflow status update is now part of
   the same transaction as the terminal task write (CLAUDE.md §Transactions).
   The lifecycle helper only flips the workflow to a terminal status
   (`completed` / `failed`) when **every** task is terminal — premature
   transitions on a partial failure are gone.
2. **Claim-time workflow bump.** `tickOnce` wraps the conditional
   `UPDATE tasks SET status='in_progress' WHERE status='queued'` in a
   transaction that also issues an idempotent
   `UPDATE workflows SET status='in_progress' WHERE status='initial'`. The
   bump is naturally a no-op when the workflow has already moved past
   `initial`.

### Setup

For the first manual flow you need a **multi-step** workflow so the lifecycle
behavior is observable. Temporarily edit `src/workflows/example_workflow.yml`
to a 2-step workflow with an unmet dependency (step 2 will stay `waiting`
because Wave 2 promotion has not landed yet), then restart:

```yaml
# src/workflows/example_workflow.yml
name: "wave_1_lifecycle"
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

The worker polls every 5s; give each step that long to transition.

### 1. Happy path — claim bump fires before the workflow ever reaches terminal

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-wave1-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>", ... }
```

Immediately (< 5s, before the worker tick) check:

```bash
sqlite3 data/database.sqlite "SELECT workflowId, status FROM workflows;"
# → status='initial' (no tick has run yet)
```

Wait ~5s for one tick, then re-check:

```bash
sqlite3 data/database.sqlite "SELECT status FROM workflows;"
# → status='in_progress'
sqlite3 data/database.sqlite \
  "SELECT stepNumber, status FROM tasks ORDER BY stepNumber;"
# → step 1: completed   (job ran)
# → step 2: waiting     (Wave 2 promotion not landed yet; expected)
```

The workflow is `in_progress` even though step 2 is still `waiting` — proves
the claim transaction bumped the workflow before the job ran. The lifecycle
helper saw a non-terminal task (step 2 `waiting`) and correctly **did not**
flip the workflow to `completed`.

> **Wave 1 scope note:** the workflow stays `in_progress` indefinitely while
> step 2 sits `waiting` — promotion lands in Wave 2.

### 2. Error path — failure-last keeps lifecycle correct

The legacy bug: when the **last** terminal transition was a failure, the
workflow stayed at `in_progress` because the lifecycle update lived outside
the catch block. To exercise the fix, swap the example to a 2-step workflow
where step 1 succeeds and step 2 will fail (we use a malformed payload that
the analysis job rejects via the runner's catch path):

```yaml
# src/workflows/example_workflow.yml
name: "wave_1_failure_last"
steps:
  - taskType: "polygonArea"
    stepNumber: 1
  - taskType: "polygonArea"
    stepNumber: 2
```

> Both steps share the workflow's `geoJson`. We submit a request whose
> payload is a valid Polygon (so step 1 succeeds) but small enough that it
> trivially exercises the success path; the failure path is the unit-test
> proof of the bug fix (`src/workers/taskRunner.test.ts` →
> "marks the workflow Failed when the LAST terminal transition is a
> failure"). Run it explicitly to see the regression-guard assertion:

```bash
npx vitest run src/workers/taskRunner.test.ts \
  -t "marks the workflow Failed when the LAST terminal transition"
# → 1 passed
```

The test seeds two `queued` tasks, runs the first to `completed`, then runs
the second to `failed`. After the failure the workflow is observed as
`failed` — the assertion would have read `in_progress` against the legacy
code (lifecycle update was skipped on the throw branch).

### 3. Idempotent bump — already-in-progress workflow is left alone

This is also covered by an automated test. Run just that file:

```bash
npx vitest run src/workers/taskWorker.test.ts \
  -t "does not re-bump or downgrade a workflow whose status is no longer initial"
# → 1 passed
```

The test seeds a workflow already in `in_progress`, fires `tickOnce`, and
confirms the post-claim workflow status is **not** `initial` (the conditional
`WHERE status='initial'` UPDATE matched zero rows and the bump was a no-op).

### 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

### Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 14 files / 62 tests passed (was 57) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |


---

## §Task 3b-ii Wave 2 — Readiness promotion + dependency envelope

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

### Setup

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

### 1. Happy path — multi-step `dependsOn` runs end-to-end via promotion

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

### 2. Envelope contents — step 2 received step 1's output

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

### 3. Error path — failure on step 1 leaves step 2 unpromoted

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

### 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

### Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 16 files / 73 tests passed (was 66) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |


---

## §Task 3b-ii Wave 3 — Fail-fast sweep + `workflow.failed`

**Branch:** `promotion,-sweep,-lifecycle`
**PRD:** §Implementation Decision 2 (Wave 3 of 3)
**Issue:** [#7](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/7)

When any task transitions to `failed`, the runner sweeps every `waiting`/`queued`
sibling to `skipped` in the same post-task transaction and the lifecycle eval
closes the workflow as `failed`. `in_progress` siblings are left running (PRD
non-goal — no cancellation of in-flight jobs).

### Setup

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

### 1. Happy path — step 1 fails → step 2 swept to skipped → workflow failed

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

### 2. Error path — successful workflow is unaffected by the sweep code path

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

### 3. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

### Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 17 files / 78 tests passed (was 73) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run tests/03b-ii-Dependency/` | 3 files / 6 tests passed (Waves 1+2+3) |
