import "reflect-metadata";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource, IsNull } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/models/Task";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";
import { createWorkflowRouter } from "../../src/routes/workflowRoutes";
import { ApiErrorCode } from "../../src/utils/errorResponse";
import type { Job } from "../../src/jobs/Job";
import { drainWorker } from "../03-interdependent-tasks/helpers/drainWorker";
import type * as MockJobsByTypeModule from "../03-interdependent-tasks/helpers/mockJobsByType";

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

const fixturePath = (subdir: string, name: string): string =>
  path.join(__dirname, "..", subdir, "fixtures", name);

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

const buildApp = (dataSource: DataSource): express.Express => {
  const app = express();
  app.use(express.json());
  app.use("/workflow", createWorkflowRouter({ dataSource }));
  return app;
};

interface ResultsBody {
  workflowId: string;
  status: WorkflowStatus;
  finalResult: {
    workflowId: string;
    failedAtStep?: number;
    tasks: Array<{
      stepNumber: number;
      taskType: string;
      status: TaskStatus;
      output?: unknown;
      error?: { message: string; reason: string };
    }>;
  };
}

interface ErrorBody {
  error: string;
  message: string;
}

async function seedTwoStepSuccess(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("04-final-result", "two-step-success.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

async function seedFourStepChain(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("04-final-result", "four-step-chain.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

describe("Task 6 — GET /workflow/:id/results (Readme §6)", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
    setMockJobsByType({});
  });

  describe("happy path: terminal workflows return finalResult", () => {
    it("200 on a completed workflow with full finalResult.tasks[]", async () => {
      // Drain a 2-step success workflow end-to-end. The runner's eager write
      // populates Workflow.finalResult on the terminal transition; the
      // /results handler reads the persisted column verbatim.
      const polygonArea: Job = { run: () => Promise.resolve({ areaSqMeters: 99 }) };
      const analysis: Job = { run: () => Promise.resolve({ analysed: true }) };
      setMockJobsByType({ polygonArea, analysis });

      const workflow = await seedTwoStepSuccess(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );
      const body = response.body as ResultsBody;

      expect(response.status).toBe(200);
      expect(body.workflowId).toBe(workflow.workflowId);
      expect(body.status).toBe(WorkflowStatus.Completed);
      expect(body.finalResult.workflowId).toBe(workflow.workflowId);
      expect(body.finalResult).not.toHaveProperty("failedAtStep");
      expect(body.finalResult.tasks).toEqual([
        { stepNumber: 1, taskType: "polygonArea", status: TaskStatus.Completed, output: { areaSqMeters: 99 } },
        { stepNumber: 2, taskType: "analysis", status: TaskStatus.Completed, output: { analysed: true } },
      ]);
      // US16: internal taskId never appears in the public response.
      const responseText = JSON.stringify(body);
      const tasks = await dataSource.getRepository(Task).find({
        where: { workflowId: workflow.workflowId },
      });
      for (const task of tasks) expect(responseText).not.toContain(task.taskId);
    });

  });

  describe("error path: workflow failed", () => {
    it("returns 400 { error: 'WORKFLOW_FAILED', message } on a failed workflow", async () => {
      // Drives a 4-step chain where step 1 fails. The runner's sweep skips
      // downstream tasks and lifecycle eval closes the workflow as failed.
      // Per the literal Readme §Task 6 contract — "Return a 400 response if
      // the workflow is not yet completed" — the handler must reject with
      // WORKFLOW_FAILED rather than serve the lenient 200+finalResult shape
      // (supersedes PRD §Implementation Decision 12). Failure detail still
      // surfaces via GET /workflow/:id/status (`failureReason`).
      const failingPolygonArea: Job = { run: () => Promise.reject(new Error("polygon-boom")) };
      const noopJob: Job = { run: () => Promise.resolve({ ok: true }) };
      setMockJobsByType({
        polygonArea: failingPolygonArea,
        analysis: noopJob,
        notification: noopJob,
        reportGeneration: noopJob,
      });

      const workflow = await seedFourStepChain(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );

      expect(response.status).toBe(400);
      const body = response.body as ErrorBody;
      expect(body.error).toBe(ApiErrorCode.WORKFLOW_FAILED);
      expect(body.message).toContain(workflow.workflowId);
      expect(body.message.toLowerCase()).toContain("failed");

      // Confirm the workflow really did reach the failed terminal state —
      // otherwise the 400 would be a false positive against an unintended
      // status.
      const persisted = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(persisted.status).toBe(WorkflowStatus.Failed);
    });
  });

  describe("error path: workflow not found", () => {
    it("returns 404 { error: 'WORKFLOW_NOT_FOUND', message } for an unknown id", async () => {
      const response = await request(buildApp(dataSource)).get(
        "/workflow/00000000-0000-0000-0000-000000000000/results",
      );
      expect(response.status).toBe(404);
      const body = response.body as ErrorBody;
      expect(body.error).toBe(ApiErrorCode.WORKFLOW_NOT_FOUND);
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    });
  });

  describe("error path: workflow not yet terminal", () => {
    it("returns 400 WORKFLOW_NOT_TERMINAL on an initial workflow", async () => {
      // Freshly-seeded workflow: status=initial, no ticks have happened.
      const workflow = await seedTwoStepSuccess(dataSource);
      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );
      expect(response.status).toBe(400);
      const body = response.body as ErrorBody;
      expect(body.error).toBe(ApiErrorCode.WORKFLOW_NOT_TERMINAL);
      expect(body.message).toContain(workflow.workflowId);
    });

    it("returns 400 WORKFLOW_NOT_TERMINAL on an in_progress workflow", async () => {
      // Manually flip the workflow to in_progress without driving it terminal
      // — the simplest way to assert the dispatch table without a partial
      // worker tick. Mirrors the worker's claim bump (PRD §Decision 9).
      const workflow = await seedTwoStepSuccess(dataSource);
      await dataSource.getRepository(Workflow).update(
        { workflowId: workflow.workflowId },
        { status: WorkflowStatus.InProgress },
      );
      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );
      expect(response.status).toBe(400);
      const body = response.body as ErrorBody;
      expect(body.error).toBe(ApiErrorCode.WORKFLOW_NOT_TERMINAL);
    });
  });

  describe("error path: lazy-patch idempotence", () => {
    it("forced-NULL finalResult is populated on first GET; second GET returns the same payload", async () => {
      // Drain to terminal so eager write fires. Then force finalResult back
      // to NULL — simulating a pre-Wave-1 row or rare race. The first GET
      // must (a) synthesize via the shared helper, (b) persist under the
      // WHERE finalResult IS NULL guard, (c) return the synthesized payload.
      // The second GET must read the now-populated column and return the
      // same payload (handler is idempotent).
      const polygonArea: Job = { run: () => Promise.resolve({ areaSqMeters: 7 }) };
      const analysis: Job = { run: () => Promise.resolve({ analysed: true }) };
      setMockJobsByType({ polygonArea, analysis });

      const workflow = await seedTwoStepSuccess(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      // Force finalResult back to NULL after the eager write.
      await dataSource.getRepository(Workflow).update(
        { workflowId: workflow.workflowId },
        { finalResult: null },
      );
      const beforeFirstGet = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId, finalResult: IsNull() },
      });
      expect(beforeFirstGet.finalResult).toBeNull();

      const firstResponse = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );
      expect(firstResponse.status).toBe(200);
      const firstBody = firstResponse.body as ResultsBody;
      expect(firstBody.finalResult.tasks).toHaveLength(2);

      // Column is now populated.
      const afterFirstGet = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(afterFirstGet.finalResult).not.toBeNull();
      expect(JSON.parse(afterFirstGet.finalResult as string)).toEqual(firstBody.finalResult);

      // Second GET reads the persisted value — same payload.
      const secondResponse = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/results`,
      );
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body).toEqual(firstBody);
    });
  });

  describe("error path: handler does not advance lifecycle", () => {
    it("GET on a non-terminal workflow leaves status untouched (read-only)", async () => {
      // PRD §Implementation Decision 13: workflow lifecycle is driven only
      // by the runner's post-task transaction. The /results handler must
      // never flip status — even on a 400 dispatch.
      const workflow = await seedTwoStepSuccess(dataSource);
      const before = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(before.status).toBe(WorkflowStatus.Initial);

      await request(buildApp(dataSource)).get(`/workflow/${workflow.workflowId}/results`);

      const after = await dataSource.getRepository(Workflow).findOneOrFail({
        where: { workflowId: workflow.workflowId },
      });
      expect(after.status).toBe(WorkflowStatus.Initial);
      expect(after.finalResult).toBeNull();
    });
  });
});
