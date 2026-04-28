import "reflect-metadata";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/workers/taskRunner";
import {
  WorkflowStatus,
} from "../../src/workflows/WorkflowFactory";
import { createAnalysisRouter } from "../../src/routes/analysisRoutes";
import { ApiErrorCode } from "../../src/utils/errorResponse";

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
