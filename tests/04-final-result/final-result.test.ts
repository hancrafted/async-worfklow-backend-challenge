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
import { JobErrorReason } from "../../src/utils/serializeJobError";
import { drainWorker } from "../03-interdependent-tasks/helpers/drainWorker";
import type * as MockJobsByTypeModule from "../03-interdependent-tasks/helpers/mockJobsByType";

// Reuse the shared mockJobsByType helper (same hoisted-require pattern as the
// Wave-3 sweep test). Each test wires its own per-task-type job map.
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

async function seedTwoStepSuccess(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("two-step-success.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

async function seedFourStepChain(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("four-step-chain.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

describe("Task 4 — Workflow.finalResult synthesis with eager write (README §4)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    setMockJobsByType({});
  });

  describe("happy path: completed workflow gets framework-synthesized finalResult", () => {
    it("writes finalResult once on terminal transition with ordered tasks, all `output`, no failedAtStep, no taskId", async () => {
      // 2-step all-success workflow drained end-to-end. After the LAST task
      // commits, the post-task transaction synthesizes finalResult (US14) and
      // persists it together with workflow.status=Completed (PRD §Decision 8).
      const polygonAreaJob: Job = {
        run: () => Promise.resolve({ areaSqMeters: 12345 }),
      };
      const analysisJob: Job = {
        run: () => Promise.resolve({ analysed: true }),
      };
      setMockJobsByType({ polygonArea: polygonAreaJob, analysis: analysisJob });

      const workflow = await seedTwoStepSuccess(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const refreshed = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshed.status).toBe(WorkflowStatus.Completed);
      expect(refreshed.finalResult).not.toBeNull();
      const payload = JSON.parse(refreshed.finalResult as string) as {
        workflowId: string;
        failedAtStep?: number;
        tasks: Array<{ stepNumber: number; taskType: string; status: string; output?: unknown; error?: unknown }>;
      };

      expect(payload.workflowId).toBe(workflow.workflowId);
      expect(payload).not.toHaveProperty("failedAtStep");
      expect(payload.tasks).toEqual([
        { stepNumber: 1, taskType: "polygonArea", status: TaskStatus.Completed, output: { areaSqMeters: 12345 } },
        { stepNumber: 2, taskType: "analysis", status: TaskStatus.Completed, output: { analysed: true } },
      ]);

      // US16: internal taskId never appears in the persisted payload. Pull
      // every task's UUID and prove none of them is in the JSON blob.
      const tasks = await dataSource.getRepository(Task).find({
        where: { workflowId: workflow.workflowId },
      });
      for (const task of tasks) {
        expect(refreshed.finalResult).not.toContain(task.taskId);
      }
    });
  });

  describe("error path: mixed-failure workflow surfaces failedAtStep and per-task errors", () => {
    it("4-step chain with step 1 failing → finalResult.failedAtStep=1, error stripped of stack, skipped entries have neither output nor error", async () => {
      // 4-step chain (each step depends on the previous). Step 1 throws so
      // the runner enters the Failed branch: sweep flips 2/3/4 (waiting) to
      // skipped; lifecycle eval observes allTerminal && anyFailed and writes
      // finalResult + workflow.status=Failed in the same post-task txn.
      const failingPolygonArea: Job = {
        run: () => Promise.reject(new Error("polygon-boom")),
      };
      const noopJob: Job = { run: () => Promise.resolve({ ok: true }) };
      setMockJobsByType({
        polygonArea: failingPolygonArea,
        analysis: noopJob,
        notification: noopJob,
        reportGeneration: noopJob,
      });

      const workflow = await seedFourStepChain(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const refreshed = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(refreshed.status).toBe(WorkflowStatus.Failed);
      const payload = JSON.parse(refreshed.finalResult as string) as {
        workflowId: string;
        failedAtStep?: number;
        tasks: Array<{ stepNumber: number; taskType: string; status: string; output?: unknown; error?: { message: string; reason: string } }>;
      };

      expect(payload.failedAtStep).toBe(1);
      expect(payload.tasks).toHaveLength(4);
      expect(payload.tasks[0]).toEqual({
        stepNumber: 1,
        taskType: "polygonArea",
        status: TaskStatus.Failed,
        error: { message: "polygon-boom", reason: JobErrorReason.JobError },
      });
      // Steps 2/3/4: swept to skipped; entries carry no `output` and no `error`.
      for (const stepNumber of [2, 3, 4]) {
        const entry = payload.tasks.find((t) => t.stepNumber === stepNumber);
        expect(entry?.status).toBe(TaskStatus.Skipped);
        expect(entry).not.toHaveProperty("output");
        expect(entry).not.toHaveProperty("error");
      }

      // Source `Result.error` retains `stack` for debugging; the synthesized
      // finalResult column must NOT (US23 / PRD §11).
      const failedTaskResult = await dataSource.getRepository(Result).findOneOrFail({
        where: { taskId: (await dataSource.getRepository(Task).findOneOrFail({ where: { workflowId: workflow.workflowId, stepNumber: 1 } })).taskId },
      });
      expect(failedTaskResult.error).toContain("stack");
      expect(refreshed.finalResult).not.toContain("stack");
    });
  });

  describe("error path: idempotent eager write under concurrent terminal transitions", () => {
    it("respects the WHERE finalResult IS NULL guard — a pre-staged finalResult is never overwritten", async () => {
      // Simulate two workers racing on the LAST terminal transition: worker A
      // wins and persists finalResult; worker B's post-task txn fires next
      // and re-evaluates lifecycle. The conditional UPDATE guarded by
      // `WHERE finalResult IS NULL` MUST be a no-op for worker B.
      //
      // We model this by pre-writing a sentinel finalResult before the LAST
      // task drains. After the drain, the sentinel survives — proving the
      // guard short-circuits the second writer.
      const polygonAreaJob: Job = {
        run: () => Promise.resolve({ areaSqMeters: 7 }),
      };
      const analysisJob: Job = {
        run: () => Promise.resolve({ analysed: true }),
      };
      setMockJobsByType({ polygonArea: polygonAreaJob, analysis: analysisJob });

      const workflow = await seedTwoStepSuccess(dataSource);
      const taskRepository = dataSource.getRepository(Task);
      const workflowRepository = dataSource.getRepository(Workflow);

      // Pre-write a sentinel into Workflow.finalResult before the last
      // terminal transition. This stands in for "another worker already won
      // the race and committed their synthesized finalResult."
      const sentinel = JSON.stringify({ marker: "preexisting-winner" });
      await workflowRepository.update(
        { workflowId: workflow.workflowId },
        { finalResult: sentinel },
      );

      await drainWorker(taskRepository);

      const refreshed = await workflowRepository.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      // Guard kept the second writer out: finalResult still equals the
      // sentinel, not the freshly-synthesized payload.
      expect(refreshed.finalResult).toBe(sentinel);
    });
  });
});
