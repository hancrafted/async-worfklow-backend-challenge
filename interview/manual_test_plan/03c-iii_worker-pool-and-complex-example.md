# §Task 3c-iii — Wave 3 — In-process worker pool + complex example workflow (US17, US18, US20)

**Branch:** `https-server-task-8`
**PRD:** §10 / US17 (worker pool), US18 (atomic claim race), US20 (per-worker isolation)

This wave wires `startWorkerPool({ size, repository, sleepMs, sleepFn?, stopSignal })`
into `src/index.ts`, honours `WORKER_POOL_SIZE` (default `1` — see
`interview/design_decisions.md` §Task 7 / Issue #17 for the SQLite concurrency
ceiling that pins it; raise via `WORKER_POOL_SIZE=N` to exercise the
atomic-claim race), and updates `src/workflows/example_workflow.yml` to a
6-step DAG that exercises the new runtime end-to-end (parallel roots, fan-in,
dependency chaining).

## Pool contract recap

```ts
startWorkerPool({ size, repository, sleepMs, sleepFn?, stopSignal })
  spawn N runWorkerLoop({ tickFn: () => tickOnce(repository), … }) coroutines
  share one Repository + one StopSignal
  validate size > 0 → throw WorkerPoolConfigValidationError(INVALID_POOL_SIZE)
```

`resolveWorkerPoolSize(rawValue)` parses `process.env.WORKER_POOL_SIZE`:
`undefined` / `""` → default `1` (`DEFAULT_WORKER_POOL_SIZE`); anything else
must be a positive integer. Boot-time invalid values log + `process.exit(1)`.

## Example workflow DAG

```yaml
# src/workflows/example_workflow.yml
steps:
  1: polygonArea
  2: polygonArea
  3: analysis      [deps: 1]
  4: analysis      [deps: 2]
  5: notification  [deps: 3, 4]
  6: notification  [deps: 5]
```

Steps 1+2 are deps-free roots → both `queued` at insert; with the manual
override `WORKER_POOL_SIZE=3` two workers race for them concurrently (the
substrate caveat from §Task 7 / Issue #17 applies — concurrent transactions
on the shared SQLite connection can trip `SQLITE_ERROR: no such savepoint`,
the same way the integration tests serialise via `drainPool`'s mutex). Steps
3+4 promote in parallel after their respective polygonArea completes. Step 5
fans in (deps: 3+4). Step 6 chains the final notification.

## Setup

```bash
npm install   # only on a fresh clone
npm start 2>&1 | tee /tmp/server.log
# → {"level":"info","ts":"…","msg":"starting worker pool (size=1)"}
# → {"level":"info","ts":"…","msg":"server listening at http://localhost:3000"}

# Optional: raise to exercise the atomic-claim race manually (substrate caveat
# from §Task 7 applies — see interview/design_decisions.md and Issue #17).
WORKER_POOL_SIZE=3 npm start 2>&1 | tee /tmp/server.log
# → {"level":"info","ts":"…","msg":"starting worker pool (size=3)"}
```

## 1. Happy path — pool drains the 6-step DAG

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-pool-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>" }

WID=<uuid-from-above>
sleep 2 && curl -sS http://localhost:3000/workflow/$WID/status | jq .
# → { "status": "completed", "totalTasks": 6, "completedTasks": 6, "tasks": [ … ] }
```

Confirm in `/tmp/server.log` that the two `polygonArea` `"starting job"` lines
for steps 1 and 2 are interleaved (not strictly sequential) — proof that the
pool is actually using more than one coroutine:

```bash
grep '"starting job"' /tmp/server.log | jq -r '"\(.ts) step=\(.stepNumber)"'
```

## 2. Happy path — `WORKER_POOL_SIZE` override

```bash
WORKER_POOL_SIZE=5 npm start 2>&1 | head -2
# → {"level":"info","ts":"…","msg":"starting worker pool (size=5)"}
```

## 3. Error path — invalid `WORKER_POOL_SIZE` exits non-zero

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
  -t "startWorkerPool"
# → 3 tests passed (happy ×2 + size-validation error path)

npx vitest run src/workers/taskWorker.test.ts \
  -t "resolveWorkerPoolSize"
# → 6 tests passed (default, override, invalid values)

npx vitest run \
  tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts \
  -t "pool"
# → 4 tests passed (atomic claim race ×2 + per-worker isolation ×2)
```

The integration tests use the `drainPool(...)` helper at
`tests/03-interdependent-tasks/helpers/drainPool.ts` — a manual synchronous
drain over N `runWorkerLoop(...)` coroutines. Per CLAUDE.md §Worker-loop
tests, the helper uses no real timers and no `vi.useFakeTimers()`. See
`interview/design_decisions.md` §Task 3c Wave 3 for the SQLite test-substrate
caveat (transactions are serialised by a per-pool promise-chain mutex
because the in-memory connection cannot host concurrent `BEGIN/COMMIT`).

## 5. Layering invariant — pool does NOT change atomic-claim semantics

The atomic-claim primitive (`UPDATE … WHERE status='queued'` with
`affected === 1`) is independent of pool size. The race-against-N test
(`tickOnce — error path: simulated race against a single queued task` in
`src/workers/taskWorker.test.ts`) asserts exactly one of N concurrent claims
wins, regardless of how many workers are spawned in production.

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 18 files / 103 tests passed |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
