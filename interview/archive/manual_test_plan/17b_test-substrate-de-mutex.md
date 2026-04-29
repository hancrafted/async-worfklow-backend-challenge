# Issue #17 Wave 2 — Test substrate de-mutex + overlap proof

Wave 1 introduced per-worker `DataSource`s for the production pool but the
integration helper `tests/03-interdependent-tasks/helpers/drainPool.ts`
still serialised every `tickOnce(...)` behind a JS-level promise-chain
mutex (and the unit-level N=3 race test in `src/workers/taskWorker.test.ts`
still ran 3 concurrent `tickOnce` calls against one shared `:memory:`
connection — flaky on `SQLITE_ERROR: no such savepoint: typeorm_2`). Wave 2
removes both: each integration coroutine and each racer in the unit-level
N=3 test owns its own `DataSource` against a shared file-backed SQLite
substrate (WAL on, 5 s `busy_timeout`), mirroring production. A new test
asserts wall-clock concurrency to pin the substrate honestly.

## Prerequisites

- Node + npm installed; deps installed (`npm install`).

## 1. Automated proofs

```sh
# (a) Wall-clock overlap proof — Wave 2's substrate honesty test.
npx vitest run tests/17-per-worker-datasources/per-worker-data-sources-overlap.test.ts

# (b) Pre-existing pool tests, now de-mutexed and faster.
npx vitest run tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts

# (c) Wave 1 production reproduction — must stay green.
npx vitest run tests/17-per-worker-datasources/per-worker-data-sources-production.test.ts

# (d) Full suite + lint + typecheck.
npm test
npm run lint
npm run typecheck
```

Expected:

- (a) — 2 passing tests. The happy path measures total wall-clock time of
  draining `WORKFLOW_COUNT=3` independent single-step workflows whose jobs
  each sleep `JOB_SLEEP_MS=200ms`. Asserts `elapsed < 0.7 × (3 × 200ms) = 420ms`.
  Serial execution would take 600 ms; observed wall-clock is in the
  ~250 – 380 ms range — the 0.7 ratio is the overlap proof.
- (b) — 17 passing tests. The 3 pool describes (`R3 — pool: …`) now run
  noticeably faster than before Wave 2 (the isolation test alone dropped
  from ~1 050 ms to ~530 ms — true coroutine concurrency).
- (c) — 2 passing tests. Wave 1's contract still holds.
- (d) — full suite green, no lint warnings, no type errors.

## 2. Flake-check the unit-level N=3 race

The N=3 race test in `src/workers/taskWorker.test.ts` was previously
flaky on the shared `:memory:` substrate (~28 / 50 iterations failed with
`SQLITE_ERROR: no such savepoint: typeorm_2`). Wave 2 migrates each racer
to its own `DataSource` against a shared file-backed SQLite, so the test
must now pass deterministically.

```sh
fails=0
for i in $(seq 1 50); do
  npx vitest run src/workers/taskWorker.test.ts >/tmp/race-$i.log 2>&1 \
    || { fails=$((fails+1)); echo "FAIL $i"; }
done
echo "Failures: $fails / 50"
rm -f /tmp/race-*.log
```

Expected: `Failures: 0 / 50`. (Note: Vitest 2.1 has no `--repeat` CLI flag;
the shell loop is the substitute.)

## 3. Inspect the de-mutexed helper

```sh
sed -n '1,40p' tests/03-interdependent-tasks/helpers/drainPool.ts
```

Expected highlights:

- The helper signature is now
  `drainPool({ workerCount, dataSourceFactory, bootstrapDataSource, maxTicksPerWorker? })`.
- No `withMutex` / promise-chain mutex anywhere in the file.
- Each coroutine `await dataSource.initialize()` then runs the loop and
  destroys its `DataSource` on exit.

## What this does NOT cover (Wave 3 scope)

- `DEFAULT_WORKER_POOL_SIZE` is still 1 — Wave 3 will raise it now that
  per-worker DataSources + this overlap proof are landed.
- `EmailNotificationJob`'s 500 ms artificial latency stays at 500 ms.
- The narrative writeup in `interview/design_decisions.md` for Issue #17
  is Wave 3 scope.

## Files of interest

- `tests/03-interdependent-tasks/helpers/drainPool.ts` — mutex removed,
  per-worker DataSources via `dataSourceFactory`.
- `tests/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts`
  — the 3 `R3 — pool: …` describes use a file-backed SQLite substrate
  via `buildPoolSubstrate()` and call the new `drainPool({...})` API.
- `src/workers/taskWorker.test.ts` — the N=3 race test now mints 3
  per-call `DataSource`s against a shared file-backed DB.
- `tests/17-per-worker-datasources/per-worker-data-sources-overlap.test.ts`
  — new wall-clock concurrency proof (happy path + one-shot-blip error path).
- `tests/17-per-worker-datasources/fixtures/single-step.yml` — single-step
  fixture for the overlap test (independent workflows, no cross-deps).
