import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DataSource } from "typeorm";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskRunner, TaskStatus } from "../../src/workers/taskRunner";
import { WorkflowStatus } from "../../src/workflows/WorkflowFactory";

const buildDataSource = (): DataSource =>
  new DataSource({
    type: "sqlite",
    database: ":memory:",
    dropSchema: true,
    entities: [Task, Result, Workflow],
    synchronize: true,
    logging: false,
  });

describe("TaskRunner — Result.error persistence on job failure", () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = buildDataSource();
    await ds.initialize();
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it("when the job throws, persists Result with data=null and a structured error, and links the task to that Result", async () => {
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
