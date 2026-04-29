import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow, WorkflowStatus } from "../models/Workflow";
import { TaskStatus } from "../models/Task";
import {
  applyLazyFinalResultPatch,
  translateDependsOnToStepNumbers,
} from "./workflowRoutes";

// Merged co-located unit tests for the pure helpers exposed by
// `workflowRoutes`. Two top-level groupings preserve the original /tests/
// unit suites' coverage:
//   1. translateDependsOnToStepNumbers — pure helper (Task 5, US16)
//   2. applyLazyFinalResultPatch       — pure helper (Task 6, lazy patch)

// Builds a Task fixture with the minimum fields the translator reads
// (taskId + stepNumber). Other columns are populated with placeholders so the
// shape compiles against the real entity.
const makeTask = (taskId: string, stepNumber: number, dependsOn: string[] = []): Task => {
  const task = new Task();
  task.taskId = taskId;
  task.stepNumber = stepNumber;
  task.dependsOn = dependsOn;
  task.clientId = "test-client";
  task.geoJson = "{}";
  task.taskType = "polygonArea";
  task.status = TaskStatus.Queued;
  task.workflowId = "workflow-id";
  return task;
};

describe("translateDependsOnToStepNumbers — pure helper (Task 5, US16)", () => {
  describe("happy path: maps stored dependsOn taskIds to stepNumbers", () => {
    it("returns [] when the task has no dependencies", () => {
      const task = makeTask("a", 1, []);
      expect(translateDependsOnToStepNumbers(task, [task])).toEqual([]);
    });

    it("translates a single-dep array to a single stepNumber", () => {
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, ["a"]);
      expect(translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo])).toEqual([1]);
    });

    it("translates a multi-dep array preserving the stored taskId order", () => {
      // Insertion order from YAML is the source of truth — the translator
      // must NOT sort. The route handler decides whether downstream callers
      // see the order.
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, []);
      const stepThree = makeTask("c", 3, []);
      const stepFour = makeTask("d", 4, ["c", "a", "b"]);
      const allTasks = [stepOne, stepTwo, stepThree, stepFour];
      expect(translateDependsOnToStepNumbers(stepFour, allTasks)).toEqual([3, 1, 2]);
    });

    it("does not include any taskId in its output (US16 — UUIDs never leak)", () => {
      const stepOne = makeTask("uuid-one", 1, []);
      const stepTwo = makeTask("uuid-two", 2, ["uuid-one"]);
      const result = translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo]);
      for (const value of result) expect(typeof value).toBe("number");
    });
  });

  describe("error path: throws when an upstream taskId is missing from the workflow", () => {
    it("throws Error mentioning the orphan taskId so the operator can debug", () => {
      // Defence-in-depth: the persistence path guarantees every dependsOn
      // taskId exists in the same workflow's tasks. A miss is an invariant
      // violation (DB corruption, manual SQL surgery), not a user error.
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, ["nonexistent-uuid"]);
      expect(() =>
        translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo]),
      ).toThrowError(/nonexistent-uuid/);
    });
  });
});

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

async function seedTerminalCompletedWorkflow(
  dataSource: DataSource,
  finalResult: string | null,
): Promise<{ workflow: Workflow; tasks: Task[] }> {
  // Persists a workflow + a single completed Task + matching Result row.
  // Helper-only test: bypasses the runner so we control finalResult precisely.
  const workflowRepository = dataSource.getRepository(Workflow);
  const taskRepository = dataSource.getRepository(Task);
  const resultRepository = dataSource.getRepository(Result);

  const workflow = workflowRepository.create({
    clientId: "test-client",
    status: WorkflowStatus.Completed,
    finalResult,
  });
  await workflowRepository.save(workflow);

  const task = taskRepository.create({
    clientId: "test-client",
    geoJson: "{}",
    status: TaskStatus.Completed,
    taskType: "polygonArea",
    stepNumber: 1,
    dependsOn: [],
    workflowId: workflow.workflowId,
  });
  await taskRepository.save(task);

  const result = resultRepository.create({
    taskId: task.taskId,
    data: JSON.stringify({ areaSqMeters: 42 }),
  });
  await resultRepository.save(result);
  task.resultId = result.resultId;
  await taskRepository.save(task);

  workflow.tasks = [task];
  return { workflow, tasks: [task] };
}

describe("applyLazyFinalResultPatch — pure helper (Task 6, lazy patch)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: NULL finalResult is synthesized + persisted + returned", () => {
    it("populates Workflow.finalResult and returns the synthesized payload", async () => {
      const { workflow } = await seedTerminalCompletedWorkflow(dataSource, null);

      const payload = await dataSource.transaction((entityManager) =>
        applyLazyFinalResultPatch(entityManager, workflow),
      );

      expect(payload.workflowId).toBe(workflow.workflowId);
      expect(payload.tasks).toEqual([
        { stepNumber: 1, taskType: "polygonArea", status: TaskStatus.Completed, output: { areaSqMeters: 42 } },
      ]);

      const refreshed = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshed.finalResult).not.toBeNull();
      expect(JSON.parse(refreshed.finalResult as string)).toEqual(payload);
    });
  });

  describe("error path: pre-populated finalResult is never overwritten", () => {
    it("respects the WHERE finalResult IS NULL guard (returns synthesized payload to caller; column unchanged)", async () => {
      // Simulates a race where a concurrent eager write commits between the
      // handler's findOne and the lazy patch. The conditional UPDATE must be
      // a no-op; the persisted sentinel survives.
      const sentinel = JSON.stringify({ marker: "preexisting-winner" });
      const { workflow } = await seedTerminalCompletedWorkflow(dataSource, sentinel);

      await dataSource.transaction((entityManager) =>
        applyLazyFinalResultPatch(entityManager, workflow),
      );

      const refreshed = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshed.finalResult).toBe(sentinel);
    });
  });
});
