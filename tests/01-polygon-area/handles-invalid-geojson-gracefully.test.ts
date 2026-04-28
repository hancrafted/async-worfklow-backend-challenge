import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { PolygonAreaJob } from "../../src/jobs/PolygonAreaJob";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskRunner, TaskStatus } from "../../src/workers/taskRunner";
import {
  WorkflowFactory,
  WorkflowStatus,
} from "../../src/workflows/WorkflowFactory";

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
