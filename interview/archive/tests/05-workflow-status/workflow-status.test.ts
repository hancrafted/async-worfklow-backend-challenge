import "reflect-metadata";
import path from "path";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/models/Task";
import { tickOnce } from "../../src/workers/taskWorker";
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

const fixturePath = (name: string): string =>
  path.join(__dirname, "..", "03-interdependent-tasks", "fixtures", name);

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

interface StatusBody {
  workflowId: string;
  status: WorkflowStatus;
  totalTasks: number;
  completedTasks: number;
  tasks: Array<{
    stepNumber: number;
    taskType: string;
    status: TaskStatus;
    dependsOn: number[];
    failureReason?: string;
  }>;
}

interface ErrorBody {
  error: string;
  message: string;
}

async function seedThreeStep(dataSource: DataSource): Promise<Workflow> {
  const factory = new WorkflowFactory(dataSource);
  return factory.createWorkflowFromYAML(
    fixturePath("three-step-mixed-deps.yml"),
    "test-client",
    JSON.stringify(VALID_GEOJSON),
  );
}

describe("Task 5 — GET /workflow/:id/status (Readme §5)", () => {
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

  describe("happy path: status returns workflow + per-task list keyed by stepNumber", () => {
    it("mid-run workflow → 200 in_progress with mix of completed / queued / waiting", async () => {
      // Drain only the deps-free polygonArea step (1 tick). Wave 2 promotion
      // flips step 2 (waiting → queued) since its only dep is now completed.
      // Step 3 has dep on both 1 and 2, so it remains waiting.
      const polygonArea: Job = { run: () => Promise.resolve({ areaSqMeters: 42 }) };
      const analysis: Job = { run: () => Promise.resolve({ analysed: true }) };
      const notification: Job = { run: () => Promise.resolve({ sent: true }) };
      setMockJobsByType({ polygonArea, analysis, notification });

      const workflow = await seedThreeStep(dataSource);
      const ran = await tickOnce(dataSource.getRepository(Task));
      expect(ran).toBe(true);

      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/status`,
      );
      const body = response.body as StatusBody;

      expect(response.status).toBe(200);
      expect(body.workflowId).toBe(workflow.workflowId);
      expect(body.status).toBe(WorkflowStatus.InProgress);
      expect(body.totalTasks).toBe(3);
      expect(body.completedTasks).toBe(1);
      expect(body.tasks.map((t) => t.stepNumber)).toEqual([1, 2, 3]);
      expect(body.tasks[0]).toEqual({
        stepNumber: 1, taskType: "polygonArea", status: TaskStatus.Completed, dependsOn: [],
      });
      expect(body.tasks[1]).toEqual({
        stepNumber: 2, taskType: "analysis", status: TaskStatus.Queued, dependsOn: [1],
      });
      expect(body.tasks[2]).toEqual({
        stepNumber: 3, taskType: "notification", status: TaskStatus.Waiting, dependsOn: [1, 2],
      });
      // failureReason absent everywhere on a non-failed run.
      for (const taskEntry of body.tasks) expect(taskEntry).not.toHaveProperty("failureReason");
      // US16: no internal taskId in the response payload.
      const responseText = JSON.stringify(body);
      const tasks = await dataSource.getRepository(Task).find({
        where: { workflowId: workflow.workflowId },
      });
      for (const task of tasks) expect(responseText).not.toContain(task.taskId);
    });

    it("completed workflow → 200 completed, completedTasks === totalTasks, no failureReason", async () => {
      const polygonArea: Job = { run: () => Promise.resolve({ areaSqMeters: 1 }) };
      const analysis: Job = { run: () => Promise.resolve({ analysed: true }) };
      const notification: Job = { run: () => Promise.resolve({ sent: true }) };
      setMockJobsByType({ polygonArea, analysis, notification });

      const workflow = await seedThreeStep(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/status`,
      );
      const body = response.body as StatusBody;
      expect(response.status).toBe(200);
      expect(body.status).toBe(WorkflowStatus.Completed);
      expect(body.totalTasks).toBe(3);
      expect(body.completedTasks).toBe(3);
      for (const taskEntry of body.tasks) {
        expect(taskEntry.status).toBe(TaskStatus.Completed);
        expect(taskEntry).not.toHaveProperty("failureReason");
      }
    });

    it("failed workflow (post-sweep) → 200 failed, failed task carries job_error, swept tasks are skipped without failureReason", async () => {
      // Step 1 fails. The runner's fail-fast sweep flips waiting/queued
      // siblings (steps 2, 3) to skipped. Lifecycle eval closes the workflow
      // as failed in the same post-task transaction.
      const polygonArea: Job = { run: () => Promise.reject(new Error("polygon-boom")) };
      const analysis: Job = { run: () => Promise.resolve({ analysed: true }) };
      const notification: Job = { run: () => Promise.resolve({ sent: true }) };
      setMockJobsByType({ polygonArea, analysis, notification });

      const workflow = await seedThreeStep(dataSource);
      await drainWorker(dataSource.getRepository(Task));

      const response = await request(buildApp(dataSource)).get(
        `/workflow/${workflow.workflowId}/status`,
      );
      const body = response.body as StatusBody;
      expect(response.status).toBe(200);
      expect(body.status).toBe(WorkflowStatus.Failed);
      expect(body.totalTasks).toBe(3);
      expect(body.completedTasks).toBe(0);

      const failedEntry = body.tasks.find((t) => t.stepNumber === 1)!;
      expect(failedEntry.status).toBe(TaskStatus.Failed);
      expect(failedEntry.failureReason).toBe("job_error");

      for (const stepNumber of [2, 3]) {
        const skippedEntry = body.tasks.find((t) => t.stepNumber === stepNumber)!;
        expect(skippedEntry.status).toBe(TaskStatus.Skipped);
        expect(skippedEntry).not.toHaveProperty("failureReason");
      }

      // No payloads — no `output`, no `error.message` on /status.
      const responseText = JSON.stringify(body);
      expect(responseText).not.toContain("polygon-boom");
      for (const taskEntry of body.tasks) {
        expect(taskEntry).not.toHaveProperty("output");
        expect(taskEntry).not.toHaveProperty("error");
      }
    });
  });

  describe("error path: workflow not found", () => {
    it("returns 404 { error: 'WORKFLOW_NOT_FOUND', message } for an unknown id", async () => {
      const response = await request(buildApp(dataSource)).get(
        "/workflow/00000000-0000-0000-0000-000000000000/status",
      );
      expect(response.status).toBe(404);
      const body = response.body as ErrorBody;
      expect(body.error).toBe(ApiErrorCode.WORKFLOW_NOT_FOUND);
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    });
  });
});
