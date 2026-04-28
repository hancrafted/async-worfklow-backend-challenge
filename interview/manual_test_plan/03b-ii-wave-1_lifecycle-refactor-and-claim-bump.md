# §Task 3b-ii Wave 1 — Lifecycle refactor + initial → in_progress claim bump

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

## Setup

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

## 1. Happy path — claim bump fires before the workflow ever reaches terminal

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

## 2. Error path — failure-last keeps lifecycle correct

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

## 3. Idempotent bump — already-in-progress workflow is left alone

This is also covered by an automated test. Run just that file:

```bash
npx vitest run src/workers/taskWorker.test.ts \
  -t "does not re-bump or downgrade a workflow whose status is no longer initial"
# → 1 passed
```

The test seeds a workflow already in `in_progress`, fires `tickOnce`, and
confirms the post-claim workflow status is **not** `initial` (the conditional
`WHERE status='initial'` UPDATE matched zero rows and the bump was a no-op).

## 4. Cleanup

```bash
git checkout -- src/workflows/example_workflow.yml
```

`AppDataSource` boots with `dropSchema: true`, so every restart wipes the DB.

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 14 files / 62 tests passed (was 57) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
