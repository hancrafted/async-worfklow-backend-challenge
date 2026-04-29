import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../models/Task";
import { Result } from "../models/Result";
import { Workflow, WorkflowStatus } from "../models/Workflow";
import { TaskStatus } from "../models/Task";
import {
  WorkflowFactory,
  WorkflowValidationError,
} from "./WorkflowFactory";
import { ApiErrorCode } from "../utils/errorResponse";

const VALID_GEOJSON = JSON.stringify({
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
});

const fixture = (name: string): string =>
  path.join(__dirname, "..", "..", "tests", "03-interdependent-tasks", "fixtures", name);

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

describe("WorkflowFactory — single-pass transactional create", () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = buildDataSource();
    await dataSource.initialize();
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  describe("happy path: persists workflow + tasks atomically with the right waiting/queued mix", () => {
    it("inserts deps-free tasks as queued, deps-bearing tasks as waiting, with resolved-UUID dependsOn", async () => {
      // Builds a 3-step workflow (step 1 deps-free, step 2 deps on 1, step 3
      // deps on 1 + 2). Asserts each task row carries the right initial
      // status, that `dependsOn` holds the resolved upstream taskIds (UUIDs),
      // and that `Workflow.status` defaults to 'initial'.
      const factory = new WorkflowFactory(dataSource);
      const workflow = await factory.createWorkflowFromYAML(
        fixture("three-step-mixed-deps.yml"),
        "client-happy",
        VALID_GEOJSON,
      );

      expect(workflow.workflowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(workflow.status).toBe(WorkflowStatus.Initial);

      const tasks = await dataSource.getRepository(Task).find({
        where: { workflow: { workflowId: workflow.workflowId } },
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
    });
  });

  describe("error path: validation failures throw WorkflowValidationError and write nothing", () => {
    const fixtures: Array<[string, string, ApiErrorCode]> = [
      ["missing-step-ref.yml", "missing-step", ApiErrorCode.INVALID_DEPENDENCY],
      ["cycle-2-3-2.yml", "cycle", ApiErrorCode.DEPENDENCY_CYCLE],
      ["self-dep.yml", "self-dep", ApiErrorCode.DEPENDENCY_CYCLE],
      ["duplicate-step.yml", "duplicate", ApiErrorCode.INVALID_WORKFLOW_FILE],
      ["missing-tasktype.yml", "missing-taskType", ApiErrorCode.INVALID_WORKFLOW_FILE],
      ["unknown-tasktype.yml", "unknown-taskType", ApiErrorCode.INVALID_WORKFLOW_FILE],
    ];

    for (const [filename, label, expectedCode] of fixtures) {
      it(`rejects ${label} with ${expectedCode} and persists no rows`, async () => {
        const factory = new WorkflowFactory(dataSource);
        await expect(
          factory.createWorkflowFromYAML(
            fixture(filename),
            "client-bad",
            VALID_GEOJSON,
          ),
        ).rejects.toBeInstanceOf(WorkflowValidationError);

        try {
          await factory.createWorkflowFromYAML(
            fixture(filename),
            "client-bad",
            VALID_GEOJSON,
          );
        } catch (error) {
          expect((error as WorkflowValidationError).code).toBe(expectedCode);
        }

        expect(await dataSource.getRepository(Workflow).count()).toBe(0);
        expect(await dataSource.getRepository(Task).count()).toBe(0);
      });
    }
  });
});
