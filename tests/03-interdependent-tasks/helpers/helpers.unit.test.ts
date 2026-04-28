import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../../src/models/Task";
import { Result } from "../../../src/models/Result";
import { Workflow } from "../../../src/models/Workflow";
import { TaskStatus } from "../../../src/workers/taskRunner";
import type { Job } from "../../../src/jobs/Job";
import { drainWorker } from "./drainWorker";
import { seedWorkflow } from "./seedWorkflow";
import type * as MockJobsByTypeModule from "./mockJobsByType";

// Vitest hoists `vi.mock(...)` above imports, so the factory must not
// reference imported bindings (they are TDZ at hoist time). Loading the
// helper module inside `vi.hoisted(...)` makes its exports available
// synchronously when `vi.mock(...)` registers the factory. We must use the
// hoisted module instance (not a separate `import` from the same path) so
// the registry-state set by `setMockJobsByType` is the same one the mock
// reads — different require/import paths can yield different instances.
const mockJobsHelper = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./mockJobsByType.ts") as typeof MockJobsByTypeModule;
});
vi.mock("../../../src/jobs/JobFactory", mockJobsHelper.jobFactoryMockImpl);
const { setMockJobsByType, jobFactoryMockImpl } = mockJobsHelper;

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

describe("Pre-#7 shared test helpers — smoke (A5)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    setMockJobsByType({});
  });

  describe("happy path: seed → drain → assert deps-free task completes", () => {
    it("drains the one queued step and leaves dependents waiting (ranCount=1)", async () => {
      // Arrange: register a passing job ONLY for `polygonArea` (step 1's
      // taskType in three-step-mixed-deps.yml). Steps 2 & 3 stay `waiting`
      // because their dependencies haven't completed yet, so the drain
      // naturally stops after one tick — proving all three helpers wired
      // together drive a workflow end-to-end.
      const passingJob: Job = {
        run: () => Promise.resolve({ ok: true }),
      };
      setMockJobsByType({ polygonArea: passingJob });

      const { workflow, tasks } = await seedWorkflow(
        dataSource,
        "three-step-mixed-deps.yml",
      );
      expect(tasks).toHaveLength(3);

      // Act
      const ranCount = await drainWorker(dataSource.getRepository(Task));

      // Assert: drainWorker reports exactly one tick executed, the deps-free
      // task is `completed`, and the dependent tasks remain `waiting`.
      expect(ranCount).toBe(1);
      const refreshed = await dataSource
        .getRepository(Task)
        .find({ where: { workflowId: workflow.workflowId } });
      const byStep = new Map(refreshed.map((task) => [task.stepNumber, task]));
      expect(byStep.get(1)!.status).toBe(TaskStatus.Completed);
      expect(byStep.get(2)!.status).toBe(TaskStatus.Waiting);
      expect(byStep.get(3)!.status).toBe(TaskStatus.Waiting);
    });
  });

  describe("error paths: helpers surface their bounds and contracts", () => {
    it("drainWorker throws when ranCount exceeds maxTicks", async () => {
      // maxTicks=0 forces the cap to trip on the first successful tick,
      // proving the bound exists (a buggy state machine would otherwise loop).
      const passingJob: Job = {
        run: () => Promise.resolve({ ok: true }),
      };
      setMockJobsByType({ polygonArea: passingJob });
      await seedWorkflow(dataSource, "three-step-mixed-deps.yml");

      await expect(
        drainWorker(dataSource.getRepository(Task), { maxTicks: 0 }),
      ).rejects.toThrow(/drainWorker exceeded maxTicks \(=0\)/);
    });

    it("mockJobsByType throws when a taskType is not in the registry", () => {
      // The helper must surface missing-mock bugs loudly so silent fallthrough
      // doesn't mask a misconfigured #7 integration test.
      setMockJobsByType({ analysis: { run: () => Promise.resolve({}) } });
      const factory = jobFactoryMockImpl();
      expect(() => factory.getJobForTaskType("polygonArea")).toThrow(
        /no job registered for taskType "polygonArea"/,
      );
    });
  });
});
