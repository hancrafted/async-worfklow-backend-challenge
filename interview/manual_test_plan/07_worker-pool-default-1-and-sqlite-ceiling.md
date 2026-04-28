# §Task 7 — Default `WORKER_POOL_SIZE=1` + SQLite concurrency ceiling

**Branch:** `fix/worker-pool-default-1`
**Design decision:** [`interview/design_decisions.md`](../design_decisions.md) §Task 7
**Cross-link:** Issue [#17](https://github.com/hancrafted/async-worfklow-backend-challenge/issues/17) (per-worker DataSources — lifts the ceiling)

This task drops the shipped `DEFAULT_WORKER_POOL_SIZE` from `3` to `1`. The
production runtime shares one `AppDataSource` (= one SQLite connection)
across every worker coroutine spawned by `startWorkerPool(...)`; concurrent
`manager.transaction(...)` calls on that shared connection trip
`SQLITE_ERROR: no such savepoint`. Pinning the default at 1 means the shipped
configuration matches what the substrate can host. Multi-worker concurrency
is still available via the explicit `WORKER_POOL_SIZE=N` override (with the
same caveat the integration tests document via `drainPool`'s mutex).

## 1. Happy path — default boot logs `size=1`

```bash
npm install   # only on a fresh clone
npm start 2>&1 | head -3
# → {"level":"info","ts":"…","msg":"starting worker pool (size=1)"}
# → {"level":"info","ts":"…","msg":"server listening at http://localhost:3000"}
```

A single worker drains every `queued` task. The 6-step `example_workflow.yml`
DAG still terminates correctly — atomic-claim semantics are independent of
pool size.

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{ "clientId": "manual-task-7-default",
        "geoJson": { "type": "Polygon",
          "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] } }'
# → 202 { "workflowId": "<uuid>" }

WID=<uuid-from-above>
sleep 3 && curl -sS http://localhost:3000/workflow/$WID/status | jq .status
# → "completed"
```

## 2. Happy path — explicit override raises pool size

```bash
WORKER_POOL_SIZE=3 npm start 2>&1 | head -1
# → {"level":"info","ts":"…","msg":"starting worker pool (size=3)"}
```

The override is fully supported. With N>1 against the shared `AppDataSource`,
genuinely concurrent `manager.transaction(...)` calls *can* trip
`SQLITE_ERROR: no such savepoint: typeorm_1` (substrate caveat — see
§Task 7 in `interview/design_decisions.md`). The override is therefore a
manual / reviewer-only knob until Issue #17 lands per-worker DataSources.

## 3. Error path — invalid override exits non-zero (unchanged from Wave 3)

```bash
WORKER_POOL_SIZE=0 npm start
# → {"level":"error","ts":"…","msg":"worker pool configuration invalid",
#     "error":{"message":"WORKER_POOL_SIZE must be a positive integer, received: '0'"}}
echo $?
# → 1

WORKER_POOL_SIZE=not-a-number npm start
# → {"level":"error","ts":"…","msg":"worker pool configuration invalid",
#     "error":{"message":"WORKER_POOL_SIZE must be a positive integer, received: 'not-a-number'"}}
echo $?
# → 1
```

## 4. Automated coverage

```bash
npx vitest run src/workers/taskWorker.test.ts \
  -t "resolveWorkerPoolSize"
# → 6 tests passed (default `(1)` + override + invalid values)
```

The unit-level race test (`tickOnce — error path: simulated race against a
single queued task`) and the integration tests in
`tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts`
that exercise the pool with `N=3` (`startWorkerPool({ size: 3, ... })`) pass
explicit `size`/iteration counts and continue to assert atomic-claim
correctness at N>1 — they do not depend on `DEFAULT_WORKER_POOL_SIZE`.

```bash
npm test
# → all suites pass
npm run lint
# → exit 0
```

## 5. Lift conditions

The default lifts back to N>1 when Issue #17 lands per-worker `DataSource`
instances (per-worker SQLite connection or move to Postgres). At that point:

- `interview/design_decisions.md` §Task 7 is updated to record the lift.
- `DEFAULT_WORKER_POOL_SIZE` returns to a value in the documented sweet spot
  (likely `3`, matching the original Task 3c Wave 3 rationale).
- `drainPool(...)`'s per-pool mutex disappears.
- `EmailNotificationJob`'s 500ms latency cap is decoupled from the test
  ceiling.

## Observed results (2026-04-28)

| Check | Result |
| --- | --- |
| `npm test` | 18 files / 103 tests passed (one re-run for the documented Issue #17 flake on `tickOnce — error path: simulated race against a single queued task`) |
| `npm run lint` | exit 0 |
| `npx tsc --noEmit -p tsconfig.eslint.json` | exit 0 |
