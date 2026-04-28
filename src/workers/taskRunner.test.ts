import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { TaskRunner, TaskStatus } from "./taskRunner";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow } from "../models/Workflow";
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import type { Job, JobContext } from "../jobs/Job";

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
    it("closes the workflow Failed when a failure leaves a sibling still queued (Wave 3 sweep)", async () => {
      // Wave 3 fail-fast sweep flips the queued sibling to Skipped in the
      // same post-task transaction; the lifecycle eval then sees allTerminal
      // && anyFailed and writes workflow.status = Failed. Regression guard
      // for the legacy bug where the lifecycle update sat outside the catch
      // block (failure-on-first-task left the workflow stuck at in_progress).
      getJobMock.mockReturnValue({
        run: () => Promise.reject(new Error("boom")),
      });
      const { workflow, tasks } = await seedTwoTaskWorkflow(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await expect(runner.run(tasks[0])).rejects.toThrow(/boom/);

      const after = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(after.status).toBe(WorkflowStatus.Failed);
      const refreshedSibling = await dataSource.getRepository(Task).findOneOrFail({
        where: { taskId: tasks[1].taskId },
      });
      expect(refreshedSibling.status).toBe(TaskStatus.Skipped);
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
// Wave 2: readiness promotion (waiting → queued) fires inside the post-task
// transaction, but only on Completed transitions (PRD §Decision 9). The unit
// tests below seed parent + child tasks directly so the promotion logic is
// exercised in isolation from WorkflowFactory.
async function seedParentChildPair(
  dataSource: DataSource,
  parentStatus: TaskStatus = TaskStatus.Queued,
): Promise<{ workflow: Workflow; parent: Task; child: Task }> {
  const workflowRepository = dataSource.getRepository(Workflow);
  const taskRepository = dataSource.getRepository(Task);
  const workflow = await workflowRepository.save(
    Object.assign(new Workflow(), {
      clientId: "c1",
      status: WorkflowStatus.Initial,
    }),
  );
  const parent = await taskRepository.save(
    Object.assign(new Task(), {
      clientId: "c1",
      geoJson: "{}",
      status: parentStatus,
      taskType: "polygonArea",
      stepNumber: 1,
      dependsOn: [],
      workflow,
    }),
  );
  const child = await taskRepository.save(
    Object.assign(new Task(), {
      clientId: "c1",
      geoJson: "{}",
      status: TaskStatus.Waiting,
      taskType: "analysis",
      stepNumber: 2,
      dependsOn: [parent.taskId],
      workflow,
    }),
  );
  return { workflow, parent, child };
}

describe("TaskRunner — Wave 2 readiness promotion (waiting → queued)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path — promotion fires only when the parent transition is Completed", () => {
    it("promotes a waiting child whose sole dependency just completed", async () => {
      // Seed parent (queued) + child (waiting, depends on parent). Run parent
      // with a successful job. Expectation: post-transaction the child has
      // moved waiting → queued because every dep is now Completed.
      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const { parent, child } = await seedParentChildPair(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await runner.run(parent);

      const refreshedChild = await dataSource
        .getRepository(Task)
        .findOneOrFail({ where: { taskId: child.taskId } });
      expect(refreshedChild.status).toBe(TaskStatus.Queued);
    });

    it("does NOT promote when the parent transition is Failed (Wave 3 sweeps to Skipped instead)", async () => {
      // Promotion is gated on outcome.status === Completed (PRD §Decision 9):
      // a failing parent must NOT promote the child to Queued. Wave 3's
      // fail-fast sweep flips the waiter to Skipped instead — proving in one
      // shot that promotion did not fire AND that sweep handled the failure.
      getJobMock.mockReturnValue({
        run: () => Promise.reject(new Error("boom")),
      });
      const { parent, child } = await seedParentChildPair(dataSource);
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await expect(runner.run(parent)).rejects.toThrow(/boom/);

      const refreshedChild = await dataSource
        .getRepository(Task)
        .findOneOrFail({ where: { taskId: child.taskId } });
      expect(refreshedChild.status).toBe(TaskStatus.Skipped);
    });
  });

  describe("error path — partial dependency completion does not promote", () => {
    it("keeps a multi-dep child waiting until every parent is Completed", async () => {
      // Seed two parents + one child that depends on BOTH. Run parent A; the
      // child must stay waiting because parent B is still queued. Then run
      // parent B; now both deps are Completed and the child promotes.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.Initial,
        }),
      );
      const parentA = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "polygonArea",
          stepNumber: 1,
          dependsOn: [],
          workflow,
        }),
      );
      const parentB = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "polygonArea",
          stepNumber: 2,
          dependsOn: [],
          workflow,
        }),
      );
      const child = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Waiting,
          taskType: "analysis",
          stepNumber: 3,
          dependsOn: [parentA.taskId, parentB.taskId],
          workflow,
        }),
      );

      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const runner = new TaskRunner(dataSource.getRepository(Task));

      await runner.run(parentA);
      const afterA = await taskRepository.findOneOrFail({
        where: { taskId: child.taskId },
      });
      expect(afterA.status).toBe(TaskStatus.Waiting);

      await runner.run(parentB);
      const afterB = await taskRepository.findOneOrFail({
        where: { taskId: child.taskId },
      });
      expect(afterB.status).toBe(TaskStatus.Queued);
    });
  });
});

