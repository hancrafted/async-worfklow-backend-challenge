import "reflect-metadata";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskRunner, TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowFactory } from "../../src/workflows/WorkflowFactory";

const VALID_POLYGON = JSON.stringify({
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
});

const FIXTURE = path.join(
  __dirname,
  "..",
  "test-workflows",
  "polygonArea_only.yml",
);

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
 * order until the queue is empty, swallowing per-task errors so worker
 * isolation (US2, US20) can be asserted on the visible side effects.
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

describe("polygonArea workflow integration", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = buildDataSource();
    await ds.initialize();
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it("happy path: a polygonArea task completes and its Result.data carries { areaSqMeters: <number> }", async () => {
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

  it("worker isolation: a malformed task fails with a structured Result.error and the next queued task still completes (US2, US20)", async () => {
    const factory = new WorkflowFactory(ds);
    const wf = await factory.createWorkflowFromYAML(
      FIXTURE,
      "client-mixed",
      VALID_POLYGON,
    );

    // After WorkflowFactory has saved both tasks with the same valid geoJson,
    // patch the FIRST task's geoJson to malformed input so it fails. The
    // second queued task must still complete after the failure — this is the
    // worker-isolation assertion (US2, US20). We mutate via the repo (no
    // production code touched).
    const taskRepo = ds.getRepository(Task);
    const tasks = await taskRepo.find({
      where: { workflow: { workflowId: wf.workflowId } },
      order: { stepNumber: "ASC" },
    });
    tasks[0].geoJson = "not-json{";
    await taskRepo.save(tasks[0]);

    await drainWorker(ds);

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
