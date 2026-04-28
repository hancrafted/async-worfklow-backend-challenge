import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import type { Job, JobContext } from "../../src/jobs/Job";
import { drainWorker } from "../03-interdependent-tasks/helpers/drainWorker";
import type * as MockJobsByTypeModule from "../03-interdependent-tasks/helpers/mockJobsByType";

// Reuse the shared mockJobsByType helper (same hoisted-require dance as
// 01-lifecycle-claim-bump.test.ts) so the JobFactory mock instance is the
// one `setMockJobsByType` writes to.
const mockJobsHelper = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../03-interdependent-tasks/helpers/mockJobsByType.ts") as typeof MockJobsByTypeModule;
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

describe("Task 3b-ii Wave 2 — promotion + dependency envelope (integration)", () => {
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
    it("runs a 2-step dependsOn chain end-to-end and forwards step 1's output to step 2 via context.dependencies", async () => {
      // Spy jobs:
      //   - step 1 (polygonArea) returns a known output payload.
      //   - step 2 (analysis) records the JobContext it receives so the test
      //     can assert envelope shape, sort, and dependency.output fidelity.
      const stepOneOutput = { areaSqMeters: 1234567 };
      const capturedContexts: JobContext[] = [];
      const polygonAreaJob: Job = {
        run: () => Promise.resolve(stepOneOutput),
      };
      const analysisJob: Job = {
        run: (context) => {
          capturedContexts.push(context);
          return Promise.resolve({ analysed: true });
        },
      };
      setMockJobsByType({ polygonArea: polygonAreaJob, analysis: analysisJob });

      const workflow = await seedTwoStepChain(dataSource);
      const taskRepository = dataSource.getRepository(Task);
      const ranCount = await drainWorker(taskRepository);

      expect(ranCount).toBe(2);
      const terminalWorkflow = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(terminalWorkflow.status).toBe(WorkflowStatus.Completed);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks.map((t) => t.status)).toEqual([
        TaskStatus.Completed,
        TaskStatus.Completed,
      ]);

      // Envelope assertions: step 2 received exactly one dependency entry,
      // sourced from step 1's persisted Result.data, with the documented shape.
      expect(capturedContexts).toHaveLength(1);
      const stepTwoContext = capturedContexts[0];
      expect(stepTwoContext.dependencies).toHaveLength(1);
      const dep = stepTwoContext.dependencies[0];
      expect(dep.stepNumber).toBe(1);
      expect(dep.taskType).toBe("polygonArea");
      expect(dep.taskId).toBe(tasks[0].taskId);
      expect(dep.output).toEqual(stepOneOutput);
    });
  });

  describe("error path", () => {
    it("when step 1 fails, promotion does not fire — step 2 is swept to Skipped and the workflow ends Failed", async () => {
      // Promotion only fires on Completed transitions (PRD §Decision 9).
      // A failing step 1 must leave step 2 unpromoted; Wave 3's fail-fast
      // sweep then flips step 2 (waiting) to skipped in the same post-task
      // transaction, and the lifecycle eval closes the workflow as Failed.
      // The minimum guarantee Wave 2 must hold is: step 2's job is never
      // invoked — Wave 3 also asserts the surrounding sweep + workflow state.
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

      // Only step 1 is ever queued; drainWorker returns after step 1 fails
      // because step 2 has been swept to Skipped (no promotion on Failed).
      expect(ranCount).toBe(1);
      expect(stepTwoCalls).toHaveLength(0);

      const tasks = await taskRepository.find({
        where: { workflowId: workflow.workflowId },
        order: { stepNumber: "ASC" },
      });
      expect(tasks[0].status).toBe(TaskStatus.Failed);
      expect(tasks[1].status).toBe(TaskStatus.Skipped);

      const workflowAfter = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(workflowAfter.status).toBe(WorkflowStatus.Failed);
    });
  });
});