// Wave 2: dependency envelope builder. The runner replaces the hardcoded
// `dependencies: []` with `{ stepNumber, taskType, taskId, output }` per
// upstream Result, sorted by stepNumber ASC, with a guard for missing rows.
describe("TaskRunner — Wave 2 dependency envelope builder", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path — envelope shape + ascending stepNumber sort", () => {
    it("sorts dependencies by stepNumber ASC and parses output from Result.data", async () => {
      // Seed two completed parents in REVERSE stepNumber order (parent at
      // step 2 inserted first, parent at step 1 second). Each parent has a
      // persisted Result row whose `data` is JSON-stringified. The runner
      // must return the envelope sorted by stepNumber ASC and parse each
      // upstream Result.data back into the `output` field.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const resultRepository = dataSource.getRepository(Result);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.InProgress,
        }),
      );
      const parentTwo = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Completed,
          taskType: "analysis",
          stepNumber: 2,
          dependsOn: [],
          workflow,
        }),
      );
      const parentOne = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Completed,
          taskType: "polygonArea",
          stepNumber: 1,
          dependsOn: [],
          workflow,
        }),
      );
      const resultTwo = await resultRepository.save(
        Object.assign(new Result(), {
          taskId: parentTwo.taskId,
          data: JSON.stringify({ analysed: true }),
        }),
      );
      parentTwo.resultId = resultTwo.resultId;
      await taskRepository.save(parentTwo);
      const resultOne = await resultRepository.save(
        Object.assign(new Result(), {
          taskId: parentOne.taskId,
          data: JSON.stringify({ areaSqMeters: 42 }),
        }),
      );
      parentOne.resultId = resultOne.resultId;
      await taskRepository.save(parentOne);

      const child = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "notification",
          stepNumber: 3,
          dependsOn: [parentTwo.taskId, parentOne.taskId],
          workflow,
        }),
      );

      const captured: JobContext[] = [];
      const spyJob: Job = {
        run: (context) => {
          captured.push(context);
          return Promise.resolve({ sent: true });
        },
      };
      getJobMock.mockReturnValue(spyJob);

      const runner = new TaskRunner(dataSource.getRepository(Task));
      await runner.run(child);

      expect(captured).toHaveLength(1);
      expect(captured[0].dependencies).toEqual([
        {
          stepNumber: 1,
          taskType: "polygonArea",
          taskId: parentOne.taskId,
          output: { areaSqMeters: 42 },
        },
        {
          stepNumber: 2,
          taskType: "analysis",
          taskId: parentTwo.taskId,
          output: { analysed: true },
        },
      ]);
    });
  });

  describe("error path — missing upstream Result throws and fails the task", () => {
    it("throws a descriptive Error when a declared dependency has no Result row", async () => {
      // Seed parent in Completed state but DELIBERATELY skip its Result row.
      // This is the defence-in-depth guard: under normal operation promotion
      // only fires after the parent's Result is persisted, but the runner
      // must still throw a clear error if invoked on a malformed state.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.InProgress,
        }),
      );
      const parent = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Completed,
          taskType: "polygonArea",
          stepNumber: 1,
          dependsOn: [],
          workflow,
        }),
      );
      const child = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1",
          geoJson: "{}",
          status: TaskStatus.Queued,
          taskType: "analysis",
          stepNumber: 2,
          dependsOn: [parent.taskId],
          workflow,
        }),
      );

      // The job spy never runs because the envelope builder throws first;
      // the runner's normal failure path catches and persists Result.error.
      getJobMock.mockReturnValue({
        run: () => Promise.resolve({ ok: true }),
      });
      const runner = new TaskRunner(dataSource.getRepository(Task));
      await expect(runner.run(child)).rejects.toThrow(
        new RegExp(`${parent.taskId}|stepNumber 1`),
      );

      const refreshedChild = await dataSource
        .getRepository(Task)
        .findOneOrFail({ where: { taskId: child.taskId } });
      expect(refreshedChild.status).toBe(TaskStatus.Failed);
    });
  });
});

