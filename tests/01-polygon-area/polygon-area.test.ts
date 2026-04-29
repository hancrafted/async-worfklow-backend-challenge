import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { PolygonAreaJob } from "../../src/jobs/PolygonAreaJob";
import { getJobForTaskType } from "../../src/jobs/JobFactory";
import { Task, TaskStatus } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow, WorkflowStatus } from "../../src/models/Workflow";
import { TaskRunner } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";

describe("happy", () => {
  const VALID_POLYGON = JSON.stringify({
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  });

  const FIXTURE = path.join(__dirname, "fixtures", "polygonArea_only.yml");

  const makeTask = (geoJson: string): Task =>
    ({
      taskId: "task-under-test",
      geoJson,
      taskType: "polygonArea",
    }) as Task;

  const buildDataSource = (): DataSource =>
    new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      entities: [Task, Result, Workflow],
      synchronize: true,
      logging: false,
    });

  /**
   * Manual-drain helper — replaces the production 5s `setTimeout` worker loop
   * for tests. Drives `TaskRunner.run` over every queued task in step-number
   * order until the queue is empty.
   */
  async function drainWorker(dataSource: DataSource): Promise<void> {
    const taskRepository = dataSource.getRepository(Task);
    const runner = new TaskRunner(taskRepository);
    for (let i = 0; i < 100; i += 1) {
      const next = await taskRepository.findOne({
        where: { status: TaskStatus.Queued },
        relations: ["workflow"],
        order: { stepNumber: "ASC" },
      });
      if (!next) return;
      try {
        await runner.run(next);
      } catch {
        // Worker isolation: a single failed task must not stop the loop.
      }
    }
    throw new Error("drainWorker: too many iterations — possible infinite loop");
  }

  // Readme §1 R1: "The `output` should include the calculated area in square meters."
  describe("Readme §1 R1 — output includes the calculated area in square meters", () => {
    describe("happy path: computes area in square meters", () => {
      it("registers PolygonAreaJob in the JobFactory under taskType 'polygonArea'", () => {
        const job = getJobForTaskType("polygonArea");
        expect(job).toBeInstanceOf(PolygonAreaJob);
      });

      it("computes area of a 1°×1° square polygon at the equator", async () => {
        const polygon = {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        };
        const job = new PolygonAreaJob();

        const result = await job.run({ task: makeTask(JSON.stringify(polygon)), dependencies: [] });

        // @turf/area returns ~12,363,718,145 m² for this square. Assert a tolerant
        // range rather than an exact float so the test isn't brittle to library
        // recomputation.
        expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
        expect(result.areaSqMeters).toBeLessThan(1.3e10);
      });

      it("accepts a Feature<Polygon> wrapper and produces the same shape", async () => {
        const feature = {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          },
        };
        const job = new PolygonAreaJob();
        const result = await job.run({ task: makeTask(JSON.stringify(feature)), dependencies: [] });
        expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
      });

      describe("integration: workflow drained end-to-end", () => {
        let dataSource: DataSource;

        beforeEach(async () => {
          dataSource = buildDataSource();
          await dataSource.initialize();
        });

        afterEach(async () => {
          if (dataSource.isInitialized) await dataSource.destroy();
        });

        it("Result.data carries { areaSqMeters: <positive number> } for each completed task", async () => {
          // Loads the polygonArea_only fixture (two queued tasks), drains the
          // worker, and asserts the area-output contract on every Result.
          const factory = new WorkflowFactory(dataSource);
          const workflow = await factory.createWorkflowFromYAML(
            FIXTURE,
            "client-happy",
            VALID_POLYGON,
          );

          await drainWorker(dataSource);

          const taskRepository = dataSource.getRepository(Task);
          const resultRepository = dataSource.getRepository(Result);
          const tasks = await taskRepository.find({
            where: { workflow: { workflowId: workflow.workflowId } },
            relations: ["workflow"],
            order: { stepNumber: "ASC" },
          });
          expect(tasks).toHaveLength(2);
          for (const task of tasks) {
            expect(task.status).toBe(TaskStatus.Completed);
            expect(task.resultId).toBeTruthy();
            const result = await resultRepository.findOneOrFail({
              where: { resultId: task.resultId },
            });
            expect(result.error).toBeNull();
            const parsed = JSON.parse(result.data!) as { areaSqMeters: number };
            expect(parsed.areaSqMeters).toBeGreaterThan(0);
          }
        });
      });
    });

    describe("edge inputs that still respect the output contract", () => {
      it("returns 0 m² for a degenerate (collinear) polygon ring", async () => {
        // Locked to @turf/area's actual behavior: it returns 0 for a degenerate
        // ring rather than throwing. See PRD §Task 1 Definition of Done.
        const degenerate = {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]],
        };
        const job = new PolygonAreaJob();
        const result = await job.run({ task: makeTask(JSON.stringify(degenerate)), dependencies: [] });
        expect(result.areaSqMeters).toBe(0);
      });
    });
  });
});

