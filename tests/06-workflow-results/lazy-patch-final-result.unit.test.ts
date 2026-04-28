import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { applyLazyFinalResultPatch } from "../../src/routes/workflowRoutes";

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
