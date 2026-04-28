import { In, type Repository } from "typeorm";
import {
  runWorkerLoop,
  tickOnce,
  type StopSignal,
} from "../../../src/workers/taskWorker";
import { TaskStatus } from "../../../src/workers/taskRunner";
import type { Task } from "../../../src/models/Task";

const DEFAULT_MAX_TICKS_PER_WORKER = 1000;

/**
 * Manual synchronous drain across N coroutines that mirror the production
 * worker pool. Spawns `workerCount` `runWorkerLoop(...)` instances against the
 * shared repository and a single shared `StopSignal`.
 *
 * SQLite test substrate caveat (see `interview/design_decisions.md`
 * §Task 3c Wave 3): the in-memory test DB shares a single connection across
 * workers, and TypeORM's `manager.transaction(...)` cannot interleave
 * `BEGIN/COMMIT` on a shared connection — concurrent calls trip
 * `no such savepoint: typeorm_2` / `cannot commit - no transaction is active`.
 * To exercise the pool's coroutine surface (loop, stop signal, claim race
 * across workers) without the substrate failure, this helper serialises the
 * actual `tickOnce(...)` calls behind a per-pool promise-chain mutex. The
 * atomic-claim primitive itself is unit-tested separately
 * (`src/workers/taskWorker.claim.test.ts`); this helper proves the pool
 * topology drives a workflow to a terminal state under round-robin
 * scheduling.
 *
 * Per CLAUDE.md §Worker-loop tests: no real `setTimeout`, no
 * `vi.useFakeTimers` — every coroutine yields via the no-op `sleepFn`.
 *
 * Returns the cumulative number of tasks executed across all workers.
 */
export async function drainPool(
  repository: Repository<Task>,
  opts: { workerCount: number; maxTicksPerWorker?: number } = { workerCount: 3 },
): Promise<number> {
  const workerCount = opts.workerCount;
  const maxTicksPerWorker = opts.maxTicksPerWorker ?? DEFAULT_MAX_TICKS_PER_WORKER;
  const stopSignal: StopSignal = { stopped: false };
  let executed = 0;

  // Promise-chain mutex: each tick chains onto the previous so only one
  // tickOnce is in-flight at a time. Coroutines still compete for the next
  // slot — the loser of the queue race observes an empty queue or a lost
  // claim on the next slot it acquires.
  let mutex: Promise<void> = Promise.resolve();
  const withMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prior = mutex;
    let release: () => void = () => {};
    mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  // Shared per-worker tick wrapper — mirrors what taskWorker() builds in
  // production. Throws on per-worker tick overflow as a runaway guard.
  const buildTickFn = (workerIndex: number): (() => Promise<boolean>) => {
    let perWorkerTicks = 0;
    return async (): Promise<boolean> => {
      perWorkerTicks += 1;
      if (perWorkerTicks > maxTicksPerWorker) {
        // Flip the shared signal first so the loop's post-catch
        // `if (stopSignal.stopped) return` aborts every worker on the next
        // predicate check — otherwise runWorkerLoop's transient-error
        // catch would simply log and retry.
        stopSignal.stopped = true;
        throw new Error(
          `drainPool worker ${workerIndex} exceeded maxTicksPerWorker (=${maxTicksPerWorker})`,
        );
      }
      const ran = await withMutex(() => tickOnce(repository));
      if (ran) executed += 1;
      return ran;
    };
  };

  // Shared sleepFn: flip the stop signal only when nothing is left to do
  // anywhere in the DB — no `queued`, no `in_progress` task. Otherwise the
  // worker resumes and re-polls (a sibling is still executing or a waiter
  // is about to be promoted by a terminal commit).
  const sleepFn = async (): Promise<void> => {
    const remaining = await withMutex(() =>
      repository.count({
        where: { status: In([TaskStatus.Queued, TaskStatus.InProgress]) },
      }),
    );
    if (remaining === 0) stopSignal.stopped = true;
  };

  const coroutines: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    coroutines.push(
      runWorkerLoop({
        tickFn: buildTickFn(workerIndex),
        sleepMs: 0,
        sleepFn,
        stopSignal,
      }),
    );
  }
  await Promise.all(coroutines);
  return executed;
}
