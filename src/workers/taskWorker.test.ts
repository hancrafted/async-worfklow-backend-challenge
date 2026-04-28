import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource, type Repository } from "typeorm";
import {
  tickOnce,
  runWorkerLoop,
  startWorkerPool,
  resolveWorkerPoolSize,
  WorkerPoolConfigError,
  WorkerPoolConfigValidationError,
  type StopSignal,
} from "./taskWorker";
import { TaskStatus } from "./taskRunner";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow } from "../models/Workflow";
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import { LogLevel } from "../utils/logger";
import type { Job } from "../jobs/Job";

// `tickOnce` calls `getJobForTaskType` indirectly via TaskRunner. Mock the
// factory so the unit test stays self-contained and the spy job is fast.
const getJobMock = vi.hoisted(() => vi.fn());
vi.mock("../jobs/JobFactory", () => ({
  getJobForTaskType: getJobMock,
}));

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

async function seedQueuedTask(
  dataSource: DataSource,
  workflowStatus: WorkflowStatus = WorkflowStatus.Initial,
): Promise<Task> {
  const workflowRepository = dataSource.getRepository(Workflow);
  const taskRepository = dataSource.getRepository(Task);
  const workflow = await workflowRepository.save(
    Object.assign(new Workflow(), {
      clientId: "c1",
      status: workflowStatus,
    }),
  );
  return taskRepository.save(
    Object.assign(new Task(), {
      clientId: "c1",
      geoJson: "{}",
      status: TaskStatus.Queued,
      taskType: "polygonArea",
      stepNumber: 1,
      workflow,
    }),
  );
}

const noopJob: Job = {
  run: async () => ({ ok: true }),
};

describe("tickOnce — atomic-claim worker tick (PRD §10)", () => {
  let dataSource: DataSource;
  let taskRepository: Repository<Task>;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    taskRepository = dataSource.getRepository(Task);
    getJobMock.mockReset();
    getJobMock.mockReturnValue(noopJob);
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path", () => {
    it("returns true after running one queued task and transitions it to Completed", async () => {
      // Seed a single queued task, drive one tick, verify the seam returned
      // `true` and the worker drove the task to a terminal Completed state.
      const seeded = await seedQueuedTask(dataSource);

      const ran = await tickOnce(taskRepository);

      expect(ran).toBe(true);
      const refreshed = await taskRepository.findOneOrFail({
        where: { taskId: seeded.taskId },
      });
      expect(refreshed.status).toBe(TaskStatus.Completed);
    });

    it("returns false when the queue is empty", async () => {
      // Empty DB. `tickOnce` must short-circuit without sleeping (the loop in
      // `taskWorker()` is the only place that waits 5s).
      const ran = await tickOnce(taskRepository);
      expect(ran).toBe(false);
    });
  });

  describe("error path: simulated race against a single queued task", () => {
    it("under N=3 concurrent ticks against one queued task, exactly one wins (US17/US18 pool race)", async () => {
      // Three `tickOnce` calls launched in parallel against a single queued
      // task. The conditional UPDATE primitive (PRD §10) must guarantee that
      // exactly one claimer wins: results sorted = [false, false, true]. A
      // spy job counter confirms the winning task ran exactly once — proving
      // the atomic claim composes correctly under N>2 contention as the
      // worker pool wave (Wave 3 / US17 / US18) requires.
      let runCount = 0;
      const countingJob: Job = {
        run: async () => {
          runCount += 1;
          return { ok: true };
        },
      };
      getJobMock.mockReturnValue(countingJob);
      await seedQueuedTask(dataSource);

      const results = await Promise.all([
        tickOnce(taskRepository),
        tickOnce(taskRepository),
        tickOnce(taskRepository),
      ]);

      const sorted = [...results].sort();
      expect(sorted).toEqual([false, false, true]);
      expect(runCount).toBe(1);
    });
  });
});


