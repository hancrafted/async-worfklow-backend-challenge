import "reflect-metadata";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import { tickOnce } from "../../src/workers/taskWorker";
import {
  WorkflowStatus,
} from "../../src/workflows/WorkflowFactory";
import { createAnalysisRouter } from "../../src/routes/analysisRoutes";
import { ApiErrorCode } from "../../src/utils/errorResponse";
import { LogLevel } from "../../src/utils/logger";
import { seedWorkflow } from "./helpers/seedWorkflow";

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
