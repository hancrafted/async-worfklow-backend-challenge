import "reflect-metadata";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { In, type DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import {
  startWorkerPool,
  type StopSignal,
} from "../../src/workers/taskWorker";
import { buildAppDataSource, buildWorkerDataSource } from "../../src/data-source";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import type { Job } from "../../src/jobs/Job";

const VALID_GEOJSON = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const fixture = (name: string): string =>
  path.join(__dirname, "fixtures", name);

// Knobs for the overlap proof. With 3 independent workflows running on N=3
// workers, perfect parallelism finishes in ~JOB_SLEEP_MS; serial execution
// (single worker) takes WORKFLOW_COUNT × JOB_SLEEP_MS. The 0.7 ceiling
// proves the wall-clock overlap is real — we are not just running serially.
const WORKFLOW_COUNT = 3;
const WORKER_COUNT = 3;
const JOB_SLEEP_MS = 200;
const SERIAL_BOUND_MS = WORKFLOW_COUNT * JOB_SLEEP_MS;
const OVERLAP_RATIO = 0.7;
const WALL_CLOCK_CEILING_MS = SERIAL_BOUND_MS * OVERLAP_RATIO;

// Hoisted so the vi.mock factory can read the spy job before imports settle.
const sleepyRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/jobs/JobFactory", () => ({
  getJobForTaskType: (): Job => ({ run: sleepyRunMock }),
}));

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Issue #17 Wave 2 — wall-clock concurrency proof.
// Wave 1 made each worker coroutine own its DataSource. This test pins that
// the per-worker DataSources actually allow concurrent `tickOnce` execution
// against an in-memory shared substrate — no JS-level mutex, no test-only
// serialisation. With N=WORKER_COUNT workers and WORKFLOW_COUNT independent
// workflows whose jobs each sleep JOB_SLEEP_MS, the total wall time must
// stay under WALL_CLOCK_CEILING_MS — anything above that means the workers
// degenerated into serial execution.
describe("Issue #17 Wave 2 — per-worker DataSources overlap in wall-clock time (US17, US18)", () => {
  let dbDirectory: string;
  let dbPath: string;
  let bootstrapDataSource: DataSource;

  beforeEach(async () => {
    dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "issue-17-overlap-"));
    dbPath = path.join(dbDirectory, "database.sqlite");
    bootstrapDataSource = buildAppDataSource({
      databasePath: dbPath,
      dropSchema: true,
    });
    await bootstrapDataSource.initialize();
    sleepyRunMock.mockReset();
    sleepyRunMock.mockImplementation(async () => {
      await wait(JOB_SLEEP_MS);
      return { ok: true };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (bootstrapDataSource.isInitialized) await bootstrapDataSource.destroy();
    if (fs.existsSync(dbDirectory)) {
      fs.rmSync(dbDirectory, { recursive: true, force: true });
    }
  });

  describe("happy path: N independent workflows drain in parallel", () => {
    it(`drains ${WORKFLOW_COUNT} workflows under wall-clock budget < ${WALL_CLOCK_CEILING_MS}ms`, async () => {
      // Seed N independent single-step workflows; each step is the spy
      // sleepy job. With per-worker DataSources, all N workers should claim
      // and execute concurrently — wall clock ≈ JOB_SLEEP_MS, never the
      // serial bound (WORKFLOW_COUNT × JOB_SLEEP_MS).
      const factory = new WorkflowFactory(bootstrapDataSource);
      const workflowIds: string[] = [];
      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const workflow = await factory.createWorkflowFromYAML(
          fixture("single-step.yml"),
          `client-overlap-${i}`,
          JSON.stringify(VALID_GEOJSON),
        );
        workflowIds.push(workflow.workflowId);
      }

      const stopSignal: StopSignal = { stopped: false };
      // Drain detector mirrors the production sleepFn pattern: when nothing
      // is queued or in-flight, flip the stop signal so the loop exits on
      // its next predicate check (CLAUDE.md §Worker-loop tests).
      const sleepFn = async (): Promise<void> => {
        const remaining = await bootstrapDataSource
          .getRepository(Task)
          .count({
            where: { status: In([TaskStatus.Queued, TaskStatus.InProgress]) },
          });
        if (remaining === 0) stopSignal.stopped = true;
      };

      const startedAt = Date.now();
      await startWorkerPool({
        size: WORKER_COUNT,
        dataSourceFactory: () => buildWorkerDataSource(dbPath),
        sleepMs: 0,
        sleepFn,
        stopSignal,
      });
      const elapsedMs = Date.now() - startedAt;

      // Every workflow drained.
      const workflowRepository = bootstrapDataSource.getRepository(Workflow);
      for (const workflowId of workflowIds) {
        const refreshed = await workflowRepository.findOneOrFail({
          where: { workflowId },
        });
        expect(refreshed.status).toBe(WorkflowStatus.Completed);
      }
      // The job spy ran exactly once per workflow — no double-execution.
      expect(sleepyRunMock).toHaveBeenCalledTimes(WORKFLOW_COUNT);
      // The overlap proof: wall clock < 0.7 × serial bound.
      expect(elapsedMs).toBeLessThan(WALL_CLOCK_CEILING_MS);
    });
  });

  describe("error path: one worker's claim throws but the pool still overlaps", () => {
    it("absorbs a one-shot claim transaction failure and stays under the wall-clock ceiling", async () => {
      // Seed N workflows then install a one-shot transaction failure on the
      // first DataSource the factory mints. That worker eats the blip via
      // runWorkerLoop's try/catch + sleepFn cycle, then re-enters the loop
      // and competes for whatever is still queued. The other workers proceed
      // unaffected — wall clock must still beat the serial bound.
      const factory = new WorkflowFactory(bootstrapDataSource);
      const workflowIds: string[] = [];
      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const workflow = await factory.createWorkflowFromYAML(
          fixture("single-step.yml"),
          `client-overlap-error-${i}`,
          JSON.stringify(VALID_GEOJSON),
        );
        workflowIds.push(workflow.workflowId);
      }

      let factoryCallCount = 0;
      const wrappedFactory = (): DataSource => {
        const dataSource = buildWorkerDataSource(dbPath);
        factoryCallCount += 1;
        if (factoryCallCount === 1) {
          vi.spyOn(dataSource.manager, "transaction").mockRejectedValueOnce(
            new Error("transient claim blip"),
          );
        }
        return dataSource;
      };

      const stopSignal: StopSignal = { stopped: false };
      const sleepFn = async (): Promise<void> => {
        const remaining = await bootstrapDataSource
          .getRepository(Task)
          .count({
            where: { status: In([TaskStatus.Queued, TaskStatus.InProgress]) },
          });
        if (remaining === 0) stopSignal.stopped = true;
      };

      const startedAt = Date.now();
      await startWorkerPool({
        size: WORKER_COUNT,
        dataSourceFactory: wrappedFactory,
        sleepMs: 0,
        sleepFn,
        stopSignal,
      });
      const elapsedMs = Date.now() - startedAt;

      const workflowRepository = bootstrapDataSource.getRepository(Workflow);
      for (const workflowId of workflowIds) {
        const refreshed = await workflowRepository.findOneOrFail({
          where: { workflowId },
        });
        expect(refreshed.status).toBe(WorkflowStatus.Completed);
      }
      expect(sleepyRunMock).toHaveBeenCalledTimes(WORKFLOW_COUNT);
      expect(elapsedMs).toBeLessThan(WALL_CLOCK_CEILING_MS);
    });
  });
});
