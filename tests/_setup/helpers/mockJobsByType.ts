import { vi } from "vitest";
import type { Job } from "../../../src/jobs/Job";

/**
 * Hoisted registry that backs the `JobFactory` mock. Created via
 * `vi.hoisted` so the binding exists before the test's `vi.mock(...)` call
 * is hoisted, matching the pattern in `src/workers/taskRunner.test.ts:14-17`.
 */
const registry = vi.hoisted(() => ({
  jobsByType: null as Record<string, Job> | null,
}));

/**
 * Registers the per-task-type job map. Tests call this in `beforeEach` (or
 * in the `it` body, before any drain) to wire up the spy jobs they need.
 */
export function setMockJobsByType(jobsByType: Record<string, Job>): void {
  registry.jobsByType = jobsByType;
}

/**
 * Mock factory passed as the second argument to
 * `vi.mock("../../../src/jobs/JobFactory", jobFactoryMockImpl)`. Returns a
 * shape compatible with the real `JobFactory` module, where
 * `getJobForTaskType` looks up the registry and throws loudly if the test
 * forgot to register a mock for the requested task type.
 */
export function jobFactoryMockImpl(): { getJobForTaskType: (taskType: string) => Job } {
  return {
    getJobForTaskType(taskType: string): Job {
      if (registry.jobsByType === null) {
        throw new Error(
          "mockJobsByType: setMockJobsByType() must be called before any task runs",
        );
      }
      const job = registry.jobsByType[taskType];
      if (!job) {
        throw new Error(
          `mockJobsByType: no job registered for taskType "${taskType}"`,
        );
      }
      return job;
    },
  };
}