describe("tickOnce — initial → in_progress claim bump (PRD §Decision 9, Wave 1)", () => {
  let dataSource: DataSource;
  let taskRepository: Repository<Task>;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    taskRepository = dataSource.getRepository(Task);
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path", () => {
    it("bumps the workflow from initial to in_progress in the same transaction as the claim", async () => {
      // The job inspects the workflow's status at run time. Since the bump
      // happens in the claim transaction (which commits before the job runs),
      // the observed status must already be in_progress — proving the bump
      // is wired into the claim, not deferred until post-task lifecycle.
      let observedStatus: WorkflowStatus | null = null;
      const observingJob: Job = {
        run: async ({ task }) => {
          const workflow = await dataSource.getRepository(Workflow).findOneOrFail({
            where: { workflowId: task.workflowId },
          });
          observedStatus = workflow.status;
          return { ok: true };
        },
      };
      getJobMock.mockReturnValue(observingJob);

      const seeded = await seedQueuedTask(dataSource, WorkflowStatus.Initial);

      const ran = await tickOnce(taskRepository);

      expect(ran).toBe(true);
      expect(observedStatus).toBe(WorkflowStatus.InProgress);
      // The seed is for context; the workflow row is the actual assertion target.
      expect(seeded.workflowId).toBeTruthy();
    });
  });

  describe("error path — bump is idempotent", () => {
    it("does not re-bump or downgrade a workflow whose status is no longer initial", async () => {
      // Seed the workflow already in the in_progress state (e.g. claimed
      // earlier by a peer worker). The claim's UPDATE WHERE status='initial'
      // affects 0 rows, so the workflow status must remain in_progress
      // throughout the run.
      getJobMock.mockReturnValue(noopJob);
      const seeded = await seedQueuedTask(dataSource, WorkflowStatus.InProgress);

      const ran = await tickOnce(taskRepository);
      expect(ran).toBe(true);

      // After single-task workflow runs, lifecycle takes it terminal. The
      // assertion of interest is that the claim's bump did not throw or
      // misbehave when the WHERE clause matched zero rows.
      const workflow = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: seeded.workflowId },
      });
      expect(workflow.status).not.toBe(WorkflowStatus.Initial);
    });
  });
});


interface CapturedLogLine {
  level: LogLevel;
  ts: string;
  msg: string;
  error?: { message: string; stack?: string };
}