describe("error", () => {
  const VALID_POLYGON = JSON.stringify({
    type: "Polygon",
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  });

  const makeTask = (geoJson: string): Task =>
    ({
      taskId: "task-under-test",
      geoJson,
      taskType: "polygonArea",
    }) as Task;

  const buildDataSource = (): DataSource =>
    new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      entities: [Task, Result, Workflow],
      synchronize: true,
      logging: false,
    });

  // Readme §1 R2: "Ensure that the job handles invalid GeoJSON gracefully and marks the task as failed."
  describe("Readme §1 R2 — handles invalid GeoJSON gracefully and marks the task as failed", () => {
    describe("marks the task failed and persists structured Result.error on invalid GeoJSON", () => {
      it("PolygonAreaJob throws a descriptive Error when geoJson is not valid JSON", async () => {
        const job = new PolygonAreaJob();
        await expect(
          job.run({ task: makeTask("not-valid-json{"), dependencies: [] }),
        ).rejects.toThrow(/Invalid GeoJSON|parse/i);
      });

      it("PolygonAreaJob throws when the GeoJSON is not a Polygon (e.g. Point)", async () => {
        const point = { type: "Point", coordinates: [0, 0] };
        const job = new PolygonAreaJob();
        await expect(
          job.run({ task: makeTask(JSON.stringify(point)), dependencies: [] }),
        ).rejects.toThrow(/Polygon/);
      });

      describe("runner-level persistence", () => {
        let dataSource: DataSource;

        beforeEach(async () => {
          dataSource = buildDataSource();
          await dataSource.initialize();
        });

        afterEach(async () => {
          if (dataSource.isInitialized) await dataSource.destroy();
        });

        it("when the job throws, persists Result with data=null and a structured error, and links the task to that Result", async () => {
          // Builds a single queued polygonArea task with malformed JSON, runs it
          // through TaskRunner, then asserts the failure side effects: Task is
          // marked Failed with a resultId, and the linked Result has data=null
          // and a JSON-stringified { message, reason: 'job_error', stack } whose
          // stack is capped at 10 lines.
          const workflowRepository = dataSource.getRepository(Workflow);
          const taskRepository = dataSource.getRepository(Task);
          const resultRepository = dataSource.getRepository(Result);

          const workflow = await workflowRepository.save(
            Object.assign(new Workflow(), {
              clientId: "c1",
              status: WorkflowStatus.Initial,
            }),
          );

          const task = await taskRepository.save(
            Object.assign(new Task(), {
              clientId: "c1",
              // malformed JSON — PolygonAreaJob will throw at JSON.parse
              geoJson: "not-json{",
              status: TaskStatus.Queued,
              taskType: "polygonArea",
              stepNumber: 1,
              workflow: workflow,
            }),
          );

          const runner = new TaskRunner(taskRepository);
          await expect(runner.run(task)).rejects.toThrow();

          const refreshed = await taskRepository.findOneOrFail({
            where: { taskId: task.taskId },
          });
          expect(refreshed.status).toBe(TaskStatus.Failed);
          expect(refreshed.resultId).toBeTruthy();

          const stored = await resultRepository.findOneOrFail({
            where: { resultId: refreshed.resultId },
          });
          expect(stored.data).toBeNull();
          expect(stored.error).toBeTruthy();

          const parsed = JSON.parse(stored.error!) as {
            message: string;
            reason: string;
            stack: string;
          };
          expect(parsed.reason).toBe("job_error");
          expect(parsed.message).toMatch(/Invalid GeoJSON|parse/i);
          expect(typeof parsed.stack).toBe("string");
          expect(parsed.stack.split("\n").length).toBeLessThanOrEqual(10);
        });
      });
    });


    describe("worker keeps running after a failed task (US2, US20)", () => {
      let dataSource: DataSource;

      beforeEach(async () => {
        dataSource = buildDataSource();
        await dataSource.initialize();
      });

      afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
      });

      /**
       * Manual-drain helper — replaces the production 5s `setTimeout` worker
       * loop for tests. Drives `TaskRunner.run` over every queued task in
       * step-number order until the queue is empty, swallowing per-task errors
       * so worker isolation can be asserted on the visible side effects.
       */
      async function drainWorker(): Promise<void> {
        const taskRepository = dataSource.getRepository(Task);
        const runner = new TaskRunner(taskRepository);
        for (let i = 0; i < 100; i += 1) {
          const next = await taskRepository.findOne({
            where: { status: TaskStatus.Queued },
            relations: ["workflow"],
            order: { stepNumber: "ASC" },
          });
          if (!next) return;
          try {
            await runner.run(next);
          } catch {
            // Worker isolation: a single failed task must not stop the loop.
          }
        }
        throw new Error(
          "drainWorker: too many iterations — possible infinite loop",
        );
      }

      it("a malformed task in one workflow fails with a structured Result.error and a queued task in a separate workflow still completes", async () => {
        // Worker isolation (US2, US20): the worker loop must survive a single
        // task failure. Under Wave 3 fail-fast (PRD §Decision 2), any failure
        // in a workflow sweeps that workflow's other waiting/queued siblings to
        // skipped — so the "next queued task still completes" assertion has to
        // live in a SEPARATE workflow. We seed two single-step workflows: WF1's
        // task is malformed (will fail), WF2's task is valid (must still
        // complete). Drains the worker and asserts both side effects.
        const factory = new WorkflowFactory(dataSource);
        const failingWorkflow = await factory.createWorkflowFromYAML(
          path.join(__dirname, "fixtures", "polygonArea_single.yml"),
          "client-failing",
          VALID_POLYGON,
        );
        const successWorkflow = await factory.createWorkflowFromYAML(
          path.join(__dirname, "fixtures", "polygonArea_single.yml"),
          "client-success",
          VALID_POLYGON,
        );

        const taskRepository = dataSource.getRepository(Task);
        const failingTasks = await taskRepository.find({
          where: { workflow: { workflowId: failingWorkflow.workflowId } },
        });
        failingTasks[0].geoJson = "not-json{";
        await taskRepository.save(failingTasks[0]);

        await drainWorker();

        const refreshedFailing = await taskRepository.findOneOrFail({
          where: { workflow: { workflowId: failingWorkflow.workflowId } },
        });
        const refreshedSuccess = await taskRepository.findOneOrFail({
          where: { workflow: { workflowId: successWorkflow.workflowId } },
        });
        expect(refreshedFailing.status).toBe(TaskStatus.Failed);
        expect(refreshedSuccess.status).toBe(TaskStatus.Completed);

        const resultRepository = dataSource.getRepository(Result);
        const failedResult = await resultRepository.findOneOrFail({
          where: { resultId: refreshedFailing.resultId },
        });
        expect(failedResult.data).toBeNull();
        expect(failedResult.error).toBeTruthy();
        const parsedError = JSON.parse(failedResult.error!) as {
          message: string;
          reason: string;
          stack: string;
        };
        expect(parsedError.reason).toBe("job_error");
        expect(parsedError.message).toMatch(/Invalid GeoJSON|parse/i);
        expect(parsedError.stack.split("\n").length).toBeLessThanOrEqual(10);

        const successResult = await resultRepository.findOneOrFail({
          where: { resultId: refreshedSuccess.resultId },
        });
        expect(successResult.error).toBeNull();
        const parsedSuccess = JSON.parse(successResult.data!) as {
          areaSqMeters: number;
        };
        expect(parsedSuccess.areaSqMeters).toBeGreaterThan(0);
      });
    });
  });
});
