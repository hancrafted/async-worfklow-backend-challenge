import { In, type DataSource } from "typeorm";
import {
  runWorkerLoop,
  tickOnce,
  type StopSignal,
} from "../../../src/workers/taskWorker";
import { TaskStatus } from "../../../src/models/Task";
import { Task } from "../../../src/models/Task";

const DEFAULT_MAX_TICKS_PER_WORKER = 1000;

export interface DrainPoolOptions {
  workerCount: number;
  /**
   * Mints an un-initialized `DataSource` per coroutine — mirrors the
   * production worker pool seam (`startWorkerPool({ dataSourceFactory })`).
   * The coroutine takes ownership of `initialize()` / `destroy()`.
   */
  dataSourceFactory: () => DataSource;
  /**
   * Long-lived DataSource the test driver uses to seed and assert against.
   * Drives the drain detector that flips `stopSignal` when no task remains
   * `queued` or `in_progress` anywhere in the DB.
   */
  bootstrapDataSource: DataSource;
  maxTicksPerWorker?: number;
}

/**
 * Manual synchronous drain across N coroutines that mirror the production
 * worker pool. Each coroutine owns its own `DataSource` (Issue #17 Wave 1
 * per-worker isolation) so concurrent `manager.transaction(...)` calls
 * actually overlap on the substrate — no JS-level mutex, no test-only
 * serialisation. Per CLAUDE.md §Worker-loop tests: every coroutine yields
 * via the synchronous drain-detecting `sleepFn` — no `setTimeout`, no
 * `vi.useFakeTimers`.
 *
 * Returns the cumulative number of tasks executed across all workers.
 */
export async function drainPool(opts: DrainPoolOptions): Promise<number> {
  const { workerCount, dataSourceFactory, bootstrapDataSource } = opts;
  const maxTicksPerWorker = opts.maxTicksPerWorker ?? DEFAULT_MAX_TICKS_PER_WORKER;
  const stopSignal: StopSignal = { stopped: false };
  let executed = 0;

  // Drain detector: flip the shared signal only when no task is queued or
  // in_progress anywhere in the DB. Otherwise the worker resumes and
  // re-polls (a sibling is still executing or a waiter is about to be
  // promoted by a terminal commit).
  const sleepFn = async (): Promise<void> => {
    const remaining = await bootstrapDataSource.getRepository(Task).count({
      where: { status: In([TaskStatus.Queued, TaskStatus.InProgress]) },
    });
    if (remaining === 0) stopSignal.stopped = true;
  };

  const coroutines: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    coroutines.push(
      runOneCoroutine({
        workerIndex,
        dataSourceFactory,
        sleepFn,
        stopSignal,
        maxTicksPerWorker,
        onExecuted: () => {
          executed += 1;
        },
      }),
    );
  }
  await Promise.all(coroutines);
  return executed;
}

interface CoroutineOptions {
  workerIndex: number;
  dataSourceFactory: () => DataSource;
  sleepFn: () => Promise<void>;
  stopSignal: StopSignal;
  maxTicksPerWorker: number;
  onExecuted: () => void;
}

async function runOneCoroutine(options: CoroutineOptions): Promise<void> {
  const { workerIndex, dataSourceFactory, sleepFn, stopSignal, maxTicksPerWorker, onExecuted } = options;
  const dataSource = dataSourceFactory();
  await dataSource.initialize();
  try {
    const repository = dataSource.getRepository(Task);
    let perWorkerTicks = 0;
    const tickFn = async (): Promise<boolean> => {
      perWorkerTicks += 1;
      if (perWorkerTicks > maxTicksPerWorker) {
        // Flip the shared signal first so every other worker aborts on its
        // next predicate check — otherwise runWorkerLoop's transient-error
        // catch would simply log and retry.
        stopSignal.stopped = true;
        throw new Error(
          `drainPool worker ${workerIndex} exceeded maxTicksPerWorker (=${maxTicksPerWorker})`,
        );
      }
      const ran = await tickOnce(repository);
      if (ran) onExecuted();
      return ran;
    };
    await runWorkerLoop({
      tickFn,
      sleepMs: 0,
      sleepFn,
      stopSignal,
    });
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}
