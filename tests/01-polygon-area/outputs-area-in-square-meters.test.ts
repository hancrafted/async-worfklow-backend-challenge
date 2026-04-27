import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { PolygonAreaJob } from "../../src/jobs/PolygonAreaJob";
import { getJobForTaskType } from "../../src/jobs/JobFactory";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskRunner, TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";

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
async function drainWorker(ds: DataSource): Promise<void> {
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

      const result = await job.run(makeTask(JSON.stringify(polygon)));

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
      const result = await job.run(makeTask(JSON.stringify(feature)));
      expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
    });

    describe("integration: workflow drained end-to-end", () => {
      let ds: DataSource;

      beforeEach(async () => {
        ds = buildDataSource();
        await ds.initialize();
      });

      afterEach(async () => {
        if (ds.isInitialized) await ds.destroy();
      });

      it("Result.data carries { areaSqMeters: <positive number> } for each completed task", async () => {
        // Loads the polygonArea_only fixture (two queued tasks), drains the
        // worker, and asserts the area-output contract on every Result.
        const factory = new WorkflowFactory(ds);
        const wf = await factory.createWorkflowFromYAML(
          FIXTURE,
          "client-happy",
          VALID_POLYGON,
        );

        await drainWorker(ds);

        const taskRepo = ds.getRepository(Task);
        const resultRepo = ds.getRepository(Result);
        const tasks = await taskRepo.find({
          where: { workflow: { workflowId: wf.workflowId } },
          relations: ["workflow"],
          order: { stepNumber: "ASC" },
        });
        expect(tasks).toHaveLength(2);
        for (const t of tasks) {
          expect(t.status).toBe(TaskStatus.Completed);
          expect(t.resultId).toBeTruthy();
          const r = await resultRepo.findOneOrFail({
            where: { resultId: t.resultId },
          });
          expect(r.error).toBeNull();
          const parsed = JSON.parse(r.data!) as { areaSqMeters: number };
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
      const result = await job.run(makeTask(JSON.stringify(degenerate)));
      expect(result.areaSqMeters).toBe(0);
    });
  });
});
