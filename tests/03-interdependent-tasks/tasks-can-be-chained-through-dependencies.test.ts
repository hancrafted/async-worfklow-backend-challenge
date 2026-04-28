import "reflect-metadata";
import path from "path";
import * as os from "os";
import * as fs from "fs";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { tickOnce, runWorkerLoop, type StopSignal } from "../../src/workers/taskWorker";
import {
  WorkflowStatus,
} from "../../src/workflows/WorkflowFactory";
import { createAnalysisRouter } from "../../src/routes/analysisRoutes";
import { ApiErrorCode } from "../../src/utils/errorResponse";
import { LogLevel } from "../../src/utils/logger";
import { PolygonAreaJob } from "../../src/jobs/PolygonAreaJob";
import { buildAppDataSource, buildWorkerDataSource } from "../../src/data-source";
import { seedWorkflow } from "./helpers/seedWorkflow";
import { drainPool } from "./helpers/drainPool";

interface PoolSubstrate {
  bootstrapDataSource: DataSource;
  dataSourceFactory: () => DataSource;
  cleanup: () => Promise<void>;
}

// Issue #17 Wave 2 — pool tests now exercise per-worker DataSources against a
// file-backed SQLite (WAL on, 5s busy_timeout) so concurrent
// `manager.transaction(...)` calls actually overlap on the substrate. The
// drainPool helper mints its own DataSources via this factory.
async function buildPoolSubstrate(): Promise<PoolSubstrate> {
  const dbDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "drainpool-"));
  const dbPath = path.join(dbDirectory, "database.sqlite");
  const bootstrapDataSource = buildAppDataSource({
    databasePath: dbPath,
    dropSchema: true,
  });
  await bootstrapDataSource.initialize();
  return {
    bootstrapDataSource,
    dataSourceFactory: () => buildWorkerDataSource(dbPath),
    cleanup: async () => {
      if (bootstrapDataSource.isInitialized) await bootstrapDataSource.destroy();
      if (fs.existsSync(dbDirectory)) {
        fs.rmSync(dbDirectory, { recursive: true, force: true });
      }
    },
  };
}

