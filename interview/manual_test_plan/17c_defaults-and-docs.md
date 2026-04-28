# Issue #17 Wave 3 — Restore default pool size + EmailNotification latency + docs cleanup

Verifies that with the per-worker DataSources from Wave 1 + the de-mutexed test
substrate from Wave 2, the production defaults restore to the original Task 3c
Wave 3 numbers (`DEFAULT_WORKER_POOL_SIZE = 3`, notification latency = 1000 ms)
and that `interview/design_decisions.md` reflects the resolved state.

## Prerequisites

```sh
nvm use         # Node 22 (per .nvmrc)
npm install
```

## 1. Confirm `DEFAULT_WORKER_POOL_SIZE` is 3

```sh
grep -n "DEFAULT_WORKER_POOL_SIZE" src/workers/taskWorker.ts
```

Expected: one definition line — `export const DEFAULT_WORKER_POOL_SIZE = 3;`.

```sh
npx vitest run src/workers/taskWorker.test.ts -t "returns the default"
```

Expected: 1 passed — the test asserts `resolveWorkerPoolSize(undefined)` and
`resolveWorkerPoolSize("")` both equal `3`.

## 2. Confirm boot honors the default

```sh
WORKER_POOL_SIZE= npx ts-node src/index.ts &
SERVER_PID=$!
sleep 1
# Look for the structured-logger line; the resolved size must be 3.
# (CTRL-C / kill once you have the line.)
kill $SERVER_PID 2>/dev/null
```

Expected: a stdout JSON line of the form
`{ "level":"info", "msg":"starting worker pool (size=3)", ... }`.

Override path:

```sh
WORKER_POOL_SIZE=5 npx ts-node src/index.ts &
SERVER_PID=$!
sleep 1
kill $SERVER_PID 2>/dev/null
```

Expected: `... "msg":"starting worker pool (size=5)" ...`.

## 3. Confirm `EmailNotificationJob` simulated latency ≥ 1000 ms

```sh
grep -n "setTimeout" src/jobs/EmailNotificationJob.ts
```

Expected: one match — `await new Promise(resolve => setTimeout(resolve, 1000));`.

```sh
npx vitest run src/jobs/EmailNotificationJob.test.ts
```

Expected: 3 passed. The new test
`simulates at least 1000ms of work (Issue #17 Wave 3 latency contract)` is the
floor pin.

## 4. End-to-end: notification-heavy DAG drains under the new defaults

```sh
npx vitest run \
  tests/17-per-worker-datasources/per-worker-data-sources-production.test.ts
```

Expected: 2 passed. The 7-step DAG (4 notifications + analysis + polygonArea +
reportGeneration) drains end-to-end through the production boot path
(`startWorkerPool` + `buildWorkerDataSource`) and the `TransactionNotStartedError`
/ `no such savepoint` regex search yields zero hits in stderr.

## 5. Confirm the docs updates landed

```sh
grep -n "RESOLVED by Issue #17" interview/design_decisions.md
grep -n "Issue #17 — Per-worker DataSources + WAL" interview/design_decisions.md
grep -n "Resolved by Issue #17" interview/design_decisions.md
```

Expected:
- `RESOLVED by Issue #17` — one match (the §Task 7 banner).
- `Issue #17 — Per-worker DataSources + WAL` — one match (the new entry header at end of file).
- `Resolved by Issue #17` — two matches: one in the §Task 3c Wave 3 drainPool-mutex bullet, one in the §Task 3c Wave 3 EmailNotification latency bullet.

```sh
grep -n "drainPool" interview/design_decisions.md | grep -v "Resolved\|Historical\|drainPool(...)' mutex\|drainPool(...)' per-pool mutex\|drainPool.ts"
```

Expected: zero lines of stale "use the drainPool mutex because shared
connection" text — only resolved-marker references and the §Task 7 historical
audit-trail entry remain.

## 6. Full suite + lint + typecheck (the verifier-equivalent gate)

```sh
npm test
npm run lint
npm run typecheck
```

Expected: all green. After Wave 3 the test count is 112 (Wave 2 was 111).

## 7. Working tree

```sh
git status
```

Expected: clean except for the user's `src/workflows/complex_workflow.yml`
edits (out of scope per the Wave 3 task spec).
