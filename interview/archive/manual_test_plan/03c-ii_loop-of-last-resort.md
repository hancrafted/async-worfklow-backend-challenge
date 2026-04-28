# §Task 3c-ii — Wave 2 — Loop-of-last-resort + transient runner errors (US21)

**Branch:** `https-server-task-8`
**PRD:** §11 / US21 (Runner-level exceptions are transient — worker survives)

This wave wraps the worker tick body in `runWorkerLoop({ tickFn, sleepMs,
sleepFn?, stopSignal })` so any exception escaping `tickOnce` (e.g. a DB blip
inside the claim transaction) is caught, logged at `error`, followed by a
`sleepFn(sleepMs)` cool-down, and the loop continues. Empty-queue ticks emit
a `warn` JSON line and the same sleep. The existing `taskWorker()` is now a
thin wrapper that builds the loop with the production sleep and a shared
shutdown signal.

Out of scope (Wave 3): pool spawning N workers, `WORKER_POOL_SIZE` env handling,
`src/workflows/example_workflow.yml` edits.

## Loop contract recap

```ts
runWorkerLoop({ tickFn, sleepMs, sleepFn?, stopSignal })
  while (!stopSignal.stopped):
    try:
      ran = await tickFn()
      if !ran: logger.warn(...) + sleepFn(sleepMs)
    catch error:
      logger.error('runner-level exception (transient); worker continues', { error })
      sleepFn(sleepMs)
```

`sleepFn` defaults to `setTimeout(sleepMs)`; tests inject a no-op and flip
`stopSignal.stopped` from inside `tickFn` per CLAUDE.md §Worker-loop tests.

## Setup

```bash
npm install   # only on a fresh clone
npm start 2>&1 | tee /tmp/server.log
# → {"level":"info","ts":"…","msg":"server listening at http://localhost:3000"}
```

## 1. Happy path — empty queue emits warn JSON line every 5 s

With no workflows submitted, the worker is idle. Watch the log for the
periodic warn line:

```bash
sleep 12 && grep '"worker idle"' /tmp/server.log | jq .
# → {"level":"warn","ts":"…","msg":"worker idle — queue empty, sleeping"}
# → {"level":"warn","ts":"…","msg":"worker idle — queue empty, sleeping"}   # ~5 s later
```

Confirm:
- `level === "warn"` and the line is on stdout (`npm start 2>/dev/null` keeps it)
- the cadence between two adjacent lines is ≈ 5 000 ms (`POLL_INTERVAL_MS`)

## 2. Happy path — runner-level exception is transient

Submit one workflow and verify the structured `info` lines from Wave 1 are
followed by no `runner-level exception` line under normal operation:

```bash
curl -sS -X POST http://localhost:3000/analysis \
  -H 'Content-Type: application/json' \
  -d '{
    "clientId": "manual-loop-happy",
    "geoJson": { "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }
  }'
# → 202 { "workflowId": "<uuid>" }
grep '"runner-level exception"' /tmp/server.log
# → (no output — only Wave 1 info / warn lines)
```

## 3. Error path — induced DB error is caught, logged, and the worker survives

Wave 2 is exercised end-to-end by the integration test `R3 — runner: runner-level
exceptions are transient (US21)` in
`tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts`.
That test stubs `dataSource.manager.transaction` to reject once with
`"transient db blip in claim"`, drives `runWorkerLoop` over a real seeded
task, and asserts:

1. the loop emits a structured error JSON line
   `{ level: "error", msg: "runner-level exception (transient); worker
   continues", error: { message: "transient db blip in claim", stack: "..." } }`
2. the loop does **not** propagate the exception (the returned promise resolves)
3. the next iteration drains the seeded task to `Completed`

Manually reproducing a DB blip on a running server is brittle (it requires
SIGSTOPing sqlite mid-write). Instead, replay the integration test by name:

```bash
npx vitest run \
  tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts \
  -t "runner-level exceptions are transient"
# → 2 tests passed (happy + error path)
```

Confirm in the streamed Vitest output that the test prints (or asserts) the
structured error JSON line and the task is `Completed` after the second tick.

## 4. Layering invariant — a job exception is NOT a runner-level exception

The same describe block contains a layering test: PolygonAreaJob throws on a
`Point` payload, `TaskRunner` catches it, persists `Failed`, and `tickOnce`
returns normally. The `runWorkerLoop` catch handler must therefore never see
this error (only `"job failed"` from Wave 1 appears, never `"runner-level
exception"`).

## 5. Automated coverage

```bash
npx vitest run src/workers/taskWorker.test.ts \
  -t "runWorkerLoop — loop-of-last-resort"
# → 3 tests passed (happy ×2 + error path ×1)

npx vitest run \
  tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts \
  -t "runner-level exceptions are transient"
# → 2 tests passed
```

## Observed results (2026-04-28, automated run)

| Check | Result |
| --- | --- |
| `npm test` | 18 files / 90 tests passed (was 85) |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
