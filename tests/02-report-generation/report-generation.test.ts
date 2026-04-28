import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import { tickOnce } from "../../src/workers/taskWorker";
import { drainWorker } from "../03-interdependent-tasks/helpers/drainWorker";

const VALID_GEOJSON = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const fixturePath = (name: string): string =>
  path.join(__dirname, "fixtures", name);

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

interface ReportData {
  workflowId: string;
  tasks: Array<{ stepNumber: number; taskType: string; output: unknown }>;
  finalReport: string;
}

// Readme §2 — "Add a Job to Generate a Report" / PRD §Task 2 / Issue #3.
// End-to-end proof that a workflow with a `reportGeneration` step depending on
// upstream producers populates the locked report shape on Result.data once
// every upstream task is completed. Uses the real JobFactory + real jobs.
describe("Readme §2 — reportGeneration aggregates upstream outputs", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: report aggregates upstream outputs", () => {
    it("drains a polygonArea + analysis → reportGeneration DAG and writes the locked report shape", async () => {
      // Seed a 3-step workflow: two deps-free producers (polygonArea, analysis)
      // then a reportGeneration step that depends on both. Drain the worker to
      // run all three tasks. The report job's output (Result.data) must match
      // the PRD §Task 2 shape: { workflowId, tasks[], finalReport } with
      // tasks[] sorted by stepNumber ASC and no taskId field anywhere.
      const factory = new WorkflowFactory(dataSource);
      const workflow = await factory.createWorkflowFromYAML(
        fixturePath("two-producers-then-report.yml"),
        "client-report-happy",
        JSON.stringify(VALID_GEOJSON),
      );

      const taskRepository = dataSource.getRepository(Task);
      const ranCount = await drainWorker(taskRepository);
      expect(ranCount).toBe(3);

      const refreshedWorkflow = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshedWorkflow.status).toBe(WorkflowStatus.Completed);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks.map((t) => t.status)).toEqual([
        TaskStatus.Completed,
        TaskStatus.Completed,
        TaskStatus.Completed,
      ]);

      // Load the persisted Result for the reportGeneration step (step 3) and
      // assert the JSON-encoded shape matches the spec verbatim.
      const reportTask = tasks[2];
      const reportResult = await dataSource.getRepository(Result).findOneOrFail({
        where: { resultId: reportTask.resultId },
      });
      const report = JSON.parse(reportResult.data!) as unknown as ReportData;

      expect(report.workflowId).toBe(workflow.workflowId);
      expect(report.tasks).toHaveLength(2);
      expect(report.tasks[0].stepNumber).toBe(1);
      expect(report.tasks[0].taskType).toBe("polygonArea");
      const polygonOutput = report.tasks[0].output as { areaSqMeters: number };
      expect(typeof polygonOutput.areaSqMeters).toBe("number");
      expect(report.tasks[1].stepNumber).toBe(2);
      expect(report.tasks[1].taskType).toBe("analysis");
      // PRD §Decision 4 — taskId never leaks into the public report shape.
      const serialised = JSON.stringify(report);
      for (const upstream of [tasks[0], tasks[1]]) {
        expect(serialised).not.toContain(upstream.taskId);
      }
      // finalReport references the workflow id and the task count.
      expect(report.finalReport).toContain(workflow.workflowId);
      expect(report.finalReport).toContain("2");
    });
  });

  describe("error path: defensive handling of malformed upstream envelopes", () => {
    it("when an upstream Result.data is corrupted, the report task ends Failed and the workflow ends Failed", async () => {
      // Seed a 2-step workflow (polygonArea → reportGeneration) so we can
      // surgically corrupt the polygonArea Result.data after step 1 runs
      // but before the report step runs. The runner's buildDependencyEnvelope
      // does JSON.parse on each upstream Result.data — corrupted data throws,
      // the report task is marked Failed via the per-worker try/catch, and
      // the workflow lifecycle eval flips the workflow to Failed.
      const factory = new WorkflowFactory(dataSource);
      const workflow = await factory.createWorkflowFromYAML(
        fixturePath("single-producer-then-report.yml"),
        "client-report-error",
        JSON.stringify(VALID_GEOJSON),
      );

      const taskRepository = dataSource.getRepository(Task);
      // Run two tickOnce calls: tick 1 runs polygonArea, then we corrupt the
      // persisted Result.data, then tick 2 runs reportGeneration — whose claim
      // path JSON.parses each upstream Result.data and throws on the corruption.
      await tickOnce(taskRepository);

      const polygonTask = await taskRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId, stepNumber: 1 },
      });
      const polygonResult = await dataSource.getRepository(Result).findOneOrFail({
        where: { resultId: polygonTask.resultId },
      });
      polygonResult.data = "not-valid-json{";
      await dataSource.getRepository(Result).save(polygonResult);

      await tickOnce(taskRepository);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks[0].status).toBe(TaskStatus.Completed);
      expect(tasks[1].status).toBe(TaskStatus.Failed);

      const refreshedWorkflow = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshedWorkflow.status).toBe(WorkflowStatus.Failed);
    });
  });
});
