import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource, type Repository } from "typeorm";
import { tickOnce, runWorkerLoop, type StopSignal } from "./taskWorker";
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
    it("under concurrent ticks against one queued task, exactly one wins", async () => {
      // Two `tickOnce` calls launched in parallel against a single queued
      // task. The conditional UPDATE primitive (PRD §10) must guarantee that
      // exactly one claimer wins: results sorted = [false, true]. The loser
      // sees `affected === 0`, retries the candidate query, finds no queued
      // work, and returns false.
      await seedQueuedTask(dataSource);

      const results = await Promise.all([
        tickOnce(taskRepository),
        tickOnce(taskRepository),
      ]);

      const sorted = [...results].sort();
      expect(sorted).toEqual([false, true]);
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