const VALID_GEOJSON = {
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

const fixture = (name: string): string =>
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

const buildApp = (dataSource: DataSource, workflowFile: string): express.Express => {
  const app = express();
  app.use(express.json());
  app.use("/analysis", createAnalysisRouter({ dataSource, workflowFile }));
  return app;
};

interface ErrorBody {
  error: string;
  message: string;
}

// Readme §3 R2 — "Tasks can be chained through dependencies."
// Task 3a covers workflow creation only; the runtime execution chain is added
// by 3b-ii (TODO: extend the happy-path describe with a "runs in topological
// order" `it()` once promotion + lifecycle land).
describe("Readme §3 R2 — tasks can be chained through dependencies (creation slice)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: tasks can be chained through dependencies", () => {
    it("creates a multi-step workflow with the correct waiting / queued mix", async () => {
      // Submit a 3-step YAML where step 1 has no deps and steps 2 & 3 have
      // dependsOn. Asserts: 202 { workflowId }, DB shows resolved-UUID
      // dependsOn, deps-free task starts queued, deps-bearing tasks start
      // waiting, Workflow.status === 'initial'.
      const app = buildApp(dataSource, fixture("three-step-mixed-deps.yml"));

      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-happy", geoJson: VALID_GEOJSON });
      const body = response.body as { workflowId: string };

      expect(response.status).toBe(202);
      expect(body).toHaveProperty("workflowId");
      expect(body.workflowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const tasks = await dataSource.getRepository(Task).find({
        where: { workflow: { workflowId: body.workflowId } },
        relations: ["workflow"],
        order: { stepNumber: "ASC" },
      });
      expect(tasks).toHaveLength(3);
      expect(tasks[0].status).toBe(TaskStatus.Queued);
      expect(tasks[0].dependsOn).toEqual([]);
      expect(tasks[1].status).toBe(TaskStatus.Waiting);
      expect(tasks[1].dependsOn).toEqual([tasks[0].taskId]);
      expect(tasks[2].status).toBe(TaskStatus.Waiting);
      expect(new Set(tasks[2].dependsOn)).toEqual(
        new Set([tasks[0].taskId, tasks[1].taskId]),
      );

      const workflow = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: body.workflowId },
      });
      expect(workflow.status).toBe(WorkflowStatus.Initial);
    });
  });

  describe("error path: invalid dependency graph rejected at creation time", () => {
    const assertNoDbWrites = async (): Promise<void> => {
      expect(await dataSource.getRepository(Workflow).count()).toBe(0);
      expect(await dataSource.getRepository(Task).count()).toBe(0);
    };

    it("rejects a missing-step reference with 400 INVALID_DEPENDENCY and writes nothing", async () => {
      // Step 2 declares dependsOn: [9] but step 9 does not exist. Asserts
      // unified `{ error, message }` shape AND zero rows in workflows / tasks
      // tables — the no-DB-writes-on-4xx invariant.
      const app = buildApp(dataSource, fixture("missing-step-ref.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-missing", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: ApiErrorCode.INVALID_DEPENDENCY,
        message: "Step 2 references non-existent step 9",
      });
      await assertNoDbWrites();
    });

    it("rejects a multi-node cycle (2 → 3 → 2) with 400 DEPENDENCY_CYCLE", async () => {
      const app = buildApp(dataSource, fixture("cycle-2-3-2.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-cycle", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.DEPENDENCY_CYCLE);
      expect((response.body as ErrorBody).message).toMatch(/Cycle detected:/);
      await assertNoDbWrites();
    });

    it("rejects a self-dependency (1 → 1) with 400 DEPENDENCY_CYCLE", async () => {
      const app = buildApp(dataSource, fixture("self-dep.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-self", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: ApiErrorCode.DEPENDENCY_CYCLE,
        message: "Cycle detected: 1 → 1",
      });
      await assertNoDbWrites();
    });

    it("rejects a duplicate stepNumber with 400 INVALID_WORKFLOW_FILE", async () => {
      const app = buildApp(dataSource, fixture("duplicate-step.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-dup", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect((response.body as ErrorBody).message).toMatch(/Duplicate stepNumber/);
      await assertNoDbWrites();
    });

    it("rejects a missing taskType with 400 INVALID_WORKFLOW_FILE", async () => {
      const app = buildApp(dataSource, fixture("missing-tasktype.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-no-type", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect((response.body as ErrorBody).message).toMatch(/missing taskType/);
      await assertNoDbWrites();
    });

    it("rejects an unknown taskType with 400 INVALID_WORKFLOW_FILE", async () => {
      const app = buildApp(dataSource, fixture("unknown-tasktype.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-unknown-type", geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect((response.body as ErrorBody).message).toMatch(/unknown taskType/);
      await assertNoDbWrites();
    });

    it("rejects a missing clientId on the request body with 400 INVALID_PAYLOAD", async () => {
      // Retrofit: existing route accepted absent clientId silently. Now the
      // route returns the unified 400 shape with INVALID_PAYLOAD.
      const app = buildApp(dataSource, fixture("three-step-mixed-deps.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ geoJson: VALID_GEOJSON });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.INVALID_PAYLOAD);
      await assertNoDbWrites();
    });

    it("rejects a missing geoJson on the request body with 400 INVALID_PAYLOAD", async () => {
      const app = buildApp(dataSource, fixture("three-step-mixed-deps.yml"));
      const response = await request(app)
        .post("/analysis")
        .send({ clientId: "client-no-geojson" });
      expect(response.status).toBe(400);
      expect((response.body as ErrorBody).error).toBe(ApiErrorCode.INVALID_PAYLOAD);
      await assertNoDbWrites();
    });
  });
});

interface CapturedLogLine {
  level: LogLevel;
  ts: string;
  msg: string;
  workflowId?: string;
  taskId?: string;
  stepNumber?: number;
  taskType?: string;
  error?: { message: string; stack?: string };
}

const parseLogCalls = (
  spy: ReturnType<typeof vi.spyOn>,
): CapturedLogLine[] =>
  spy.mock.calls.map((call) => JSON.parse(call[0] as string) as CapturedLogLine);

// PRD §11 / US22 — runner-level structured JSON-line logging. Drains a single
// queued task through `tickOnce(...)` and asserts the runner emits the
// documented log shape (`{ level, ts, workflowId, taskId, stepNumber,
// taskType, msg, error? }`) on stdout (info) / stderr (error).
describe("R3 — runner: structured JSON-line logging (US22)", () => {
  let dataSource: DataSource;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: info JSON lines around a successful job", () => {
    it("emits 'starting job' and 'job completed' info lines with the PRD §11 context for the polygonArea step", async () => {
      // Seed the canonical 3-step fixture; the deps-free polygonArea step (1)
      // is the only `queued` candidate, so a single tickOnce drains exactly
      // one task and produces the two info lines this requirement covers.
      const { tasks } = await seedWorkflow(dataSource, "three-step-mixed-deps.yml");
      const polygonStep = tasks.find((t) => t.stepNumber === 1)!;

      const ran = await tickOnce(dataSource.getRepository(Task));
      expect(ran).toBe(true);

      const logLines = parseLogCalls(logSpy);
      const startLine = logLines.find(
        (line) => line.msg === "starting job" && line.taskId === polygonStep.taskId,
      );
      const doneLine = logLines.find(
        (line) => line.msg === "job completed" && line.taskId === polygonStep.taskId,
      );
      expect(startLine).toMatchObject({
        level: LogLevel.Info,
        workflowId: polygonStep.workflowId,
        taskId: polygonStep.taskId,
        stepNumber: 1,
        taskType: "polygonArea",
      });
      expect(new Date(startLine!.ts).toISOString()).toBe(startLine!.ts);
      expect(doneLine).toMatchObject({
        level: LogLevel.Info,
        msg: "job completed",
        stepNumber: 1,
        taskType: "polygonArea",
      });
    });
  });

  describe("error path: error JSON line with serialized error.stack on a job exception", () => {
    it("emits a 'job failed' error line with truncated stack when polygonArea throws", async () => {
      // Pass a non-Polygon geoJson so PolygonAreaJob.validate() rejects; the
      // runner catches, persists Failed, and must emit a structured error
      // line on stderr including { message, stack } with stack ≤10 lines.
      const { tasks } = await seedWorkflow(
        dataSource,
        "three-step-mixed-deps.yml",
        { geoJson: { type: "Point", coordinates: [0, 0] } },
      );
      const polygonStep = tasks.find((t) => t.stepNumber === 1)!;

      await tickOnce(dataSource.getRepository(Task));

      const errorLines = parseLogCalls(errorSpy);
      const failure = errorLines.find(
        (line) => line.msg === "job failed" && line.taskId === polygonStep.taskId,
      );
      expect(failure).toMatchObject({
        level: LogLevel.Error,
        workflowId: polygonStep.workflowId,
        taskId: polygonStep.taskId,
        stepNumber: 1,
        taskType: "polygonArea",
      });
      expect(failure!.error?.message).toMatch(/Invalid GeoJSON/);
      expect(failure!.error?.stack?.split("\n").length).toBeLessThanOrEqual(10);
    });
  });
});


// PRD §11 / US21 — runner-level exceptions are transient. The worker loop is
// the layer of last resort: any throw escaping `tickOnce` (e.g. a DB blip in
// the claim transaction) is caught, logged at error, and the loop continues
// — the worker never dies. Drives the real `runWorkerLoop` against a real
// repository; the no-op `sleepFn` keeps the test deterministic per
// CLAUDE.md §Worker-loop tests.
describe("R3 — runner: runner-level exceptions are transient (US21)", () => {
  let dataSource: DataSource;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    // Silence stdout info/warn lines emitted by the runner during the test.
    vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: worker survives a transient claim-transaction error", () => {
    it("logs error, sleeps, and the next iteration drains a real seeded task", async () => {
      // Seed the canonical 3-step fixture; step 1 (polygonArea) is the only
      // queued candidate. Stub `manager.transaction` to throw on its first
      // invocation only — this simulates a transient DB blip during the claim
      // — then fall through to the real implementation. The loop must catch
      // the throw, emit a structured error JSON line, sleep (no-op here),
      // and on the next iteration drain the task to Completed.
      const { tasks } = await seedWorkflow(
        dataSource,
        "three-step-mixed-deps.yml",
      );
      const polygonStep = tasks.find((t) => t.stepNumber === 1)!;

      const taskRepository = dataSource.getRepository(Task);
      const transactionSpy = vi.spyOn(dataSource.manager, "transaction");
      transactionSpy.mockRejectedValueOnce(
        new Error("transient db blip in claim"),
      );

      const stopSignal: StopSignal = { stopped: false };
      let tickCalls = 0;
      const tickFn = async (): Promise<boolean> => {
        tickCalls += 1;
        const ran = await tickOnce(taskRepository);
        // Stop after the second tick (call 1 throws inside the claim, call 2
        // drains the seeded task). Bound is 5 to surface a runaway loop.
        if (tickCalls >= 2) stopSignal.stopped = true;
        if (tickCalls > 5) throw new Error("runaway loop guard tripped");
        return ran;
      };

      await runWorkerLoop({
        tickFn,
        sleepMs: 5000,
        sleepFn: async () => {},
        stopSignal,
      });

      const refreshed = await taskRepository.findOneOrFail({
        where: { taskId: polygonStep.taskId },
      });
      expect(refreshed.status).toBe(TaskStatus.Completed);

      const errorLines = errorSpy.mock.calls.map(
        (c) => JSON.parse(c[0] as string) as CapturedLogLine,
      );
      const transient = errorLines.find(
        (l) => l.error?.message === "transient db blip in claim",
      );
      expect(transient).toBeDefined();
      expect(transient!.level).toBe(LogLevel.Error);
      expect(transient!.msg).toMatch(/runner-level exception/);
    });
  });

  describe("error path: a job-level exception is NOT a runner-level exception", () => {
    it("a failed PolygonAreaJob is captured by TaskRunner; runWorkerLoop's catch is never entered", async () => {
      // Layered-catch invariant. Pass a Point geoJson so PolygonAreaJob
      // throws; TaskRunner catches it, persists Failed, and `tickOnce`
      // returns true normally. The runWorkerLoop catch handler must therefore
      // never see this error — proving the runner-level loop only fires for
      // exceptions that escape TaskRunner (US21 vs US20 isolation).
      const { tasks } = await seedWorkflow(
        dataSource,
        "three-step-mixed-deps.yml",
        { geoJson: { type: "Point", coordinates: [0, 0] } },
      );
      const polygonStep = tasks.find((t) => t.stepNumber === 1)!;

      const stopSignal: StopSignal = { stopped: false };
      const tickFn = async (): Promise<boolean> => {
        const ran = await tickOnce(dataSource.getRepository(Task));
        stopSignal.stopped = true;
        return ran;
      };

      await runWorkerLoop({
        tickFn,
        sleepMs: 5000,
        sleepFn: async () => {},
        stopSignal,
      });

      const errorLines = errorSpy.mock.calls.map(
        (c) => JSON.parse(c[0] as string) as CapturedLogLine,
      );
      const runnerLevel = errorLines.find((l) =>
        /runner-level exception/.test(l.msg),
      );
      expect(runnerLevel).toBeUndefined();

      const refreshed = await dataSource.getRepository(Task).findOneOrFail({
        where: { taskId: polygonStep.taskId },
      });
      expect(refreshed.status).toBe(TaskStatus.Failed);
    });
  });
});


// PRD §10 / US17, US18 — Wave 3 worker pool. The `drainPool` helper drives
// N `runWorkerLoop(...)` coroutines synchronously, each owning its own
// per-worker `DataSource` (Issue #17 Wave 1 + Wave 2 — substrate de-mutex).
describe("R3 — pool: atomic claim race, N workers, 1 queued task, no double-execution (US17, US18)", () => {
  let substrate: PoolSubstrate;

  beforeEach(async () => {
    substrate = await buildPoolSubstrate();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await substrate.cleanup();
  });

  describe("happy path: N=3 workers, 1 queued task, exactly one execution", () => {
    it("drains a single-step polygonArea workflow exactly once across N=3 coroutines", async () => {
      // Seed a single-task workflow whose only step is the deps-free polygonArea
      // — `tasks` has length 1 and starts queued. `vi.spyOn(PolygonAreaJob.prototype, 'run')`
      // is the reviewer-visible execution counter; the atomic-claim primitive
      // (PRD §10) must guarantee `runSpy.mock.calls.length === 1` even though
      // three coroutines race for the same row.
      const runSpy = vi.spyOn(PolygonAreaJob.prototype, "run");
      const { workflow, tasks } = await seedWorkflow(
        substrate.bootstrapDataSource,
        "three-step-mixed-deps.yml",
        { clientId: "pool-happy" },
      );
      // Disable downstream steps so the test isolates the race on the
      // single deps-free polygonArea step (only it is queued at start).
      const queuedAtStart = tasks.filter((t) => t.status === TaskStatus.Queued);
      expect(queuedAtStart).toHaveLength(1);

      const executed = await drainPool({
        workerCount: 3,
        dataSourceFactory: substrate.dataSourceFactory,
        bootstrapDataSource: substrate.bootstrapDataSource,
      });

      // The first claimer wins → polygonArea ran once → the two losers see
      // an empty queue (after the workflow walks to terminal state) and exit.
      expect(runSpy).toHaveBeenCalledTimes(1);
      // executed counts cumulative ticks across all coroutines: polygonArea
      // (1) + analysis (2 deps satisfied via promotion) + notification (3) = 3.
      expect(executed).toBe(3);
      const refreshed = await substrate.bootstrapDataSource
        .getRepository(Workflow)
        .findOneOrFail({ where: { workflowId: workflow.workflowId } });
      expect(refreshed.status).toBe(WorkflowStatus.Completed);
    });
  });

  describe("error path: a transient claim error in one worker does not double-execute", () => {
    it("a single failed claim transaction in one worker still leaves exactly one execution", async () => {
      // Seed first (seedWorkflow itself uses a transaction). Install a
      // one-shot rejection on the FIRST per-worker DataSource the factory
      // mints — simulates a transient DB blip in that worker's first claim
      // transaction. The other workers (with their own DataSources) must
      // still atomically claim the row, and the spy job must observe exactly
      // one execution.
      const runSpy = vi.spyOn(PolygonAreaJob.prototype, "run");
      const { workflow } = await seedWorkflow(
        substrate.bootstrapDataSource,
        "three-step-mixed-deps.yml",
        { clientId: "pool-error" },
      );

      let factoryCallCount = 0;
      const wrappedFactory = (): DataSource => {
        const dataSource = substrate.dataSourceFactory();
        factoryCallCount += 1;
        if (factoryCallCount === 1) {
          vi.spyOn(dataSource.manager, "transaction").mockRejectedValueOnce(
            new Error("transient claim blip"),
          );
        }
        return dataSource;
      };

      await drainPool({
        workerCount: 3,
        dataSourceFactory: wrappedFactory,
        bootstrapDataSource: substrate.bootstrapDataSource,
      });

      // Even with one transient claim failure, the polygonArea step ran once
      // and the workflow eventually completes (the surviving workers drain
      // every promoted step). No double execution.
      expect(runSpy).toHaveBeenCalledTimes(1);
      const refreshed = await substrate.bootstrapDataSource
        .getRepository(Workflow)
        .findOneOrFail({ where: { workflowId: workflow.workflowId } });
      expect(refreshed.status).toBe(WorkflowStatus.Completed);
    });
  });
});

// US20 — per-worker isolation. A single failing job in one workflow must not
// stop the pool or the other workflows from reaching a terminal state.
describe("R3 — pool: per-worker isolation (US20 reinforced)", () => {
  let substrate: PoolSubstrate;

  beforeEach(async () => {
    substrate = await buildPoolSubstrate();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await substrate.cleanup();
  });

  describe("happy path: independent workflows reach terminal states under N=3", () => {
    it("3 independent workflows (one with a failing step) all reach a terminal state, no worker dies", async () => {
      // Seed three independent workflows: two with valid GeoJSON, one with a
      // Point payload (invalidates polygonArea so the step throws). Drain the
      // pool with N=3 workers and assert each workflow ends in a terminal
      // status — Completed for the two valid ones, Failed for the invalid one
      // (fail-fast sweep flips its dependent steps to Skipped). The pool
      // must keep draining throughout — no worker dies on the failing step.
      const goodA = await seedWorkflow(substrate.bootstrapDataSource, "three-step-mixed-deps.yml", {
        clientId: "iso-good-a",
      });
      const badB = await seedWorkflow(substrate.bootstrapDataSource, "three-step-mixed-deps.yml", {
        clientId: "iso-bad-b",
        geoJson: { type: "Point", coordinates: [0, 0] },
      });
      const goodC = await seedWorkflow(substrate.bootstrapDataSource, "three-step-mixed-deps.yml", {
        clientId: "iso-good-c",
      });

      await drainPool({
        workerCount: 3,
        dataSourceFactory: substrate.dataSourceFactory,
        bootstrapDataSource: substrate.bootstrapDataSource,
      });

      const workflowRepository = substrate.bootstrapDataSource.getRepository(Workflow);
      const refreshedA = await workflowRepository.findOneOrFail({
        where: { workflowId: goodA.workflow.workflowId },
      });
      const refreshedB = await workflowRepository.findOneOrFail({
        where: { workflowId: badB.workflow.workflowId },
      });
      const refreshedC = await workflowRepository.findOneOrFail({
        where: { workflowId: goodC.workflow.workflowId },
      });
      expect(refreshedA.status).toBe(WorkflowStatus.Completed);
      expect(refreshedB.status).toBe(WorkflowStatus.Failed);
      expect(refreshedC.status).toBe(WorkflowStatus.Completed);
    });
  });

  describe("error path: a hard runner-level error in one tick does not poison sibling workflows", () => {
    it("a transient claim error during one tick is logged and the pool continues draining other workflows", async () => {
      // Seed two workflows first. Install a one-shot rejection on the FIRST
      // per-worker DataSource the factory mints — simulates a DB blip during
      // that worker's first claim. The loop's try/catch (PRD §11 / US21) must
      // absorb the throw, sleepFn returns, and the next iteration drains.
      // Per-worker isolation == one worker's transient error does not poison
      // the others.
      const wfA = await seedWorkflow(substrate.bootstrapDataSource, "three-step-mixed-deps.yml", {
        clientId: "iso-blip-a",
      });
      const wfB = await seedWorkflow(substrate.bootstrapDataSource, "three-step-mixed-deps.yml", {
        clientId: "iso-blip-b",
      });

      let factoryCallCount = 0;
      const wrappedFactory = (): DataSource => {
        const dataSource = substrate.dataSourceFactory();
        factoryCallCount += 1;
        if (factoryCallCount === 1) {
          vi.spyOn(dataSource.manager, "transaction").mockRejectedValueOnce(
            new Error("transient claim blip in pool"),
          );
        }
        return dataSource;
      };

      await drainPool({
        workerCount: 3,
        dataSourceFactory: wrappedFactory,
        bootstrapDataSource: substrate.bootstrapDataSource,
        maxTicksPerWorker: 100,
      });

      const workflowRepository = substrate.bootstrapDataSource.getRepository(Workflow);
      const refreshedA = await workflowRepository.findOneOrFail({
        where: { workflowId: wfA.workflow.workflowId },
      });
      const refreshedB = await workflowRepository.findOneOrFail({
        where: { workflowId: wfB.workflow.workflowId },
      });
      expect(refreshedA.status).toBe(WorkflowStatus.Completed);
      expect(refreshedB.status).toBe(WorkflowStatus.Completed);
    });
  });
});