// PRD §11 / US21 — runner-level exceptions are transient. The loop wraps
// `tickFn` in try/catch, logs at error, sleeps, and never propagates.
describe("runWorkerLoop — loop-of-last-resort (US21)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("happy path", () => {
    it("invokes tickFn until stopSignal flips and never sleeps when work was found", async () => {
      // tickFn flips the stop signal from inside its own body after one
      // successful (work-found) tick; the loop must observe the flip on its
      // next predicate check and exit without invoking sleepFn at all.
      const stopSignal: StopSignal = { stopped: false };
      const sleepFn = vi.fn(async () => {});
      const tickFn = vi.fn(async () => {
        stopSignal.stopped = true;
        return true;
      });

      await runWorkerLoop({ tickFn, sleepMs: 5000, sleepFn, stopSignal });

      expect(tickFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it("sleeps and logs warn when tickFn returns false (queue empty)", async () => {
      // Empty queue path: tickFn returns false on call 1, then flips stop on
      // call 2. The loop must invoke sleepFn between the two and emit a warn
      // JSON line with msg signalling the idle no-op.
      const stopSignal: StopSignal = { stopped: false };
      const sleepFn = vi.fn(async () => {});
      let calls = 0;
      const tickFn = vi.fn(async () => {
        calls += 1;
        if (calls >= 2) stopSignal.stopped = true;
        return false;
      });

      await runWorkerLoop({ tickFn, sleepMs: 5000, sleepFn, stopSignal });

      expect(sleepFn).toHaveBeenCalledWith(5000);
      const warnLines = logSpy.mock.calls
        .map((c) => JSON.parse(c[0] as string) as CapturedLogLine)
        .filter((l) => l.level === LogLevel.Warn);
      expect(warnLines.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("error path: runner-level exception is transient", () => {
    it("logs error, sleeps, and the second tick succeeds without propagation", async () => {
      // Call 1 throws, call 2 returns true and flips the stop signal. The
      // loop must catch the throw, emit a structured error JSON line carrying
      // the original message, sleep once, and then the resolved promise must
      // not reject — proving the worker survives a runner-level exception.
      const stopSignal: StopSignal = { stopped: false };
      const sleepFn = vi.fn(async () => {});
      let calls = 0;
      const tickFn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient db blip");
        stopSignal.stopped = true;
        return true;
      });

      await expect(
        runWorkerLoop({ tickFn, sleepMs: 5000, sleepFn, stopSignal }),
      ).resolves.toBeUndefined();

      expect(tickFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenCalledTimes(1);
      const errorLines = errorSpy.mock.calls.map(
        (c) => JSON.parse(c[0] as string) as CapturedLogLine,
      );
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatchObject({
        level: LogLevel.Error,
        error: { message: "transient db blip" },
      });
    });
  });
});


// PRD §10 / US17 / US18 — in-process worker pool. `startWorkerPool` spawns N
// `runWorkerLoop` coroutines that share one Repository and one StopSignal.
describe("startWorkerPool — N coroutines share Repository + StopSignal (US17, US18)", () => {
  let dataSource: DataSource;
  let taskRepository: Repository<Task>;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    taskRepository = dataSource.getRepository(Task);
    getJobMock.mockReset();
    getJobMock.mockReturnValue(noopJob);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path", () => {
    it("spawns size=N coroutines that share the StopSignal — all N reach sleepFn before any exits", async () => {
      // Barrier pattern: every coroutine enters sleepFn once and blocks on a
      // deferred until all N have arrived. The Nth arrival flips stopSignal
      // and releases the gate. This proves startWorkerPool actually spawned
      // N coroutines that share both the repository and the stopSignal — if
      // it only spawned 1 (or didn't share the signal), the gate would
      // deadlock and the test would time out.
      const stopSignal: StopSignal = { stopped: false };
      const POOL_SIZE = 3;
      let arrived = 0;
      let releaseGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const sleepFn = vi.fn(async () => {
        arrived += 1;
        if (arrived === POOL_SIZE) {
          stopSignal.stopped = true;
          releaseGate!();
        }
        await gate;
      });

      await startWorkerPool({
        size: POOL_SIZE,
        repository: taskRepository,
        sleepMs: 1000,
        sleepFn,
        stopSignal,
      });

      expect(sleepFn).toHaveBeenCalledTimes(POOL_SIZE);
      expect(arrived).toBe(POOL_SIZE);
    });
  });

  describe("error path: validates pool size at the boundary", () => {
    it("rejects size <= 0 with a WorkerPoolConfigValidationError", () => {
      expect(() =>
        startWorkerPool({
          size: 0,
          repository: taskRepository,
          sleepMs: 1000,
          sleepFn: async () => {},
          stopSignal: { stopped: true },
        }),
      ).toThrow(WorkerPoolConfigValidationError);
    });
  });
});

// PRD §10 — env validation for WORKER_POOL_SIZE, fail-fast at boot.
describe("resolveWorkerPoolSize — env validation (US17 boot contract)", () => {
  describe("happy path", () => {
    it("returns the default (1) when WORKER_POOL_SIZE is unset or empty", () => {
      expect(resolveWorkerPoolSize(undefined)).toBe(1);
      expect(resolveWorkerPoolSize("")).toBe(1);
    });

    it("returns the parsed positive integer when WORKER_POOL_SIZE is well-formed", () => {
      expect(resolveWorkerPoolSize("1")).toBe(1);
      expect(resolveWorkerPoolSize("5")).toBe(5);
      expect(resolveWorkerPoolSize("12")).toBe(12);
    });
  });

  describe("error path: invalid values throw WorkerPoolConfigValidationError", () => {
    it.each([
      ["0", "zero"],
      ["-1", "negative"],
      ["1.5", "non-integer"],
      ["abc", "non-numeric"],
      ["NaN", "literal NaN"],
    ])("rejects '%s' (%s) with INVALID_POOL_SIZE", (raw) => {
      let thrown: unknown;
      try {
        resolveWorkerPoolSize(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkerPoolConfigValidationError);
      expect((thrown as WorkerPoolConfigValidationError).code).toBe(
        WorkerPoolConfigError.INVALID_POOL_SIZE,
      );
    });
  });
});