describe("TaskRunner — Wave 3 fail-fast sweep (PRD §Decision 2)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    getJobMock.mockReset();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path — sweep flips both Waiting and Queued siblings to Skipped on Failed", () => {
    it("sweeps every Waiting and Queued sibling when the parent transition is Failed", async () => {
      // Seed parent (queued) + sibling A (waiting, depends on parent) +
      // sibling B (queued, no deps). When the parent fails, the sweep must
      // flip BOTH siblings to skipped — not just the dep-linked waiter — and
      // the workflow must transition to Failed.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.Initial,
        }),
      );
      const parent = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Queued,
          taskType: "polygonArea", stepNumber: 1, dependsOn: [], workflow,
        }),
      );
      const waitingSibling = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Waiting,
          taskType: "analysis", stepNumber: 2, dependsOn: [parent.taskId], workflow,
        }),
      );
      const queuedSibling = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Queued,
          taskType: "notification", stepNumber: 3, dependsOn: [], workflow,
        }),
      );

      getJobMock.mockReturnValue({
        run: () => Promise.reject(new Error("boom")),
      });
      const runner = new TaskRunner(taskRepository);
      await expect(runner.run(parent)).rejects.toThrow(/boom/);

      const refreshedWaiting = await taskRepository.findOneOrFail({
        where: { taskId: waitingSibling.taskId },
      });
      const refreshedQueued = await taskRepository.findOneOrFail({
        where: { taskId: queuedSibling.taskId },
      });
      expect(refreshedWaiting.status).toBe(TaskStatus.Skipped);
      expect(refreshedQueued.status).toBe(TaskStatus.Skipped);

      const refreshedWorkflow = await workflowRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshedWorkflow.status).toBe(WorkflowStatus.Failed);
    });
  });

  describe("error path — sweep is gated and respects in_progress siblings", () => {
    it("does NOT sweep when the parent transition is Completed (sweep gates on Failed only)", async () => {
      // Symmetric with promotion's "only on Completed" rule. Seed parent
      // (queued) + sibling (queued, no deps). Parent succeeds → sweep must
      // NOT fire; the sibling stays Queued and the workflow stays
      // non-terminal (sibling is still queued).
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.Initial,
        }),
      );
      const parent = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Queued,
          taskType: "polygonArea", stepNumber: 1, dependsOn: [], workflow,
        }),
      );
      const sibling = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Queued,
          taskType: "polygonArea", stepNumber: 2, dependsOn: [], workflow,
        }),
      );

      getJobMock.mockReturnValue({ run: () => Promise.resolve({ ok: true }) });
      const runner = new TaskRunner(taskRepository);
      await runner.run(parent);

      const refreshedSibling = await taskRepository.findOneOrFail({
        where: { taskId: sibling.taskId },
      });
      expect(refreshedSibling.status).toBe(TaskStatus.Queued);
    });

    it("leaves in_progress siblings untouched when the parent transition is Failed", async () => {
      // Seed parent (queued) + an in_progress sibling (simulating a worker
      // pool where another worker is mid-job). Parent fails. The sweep must
      // NOT touch the in_progress sibling (PRD non-goal: no cancellation of
      // in-flight jobs). The workflow stays non-terminal until the in_progress
      // sibling lands and re-fires the lifecycle eval.
      const workflowRepository = dataSource.getRepository(Workflow);
      const taskRepository = dataSource.getRepository(Task);
      const workflow = await workflowRepository.save(
        Object.assign(new Workflow(), {
          clientId: "c1",
          status: WorkflowStatus.InProgress,
        }),
      );
      const parent = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.Queued,
          taskType: "polygonArea", stepNumber: 1, dependsOn: [], workflow,
        }),
      );
      const inProgressSibling = await taskRepository.save(
        Object.assign(new Task(), {
          clientId: "c1", geoJson: "{}", status: TaskStatus.InProgress,
          taskType: "polygonArea", stepNumber: 2, dependsOn: [], workflow,
        }),
      );

      getJobMock.mockReturnValue({
        run: () => Promise.reject(new Error("boom")),
      });
      const runner = new TaskRunner(taskRepository);
      await expect(runner.run(parent)).rejects.toThrow(/boom/);

      const refreshedSibling = await taskRepository.findOneOrFail({
        where: { taskId: inProgressSibling.taskId },
      });
      expect(refreshedSibling.status).toBe(TaskStatus.InProgress);

      const refreshedWorkflow = await workflowRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      // allTerminal=false because the in_progress sibling is non-terminal;
      // workflow stays in_progress until the sibling lands.
      expect(refreshedWorkflow.status).toBe(WorkflowStatus.InProgress);
    });
  });
});

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
