import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource, type Repository } from "typeorm";
import { tickOnce } from "./taskWorker";
import { TaskStatus } from "./taskRunner";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow } from "../models/Workflow";
import { WorkflowStatus } from "../workflows/WorkflowFactory";
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
