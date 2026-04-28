# Issue #17 Wave 1 — Per-worker DataSources + WAL (production fix)

Production worker pool with `WORKER_POOL_SIZE=2+` previously hung with
`TransactionNotStartedError` because every coroutine in `startWorkerPool`
shared one `AppDataSource` (one underlying SQLite connection). Wave 1 makes
each coroutine build its own `DataSource` via a factory, and enables SQLite
WAL + a 5s `busy_timeout` per connection. This plan walks through verifying
the production boot path end-to-end.

## Prerequisites

- Node + npm installed; deps installed (`npm install`).
- A clean working tree: `rm -rf data/database.sqlite`.

## 1. Automated proof — reproduction test

```sh
npx vitest run tests/17-per-worker-datasources/
```

Expected: 2 passing tests in
`tests/17-per-worker-datasources/per-worker-data-sources-production.test.ts`.
The happy path drains a 7-step DAG (the same topology as
`src/workflows/example_workflow.yml`, plus `reportGeneration` at step 7) with
`N=2` per-worker DataSources and asserts no `TransactionNotStartedError` was
ever logged. The error path asserts `startWorkerPool` rejects calls that
omit both `repository` and `dataSourceFactory`.

## 2. Boot the server with N=2 and observe a clean drain

```sh
WORKER_POOL_SIZE=2 npm run dev
```

In another shell, POST a workflow against the production example
(`src/workflows/example_workflow.yml`):

```sh
curl -s -X POST http://localhost:3000/analysis \
  -H 'content-type: application/json' \
  -d '{
    "clientId": "manual-issue-17",
    "geoJson": {
      "type": "Polygon",
      "coordinates": [[[0,0],[1,0],[1,1],[0,1],[0,0]]]
    }
  }'
```

Expected log signature (JSON-line logger):

- One `starting worker pool (size=2)` line.
- 7 `starting job` / `job completed` pairs (steps 1 → 7) interleaved across
  two coroutines.
- A final `workflow finished` style log (or, for `reportGeneration`, a
  `report finished` log per the job).
- **No** `TransactionNotStartedError` and **no** `SQLITE_BUSY` errors.

## 3. Verify WAL is actually enabled

While the server is running (or against a freshly-booted DB):

```sh
sqlite3 data/database.sqlite 'PRAGMA journal_mode; PRAGMA busy_timeout;'
```

Expected output:

```
wal
5000
```

(Each per-worker DataSource also runs these two pragmas via TypeORM's
`enableWAL` / `busyTimeout` options on first connection — this is the
documented fallback for `extra.afterCreateConnection`, since the sqlite3
driver has no `prepareDatabase` hook.)

## 4. Graceful shutdown smoke

With the dev server still running:

1. Hit `Ctrl+C` (or `kill -SIGTERM <pid>`).
2. Observe a single
   `shutdown signal received — flipping worker pool stop signal` log.
3. Observe a `worker pool drained — exiting` log before the process exits
   with code 0.

If any task is in-flight at the moment of `Ctrl+C`, it should still drain
to a terminal state before the process exits — the stop signal only
prevents *new* claims, not in-flight work.

## 5. Sanity: full test suite

```sh
npm test
```

Expected: 109 passing tests (including the 2 new ones).

## 6. Lint + typecheck

```sh
npx eslint .
npx tsc --noEmit -p tsconfig.json
```

Expected: zero lint errors, zero `tsc` errors under `src/`.

## Files of interest

- `src/data-source.ts` — `buildAppDataSource`, `buildWorkerDataSource`,
  WAL + 5s `busy_timeout`.
- `src/workers/taskWorker.ts` — `startWorkerPool` accepts
  `dataSourceFactory`, each coroutine owns its own `DataSource` lifecycle.
- `src/index.ts` — production boot wiring + `SIGINT`/`SIGTERM` handlers.
- `src/workflows/example_workflow.yml` — 7 steps incl. `reportGeneration`.

## Out of scope (Waves 2 & 3)

- `drainPool.ts` orchestration (Wave 2).
- `EmailNotificationJob` 500 ms artificial delay (Wave 3).
