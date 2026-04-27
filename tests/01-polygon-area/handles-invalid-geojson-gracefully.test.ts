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

// Readme §1 R2: "Ensure that the job handles invalid GeoJSON gracefully and marks the task as failed."
describe("Readme §1 R2 — handles invalid GeoJSON gracefully and marks the task as failed", () => {
  describe("marks the task failed and persists structured Result.error on invalid GeoJSON", () => {
    it("PolygonAreaJob throws a descriptive Error when geoJson is not valid JSON", async () => {
      const job = new PolygonAreaJob();
      await expect(job.run(makeTask("not-valid-json{"))).rejects.toThrow(
        /Invalid GeoJSON|parse/i,
      );
    });

    it("PolygonAreaJob throws when the GeoJSON is not a Polygon (e.g. Point)", async () => {
      const point = { type: "Point", coordinates: [0, 0] };
      const job = new PolygonAreaJob();
      await expect(job.run(makeTask(JSON.stringify(point)))).rejects.toThrow(
        /Polygon/,
      );
    });

    describe("runner-level persistence", () => {
      let ds: DataSource;

      beforeEach(async () => {
        ds = buildDataSource();
        await ds.initialize();
      });

      afterEach(async () => {
        if (ds.isInitialized) await ds.destroy();
      });

      it("when the job throws, persists Result with data=null and a structured error, and links the task to that Result", async () => {
        // Builds a single queued polygonArea task with malformed JSON, runs it
        // through TaskRunner, then asserts the failure side effects: Task is
        // marked Failed with a resultId, and the linked Result has data=null
        // and a JSON-stringified { message, reason: 'job_error', stack } whose
        // stack is capped at 10 lines.
        const workflowRepo = ds.getRepository(Workflow);
        const taskRepo = ds.getRepository(Task);
        const resultRepo = ds.getRepository(Result);

        const wf = await workflowRepo.save(
          Object.assign(new Workflow(), {
            clientId: "c1",
            status: WorkflowStatus.Initial,
          }),
        );

        const task = await taskRepo.save(
          Object.assign(new Task(), {
            clientId: "c1",
            // malformed JSON — PolygonAreaJob will throw at JSON.parse
            geoJson: "not-json{",
            status: TaskStatus.Queued,
            taskType: "polygonArea",
            stepNumber: 1,
            workflow: wf,
          }),
        );

        const runner = new TaskRunner(taskRepo);
        await expect(runner.run(task)).rejects.toThrow();

        const refreshed = await taskRepo.findOneOrFail({
          where: { taskId: task.taskId },
        });
        expect(refreshed.status).toBe(TaskStatus.Failed);
        expect(refreshed.resultId).toBeTruthy();

        const stored = await resultRepo.findOneOrFail({
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
    let ds: DataSource;

    beforeEach(async () => {
      ds = buildDataSource();
      await ds.initialize();
    });

    afterEach(async () => {
      if (ds.isInitialized) await ds.destroy();
    });

    /**
     * Manual-drain helper — replaces the production 5s `setTimeout` worker
     * loop for tests. Drives `TaskRunner.run` over every queued task in
     * step-number order until the queue is empty, swallowing per-task errors
     * so worker isolation can be asserted on the visible side effects.
     */
    async function drainWorker(): Promise<void> {
      const taskRepo = ds.getRepository(Task);
      const runner = new TaskRunner(taskRepo);
      for (let i = 0; i < 100; i += 1) {
        const next = await taskRepo.findOne({
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

    it("a malformed task fails with a structured Result.error and the next queued task still completes", async () => {
      // Creates a 2-task workflow from the fixture, mutates the first task's
      // geoJson to malformed input, drains the worker, then asserts: task[0]
      // is Failed with a structured error AND task[1] is still Completed with
      // valid Result.data — the worker-isolation contract (US2, US20).
      const factory = new WorkflowFactory(ds);
      const wf = await factory.createWorkflowFromYAML(
        FIXTURE,
        "client-mixed",
        VALID_POLYGON,
      );

      const taskRepo = ds.getRepository(Task);
      const tasks = await taskRepo.find({
        where: { workflow: { workflowId: wf.workflowId } },
        order: { stepNumber: "ASC" },
      });
      tasks[0].geoJson = "not-json{";
      await taskRepo.save(tasks[0]);

      await drainWorker();

      const refreshed = await taskRepo.find({
        where: { workflow: { workflowId: wf.workflowId } },
        order: { stepNumber: "ASC" },
      });
      expect(refreshed[0].status).toBe(TaskStatus.Failed);
      expect(refreshed[1].status).toBe(TaskStatus.Completed);

      const resultRepo = ds.getRepository(Result);
      const failResult = await resultRepo.findOneOrFail({
        where: { resultId: refreshed[0].resultId },
      });
      expect(failResult.data).toBeNull();
      expect(failResult.error).toBeTruthy();
      const parsedErr = JSON.parse(failResult.error!) as {
        message: string;
        reason: string;
        stack: string;
      };
      expect(parsedErr.reason).toBe("job_error");
      expect(parsedErr.message).toMatch(/Invalid GeoJSON|parse/i);
      expect(parsedErr.stack.split("\n").length).toBeLessThanOrEqual(10);

      const goodResult = await resultRepo.findOneOrFail({
        where: { resultId: refreshed[1].resultId },
      });
      expect(goodResult.error).toBeNull();
      const parsedGood = JSON.parse(goodResult.data!) as {
        areaSqMeters: number;
      };
      expect(parsedGood.areaSqMeters).toBeGreaterThan(0);
    });
  });
});
