import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { TaskRunner, TaskStatus } from "./taskRunner";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow } from "../models/Workflow";
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import type { Job } from "../jobs/Job";

// Module under test injects its job via `getJobForTaskType`. We mock that
// boundary so the runner unit test can install a spy job and assert the
// JobContext envelope it receives.
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

async function seedTask(dataSource: DataSource): Promise<Task> {
  const workflowRepository = dataSource.getRepository(Workflow);
  const taskRepository = dataSource.getRepository(Task);
  const workflow = await workflowRepository.save(
    Object.assign(new Workflow(), {
      clientId: "c1",
      status: WorkflowStatus.Initial,
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

describe("TaskRunner — passes JobContext to job.run (PRD §Decision 5)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path", () => {
    it("calls job.run with an object containing { task, dependencies: [] } and persists Result", async () => {
      // Spy job records its call argument. The runner must invoke
      // job.run({ task, dependencies: [] }) — task is the seeded entity,
      // dependencies is an empty array (3b-i scope: no envelope yet).
      const runArgs: unknown[] = [];
      const spyJob: Job = {
        run: async (context: unknown) => {
          runArgs.push(context);
          return { ok: true };
        },
      };
      getJobMock.mockReturnValue(spyJob);

      const task = await seedTask(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));
      await runner.run(task);

      expect(runArgs).toHaveLength(1);
      const arg = runArgs[0] as { task: Task; dependencies: unknown[] };
      expect(arg.task.taskId).toBe(task.taskId);
      expect(arg.dependencies).toEqual([]);

      const refreshed = await dataSource
        .getRepository(Task)
        .findOneOrFail({ where: { taskId: task.taskId } });
      expect(refreshed.status).toBe(TaskStatus.Completed);
    });
  });

  describe("error path", () => {
    it("when the spy job throws, marks the task Failed and rethrows", async () => {
      // The runner contract: a job throw must persist a structured
      // Result.error and surface a Failed task status. The spy throws so we
      // can verify the runner does not silently swallow the error and that
      // the new signature plumbs failures through unchanged.
      const failingJob: Job = {
        run: async () => {
          throw new Error("boom");
        },
      };
      getJobMock.mockReturnValue(failingJob);

      const task = await seedTask(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));
      await expect(runner.run(task)).rejects.toThrow(/boom/);

      const refreshed = await dataSource
        .getRepository(Task)
        .findOneOrFail({ where: { taskId: task.taskId } });
      expect(refreshed.status).toBe(TaskStatus.Failed);
      expect(refreshed.resultId).toBeTruthy();
    });
  });
});
