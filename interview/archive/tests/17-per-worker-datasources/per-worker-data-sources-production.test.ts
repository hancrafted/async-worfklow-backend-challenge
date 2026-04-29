import "reflect-metadata";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { In, type DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/models/Task";
import {
  startWorkerPool,
  WorkerPoolConfigValidationError,
  type StopSignal,
} from "../../src/workers/taskWorker";
import { buildAppDataSource, buildWorkerDataSource } from "../../src/data-source";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";

const VALID_GEOJSON = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const fixture = (name: string): string =>
  path.join(__dirname, "fixtures", name);

// Issue #17 Wave 1 — production reproduction.
// On 2026-04-28 a 7-step DAG with a fan-in `reportGeneration` step hung in
// production with `TransactionNotStartedError` because every worker coroutine
// in `startWorkerPool` shared one `AppDataSource` (one underlying SQLite
// connection). Concurrent `manager.transaction(...)` calls on that single
// connection corrupted the BEGIN/COMMIT state.
//
// The fix this test pins: each coroutine builds its own `DataSource` via
// `dataSourceFactory`, the file-backed SQLite is opened in WAL mode (per the
// `prepareDatabase` hook on `buildAppDataSource`), and writers serialise at
// the SQLite layer instead of corrupting JS-level transaction state.
describe("Issue #17 Wave 1 — production worker pool with per-worker DataSources (US17, US18)", () => {
  let dbDirectory: string;
  let dbPath: string;
  let bootstrapDataSource: DataSource;

  beforeEach(async () => {
    // Each test gets an isolated file-backed SQLite DB. WAL is enabled via
    // `prepareDatabase` on every DataSource produced by buildAppDataSource.
    dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "issue-17-"));
    dbPath = path.join(dbDirectory, "database.sqlite");
    bootstrapDataSource = buildAppDataSource({
      databasePath: dbPath,
      dropSchema: true,
    });
    await bootstrapDataSource.initialize();
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

  describe("happy path: N=2 workers drain a 7-step DAG including reportGeneration", () => {
    it("completes every task and the workflow without TransactionNotStartedError", async () => {
      // Seed the 7-step fixture (mirrors example_workflow.yml + reportGeneration
      // fan-in at step 7). The first concurrent claim window opens at step 3
      // — the exact site of the production hang in the Issue #17 description.
      const factory = new WorkflowFactory(bootstrapDataSource);
      const workflow = await factory.createWorkflowFromYAML(
        fixture("seven-step-with-report.yml"),
        "client-issue-17",
        JSON.stringify(VALID_GEOJSON),
      );

      // Capture stderr structured logs so we can assert the bug-signature
      // string never appears in the run.
      const errorLines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        if (typeof line === "string") errorLines.push(line);
      });

      const stopSignal: StopSignal = { stopped: false };
      // sleepFn doubles as the drain detector: when no task is queued or
      // in_progress anywhere in the DB, flip the stop signal so the coroutines
      // exit on their next predicate check (CLAUDE.md §Worker-loop tests —
      // no real timers, no fake timers).
      const sleepFn = async (): Promise<void> => {
        const remaining = await bootstrapDataSource
          .getRepository(Task)
          .count({
            where: { status: In([TaskStatus.Queued, TaskStatus.InProgress]) },
          });
        if (remaining === 0) stopSignal.stopped = true;
      };

      await startWorkerPool({
        size: 2,
        dataSourceFactory: () => buildWorkerDataSource(dbPath),
        sleepMs: 0,
        sleepFn,
        stopSignal,
      });

      const refreshedWorkflow = await bootstrapDataSource
        .getRepository(Workflow)
        .findOneOrFail({ where: { workflowId: workflow.workflowId } });
      expect(refreshedWorkflow.status).toBe(WorkflowStatus.Completed);

      const tasks = await bootstrapDataSource
        .getRepository(Task)
        .find({ where: { workflowId: workflow.workflowId } });
      expect(tasks).toHaveLength(7);
      for (const task of tasks) {
        expect(task.status).toBe(TaskStatus.Completed);
      }

      const transactionFailures = errorLines.filter((line) =>
        /TransactionNotStartedError|no such savepoint/.test(line),
      );
      expect(transactionFailures).toEqual([]);
    });
  });

  describe("error path: startWorkerPool validates that exactly one source is provided", () => {
    it("rejects when neither repository nor dataSourceFactory is provided", () => {
      // Defensive boundary: before Wave 1 the only source was `repository`.
      // After Wave 1 the production path uses `dataSourceFactory`. Exactly one
      // of the two must be supplied — supplying neither is a programmer error
      // and must fail-fast with the same WorkerPoolConfigValidationError that
      // pool size validation uses (taskWorker.ts).
      expect(() =>
        startWorkerPool({
          size: 2,
          sleepMs: 0,
          sleepFn: async () => {},
          stopSignal: { stopped: true },
        }),
      ).toThrow(WorkerPoolConfigValidationError);
    });
  });
});
