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
