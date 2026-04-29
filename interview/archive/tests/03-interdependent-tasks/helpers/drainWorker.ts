import type { Repository } from "typeorm";
import { tickOnce } from "../../../src/workers/taskWorker";
import type { Task } from "../../../src/models/Task";

const DEFAULT_MAX_TICKS = 50;

/**
 * Manual synchronous drain over `tickOnce(...)`. Calls it until it returns
 * `false` (queue empty) and reports the number of tasks executed. Bounds
 * runaway loops in a buggy state-machine via `maxTicks` (default 50): if the
 * tick count overflows, throws `Error('drainWorker exceeded maxTicks (=N)')`.
 *
 * Per CLAUDE.md §Worker-loop tests: never use `setTimeout` or `vi.useFakeTimers`
 * to drive the worker — this helper is the single seam tests use.
 */
export async function drainWorker(
  repository: Repository<Task>,
  opts: { maxTicks?: number } = {},
): Promise<number> {
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;
  let ranCount = 0;
  while (true) {
    const ran = await tickOnce(repository);
    if (!ran) return ranCount;
    ranCount++;
    if (ranCount > maxTicks) {
      throw new Error(`drainWorker exceeded maxTicks (=${maxTicks})`);
    }
  }
}
