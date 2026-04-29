import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/models/Task";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import type { Job } from "../../src/jobs/Job";
import { drainWorker } from "../_setup/helpers/drainWorker";
import type * as MockJobsByTypeModule from "../_setup/helpers/mockJobsByType";

// Reuse the shared mockJobsByType helper (same hoisted-require dance as the
// other Wave files in this folder).
const mockJobsHelper = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../_setup/helpers/mockJobsByType.ts") as typeof MockJobsByTypeModule;
});
vi.mock("../../src/jobs/JobFactory", mockJobsHelper.jobFactoryMockImpl);
const { setMockJobsByType } = mockJobsHelper;

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

async function seedTwoStepChain(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("two-step-chain.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

async function seedThreeStepFanOut(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("three-step-fan-out.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

describe("Task 3b-ii Wave 3 — fail-fast sweep + workflow.failed (integration)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    setMockJobsByType({});
  });

  describe("happy path", () => {
    it("when step 1 fails the runner sweeps step 2 to skipped and ends the workflow Failed", async () => {
      // Two-step chain (step 2 dependsOn [1]). Step 1's job throws, so the
      // runner's post-task transaction enters the Failed branch: sweep flips
      // step 2 (waiting) to skipped, lifecycle eval then sees allTerminal +
      // anyFailed and writes workflow.status = Failed in the same txn.
      const stepTwoCalls: number[] = [];
      const failingPolygonArea: Job = {
        run: () => Promise.reject(new Error("boom-step-1")),
      };
      const analysisJob: Job = {
        run: () => {
          stepTwoCalls.push(1);
          return Promise.resolve({ analysed: true });
        },
      };
      setMockJobsByType({
        polygonArea: failingPolygonArea,
        analysis: analysisJob,
      });

      const workflow = await seedTwoStepChain(dataSource);
      const taskRepository = dataSource.getRepository(Task);
      const ranCount = await drainWorker(taskRepository);

      // Only step 1 is ever queued; step 2 is swept to skipped (terminal) so
      // the worker drains after one tick — step 2's job is never invoked.
      expect(ranCount).toBe(1);
      expect(stepTwoCalls).toHaveLength(0);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks.map((t) => t.status)).toEqual([
        TaskStatus.Failed,
        TaskStatus.Skipped,
      ]);

      const workflowAfter = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(workflowAfter.status).toBe(WorkflowStatus.Failed);
    });
  });

  describe("error path", () => {
    it("fan-out: every waiting sibling is swept when the shared parent fails", async () => {
      // Fan-out fixture: step 1 (polygonArea) is the queued root; steps 2 and
      // 3 each depend on step 1 (waiting). Step 1's job throws → sweep flips
      // BOTH step 2 and step 3 to skipped in a single UPDATE; workflow ends
      // Failed.
      const downstreamCalls: string[] = [];
      const failingPolygonArea: Job = {
        run: () => Promise.reject(new Error("boom-fanout")),
      };
      const recordingJob: Job = {
        run: ({ task }) => {
          downstreamCalls.push(task.taskType);
          return Promise.resolve({ ok: true });
        },
      };
      setMockJobsByType({
        polygonArea: failingPolygonArea,
        analysis: recordingJob,
        notification: recordingJob,
      });

      const workflow = await seedThreeStepFanOut(dataSource);
      const taskRepository = dataSource.getRepository(Task);
      const ranCount = await drainWorker(taskRepository);

      expect(ranCount).toBe(1);
      expect(downstreamCalls).toHaveLength(0);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks.map((t) => t.status)).toEqual([
        TaskStatus.Failed,
        TaskStatus.Skipped,
        TaskStatus.Skipped,
      ]);

      const workflowAfter = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(workflowAfter.status).toBe(WorkflowStatus.Failed);
    });
  });
});
