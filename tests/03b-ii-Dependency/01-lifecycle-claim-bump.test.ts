import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import type { Job } from "../../src/jobs/Job";
import { drainWorker } from "../03-interdependent-tasks/helpers/drainWorker";
import type * as MockJobsByTypeModule from "../03-interdependent-tasks/helpers/mockJobsByType";

// Reuse the shared mockJobsByType helper. The hoisted-require dance mirrors
// `tests/03-interdependent-tasks/helpers/helpers.unit.test.ts` so the registry
// instance read by the JobFactory mock is the same one `setMockJobsByType`
// writes to (different import paths can yield different module instances).
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

// Seeds the single-step fixture via the real WorkflowFactory so the integration
// path exercises persisted rows end-to-end. seedWorkflow from
// `tests/03-interdependent-tasks/helpers/` resolves fixtures relative to its
// own folder, so we call WorkflowFactory directly here for a fixture co-located
// with this task.
async function seedSingleStepWorkflow(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("single-step.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

describe("Task 3b-ii Wave 1 — lifecycle + initial→in_progress claim bump (integration)", () => {
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
    it("bumps workflow initial→in_progress mid-run, then transitions to completed after drain", async () => {
      // A deferred-promise spy lets us observe the persisted workflow row
      // mid-run without timers: the test holds the job open until it has
      // inspected the DB, then releases it. The claim transaction commits
      // before the job runs, so the in-job snapshot is the integration-level
      // proof that the bump fires inside `tickOnce`'s claim path.
      let releaseJob: ((value: { ok: true }) => void) | undefined;
      let signalStarted: (() => void) | undefined;
      const jobStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const deferredJob: Job = {
        run: () =>
          new Promise<{ ok: true }>((resolve) => {
            releaseJob = resolve;
            signalStarted!();
          }),
      };
      setMockJobsByType({ polygonArea: deferredJob });

      const workflow = await seedSingleStepWorkflow(dataSource);
      const repo = dataSource.getRepository(Task);
      const drainPromise = drainWorker(repo);

      // Wait for the spy to be entered (claim has committed by this point).
      await jobStarted;

      const midRun = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(midRun.status).toBe(WorkflowStatus.InProgress);

      // Release the deferred job and let the lifecycle run to terminal.
      releaseJob!({ ok: true });
      const ranCount = await drainPromise;

      expect(ranCount).toBe(1);
      const terminal = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(terminal.status).toBe(WorkflowStatus.Completed);
      const task = await repo.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(task.status).toBe(TaskStatus.Completed);
    });
  });

  describe("error path", () => {
    it("ends the workflow Failed, persists the Result error, and a second drain is a no-op", async () => {
      // Spy job throws. The runner persists Result.error + sets task Failed
      // inside the post-task transaction; the lifecycle helper sees
      // allTerminal && anyFailed and flips the workflow to Failed in the same
      // transaction. A second drainWorker pass with no queued tasks must
      // leave the persisted state untouched (immutability guard).
      const failingJob: Job = {
        run: () => Promise.reject(new Error("boom")),
      };
      setMockJobsByType({ polygonArea: failingJob });

      const workflow = await seedSingleStepWorkflow(dataSource);
      const repo = dataSource.getRepository(Task);

      const ranCount = await drainWorker(repo);
      expect(ranCount).toBe(1);

      const failed = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(failed.status).toBe(WorkflowStatus.Failed);

      const failedTask = await repo.findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(failedTask.status).toBe(TaskStatus.Failed);
      expect(failedTask.resultId).toBeTruthy();
      const result = await dataSource.getRepository(Result).findOneOrFail({
        where: { resultId: failedTask.resultId! },
      });
      expect(result.error).toBeTruthy();
      expect(JSON.parse(result.error!)).toMatchObject({ message: "boom" });

      // Snapshot, drain again (no queued tasks → tickOnce returns false on the
      // first probe), then re-read and assert nothing mutated.
      const snapshotWorkflowStatus = failed.status;
      const snapshotResultError = result.error;
      const secondRanCount = await drainWorker(repo);
      expect(secondRanCount).toBe(0);

      const afterSecondDrain = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      const resultAfter = await dataSource.getRepository(Result).findOneOrFail({
        where: { resultId: failedTask.resultId! },
      });
      expect(afterSecondDrain.status).toBe(snapshotWorkflowStatus);
      expect(resultAfter.error).toBe(snapshotResultError);
    });
  });
});
