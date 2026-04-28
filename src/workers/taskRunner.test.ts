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

// Two-task workflow seed for lifecycle tests. Both tasks start `Queued`; the
// caller drives them through `TaskRunner.run(...)` one at a time so the test
// can observe the workflow status between terminal transitions.
async function seedTwoTaskWorkflow(
  dataSource: DataSource,
): Promise<{ workflow: Workflow; tasks: Task[] }> {
  const workflowRepository = dataSource.getRepository(Workflow);
  const taskRepository = dataSource.getRepository(Task);
  const workflow = await workflowRepository.save(
    Object.assign(new Workflow(), {
      clientId: "c1",
      status: WorkflowStatus.Initial,
    }),
  );
  const tasks: Task[] = [];
  for (let stepNumber = 1; stepNumber <= 2; stepNumber++) {
    const task = await taskRepository.save(
      Object.assign(new Task(), {
        clientId: "c1",
        geoJson: "{}",
        status: TaskStatus.Queued,
        taskType: "polygonArea",
        stepNumber,
        workflow,
      }),
    );
    tasks.push(task);
  }
  return { workflow, tasks };
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


describe("TaskRunner — workflow lifecycle (PRD §Decision 8 + §9, Wave 1)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path — workflow stays non-terminal until every task is terminal", () => {
    it("does not flip the workflow to Completed while a sibling task is still non-terminal", async () => {
      // Two queued tasks; finish one. The lifecycle helper must NOT mark the
      // workflow Completed yet — sibling is still queued (non-terminal).
      // Then finish the second; lifecycle observes allTerminal && !anyFailed
      // and transitions the workflow to Completed in the same transaction.
      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const { workflow, tasks } = await seedTwoTaskWorkflow(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await runner.run(tasks[0]);

      const intermediate = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(intermediate.status).not.toBe(WorkflowStatus.Completed);
      expect(intermediate.status).not.toBe(WorkflowStatus.Failed);

      await runner.run(tasks[1]);

      const terminal = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(terminal.status).toBe(WorkflowStatus.Completed);
    });
  });

  describe("error path — failure does not prematurely mark the workflow Failed", () => {
    it("keeps the workflow non-terminal when a failure leaves a sibling still queued", async () => {
      // Wave 1 has no fail-fast sweep yet (Wave 3). With one failed task and
      // one still queued, allTerminal === false → workflow must stay
      // non-terminal. This covers the bug where the legacy lifecycle code
      // skipped the workflow update entirely on the throw path.
      getJobMock.mockReturnValue({
        run: () => Promise.reject(new Error("boom")),
      });
      const { workflow, tasks } = await seedTwoTaskWorkflow(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await expect(runner.run(tasks[0])).rejects.toThrow(/boom/);

      const after = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(after.status).not.toBe(WorkflowStatus.Failed);
      expect(after.status).not.toBe(WorkflowStatus.Completed);
    });

    it("marks the workflow Failed when the LAST terminal transition is a failure", async () => {
      // Sequence: task[0] succeeds, task[1] fails (failure is LAST). The
      // legacy lifecycle update sat outside the catch block, so a final
      // failure left the workflow stuck at in_progress. The Wave 1 refactor
      // moves the lifecycle eval into the terminal transaction so it runs on
      // both branches; the workflow correctly observes anyFailed and
      // transitions to Failed.
      const { workflow, tasks } = await seedTwoTaskWorkflow(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      getJobMock.mockReturnValueOnce({
        run: () => Promise.resolve({ ok: true }),
      });
      await runner.run(tasks[0]);

      getJobMock.mockReturnValueOnce({
        run: () => Promise.reject(new Error("boom")),
      });
      await expect(runner.run(tasks[1])).rejects.toThrow(/boom/);

      const terminal = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(terminal.status).toBe(WorkflowStatus.Failed);
    });
  });
});

// Defence-in-depth guard: once a workflow has reached a terminal status
// (Completed / Failed) the lifecycle helper must not re-evaluate or flip it.
// Each seed below stages a workflow whose persisted status would be flipped
// to the OPPOSITE terminal value if the guard were missing — proving the
// short-circuit by observing that the persisted status does not change.
describe("TaskRunner — terminal-workflow short-circuit (defence-in-depth)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path — already-Completed workflow stays Completed", () => {
    it("does not flip workflow.status to Failed when a sibling task is already Failed", async () => {
      // Stage: workflow.status = Completed (already terminal); siblings are
      // [Failed, Queued]. Run the queued task with a successful job → it
      // becomes Completed. Without the guard, lifecycle would observe
      // allTerminal && anyFailed and flip the workflow to Failed. With the
      // guard the lifecycle helper short-circuits before evaluating tasks.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.Completed,
        }),
      );
      await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Failed,
          taskType: "polygonArea",
          stepNumber: 1,
          workflow,
        }),
      );
      const queued = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "polygonArea",
          stepNumber: 2,
          workflow,
        }),
      );

      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const runner = new TaskRunner(dataSource.getRepository(Task));
      await runner.run(queued);

      const after = await workflowRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(after.status).toBe(WorkflowStatus.Completed);
    });
  });

  describe("error path — already-Failed workflow stays Failed", () => {
    it("does not flip workflow.status to Completed when remaining tasks succeed", async () => {
      // Stage: workflow.status = Failed (already terminal); siblings are
      // [Completed, Queued]. Run the queued task with a successful job → it
      // becomes Completed. Without the guard, lifecycle would observe
      // allTerminal && !anyFailed and flip the workflow to Completed. With
      // the guard the workflow stays Failed.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.Failed,
        }),
      );
      await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Completed,
          taskType: "polygonArea",
          stepNumber: 1,
          workflow,
        }),
      );
      const queued = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "polygonArea",
          stepNumber: 2,
          workflow,
        }),
      );

      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const runner = new TaskRunner(dataSource.getRepository(Task));
      await runner.run(queued);

      const after = await workflowRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(after.status).toBe(WorkflowStatus.Failed);
    });
  });
});
