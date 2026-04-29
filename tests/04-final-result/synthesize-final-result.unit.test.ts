import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { synthesizeFinalResult } from "../../src/workflows/synthesizeFinalResult";
import { Task } from "../../src/models/Task";
import { Result } from "../../src/models/Result";
import { Workflow } from "../../src/models/Workflow";
import { TaskStatus } from "../../src/models/Task";
import { JobErrorReason } from "../../src/utils/serializeJobError";

// Pure-function unit tests for the framework-owned `finalResult` synthesizer.
// No DB is involved — we hand in plain entity literals so the test reads as
// a contract check on the output shape (PRD §Decision 8).

function makeTask(partial: Partial<Task>): Task {
  return Object.assign(new Task(), {
    clientId: "c1",
    geoJson: "{}",
    dependsOn: [],
    workflowId: "wf-1",
    ...partial,
  });
}

function makeResult(partial: Partial<Result>): Result {
  return Object.assign(new Result(), { ...partial });
}

function makeWorkflow(workflowId: string): Workflow {
  return Object.assign(new Workflow(), { workflowId });
}

describe("synthesizeFinalResult — happy path", () => {
  it("emits ordered task entries with `output` for completed tasks and omits failedAtStep", () => {
    // Two-step success: tasks deliberately handed in REVERSE stepNumber order
    // so the assertion proves the helper sorts ascending (US15 deterministic).
    const workflow = makeWorkflow("wf-1");
    const taskTwo = makeTask({
      taskId: "t-2",
      taskType: "analysis",
      stepNumber: 2,
      status: TaskStatus.Completed,
    });
    const taskOne = makeTask({
      taskId: "t-1",
      taskType: "polygonArea",
      stepNumber: 1,
      status: TaskStatus.Completed,
    });
    const resultTwo = makeResult({
      taskId: "t-2",
      data: JSON.stringify({ analysed: true }),
    });
    const resultOne = makeResult({
      taskId: "t-1",
      data: JSON.stringify({ areaSqMeters: 42 }),
    });

    const payload = synthesizeFinalResult(
      workflow,
      [taskTwo, taskOne],
      [resultTwo, resultOne],
    );

    expect(payload.workflowId).toBe("wf-1");
    expect(payload).not.toHaveProperty("failedAtStep");
    expect(payload.tasks).toEqual([
      {
        stepNumber: 1,
        taskType: "polygonArea",
        status: TaskStatus.Completed,
        output: { areaSqMeters: 42 },
      },
      {
        stepNumber: 2,
        taskType: "analysis",
        status: TaskStatus.Completed,
        output: { analysed: true },
      },
    ]);
    // US16: no internal taskId leaks into the payload.
    expect(JSON.stringify(payload)).not.toContain("t-1");
    expect(JSON.stringify(payload)).not.toContain("t-2");
  });
});

describe("synthesizeFinalResult — error path: mixed-failure surfaces failedAtStep + per-task error", () => {
  it("strips error.stack, sets failedAtStep to the lowest failing stepNumber, and skipped entries carry neither output nor error", () => {
    // 4-step fail-fast scenario: step 1 fails, step 2 also failed (artificial
    // — to prove failedAtStep takes the LOWEST failing stepNumber, not the
    // first-encountered), steps 3/4 swept to skipped.
    const workflow = makeWorkflow("wf-mixed");
    const tasks: Task[] = [
      makeTask({ taskId: "t-3", taskType: "notification", stepNumber: 3, status: TaskStatus.Skipped }),
      makeTask({ taskId: "t-1", taskType: "polygonArea", stepNumber: 1, status: TaskStatus.Failed }),
      makeTask({ taskId: "t-2", taskType: "analysis", stepNumber: 2, status: TaskStatus.Failed }),
      makeTask({ taskId: "t-4", taskType: "reportGeneration", stepNumber: 4, status: TaskStatus.Skipped }),
    ];
    // Both Result.error rows include a populated `stack` field — the synth
    // helper MUST strip it before producing the payload (US23).
    const results: Result[] = [
      makeResult({
        taskId: "t-1",
        data: null,
        error: JSON.stringify({
          message: "Boom",
          reason: JobErrorReason.JobError,
          stack: "Error: Boom\n  at thrower (file.ts:1:1)",
        }),
      }),
      makeResult({
        taskId: "t-2",
        data: null,
        error: JSON.stringify({
          message: "Downstream",
          reason: JobErrorReason.JobError,
          stack: "Error: Downstream\n  at other (file.ts:2:2)",
        }),
      }),
    ];

    const payload = synthesizeFinalResult(workflow, tasks, results);

    expect(payload.workflowId).toBe("wf-mixed");
    expect(payload.failedAtStep).toBe(1);
    expect(payload.tasks).toEqual([
      {
        stepNumber: 1,
        taskType: "polygonArea",
        status: TaskStatus.Failed,
        error: { message: "Boom", reason: JobErrorReason.JobError },
      },
      {
        stepNumber: 2,
        taskType: "analysis",
        status: TaskStatus.Failed,
        error: { message: "Downstream", reason: JobErrorReason.JobError },
      },
      {
        stepNumber: 3,
        taskType: "notification",
        status: TaskStatus.Skipped,
      },
      {
        stepNumber: 4,
        taskType: "reportGeneration",
        status: TaskStatus.Skipped,
      },
    ]);
    // Defence-in-depth: scan the serialized payload for the `stack` field.
    expect(JSON.stringify(payload)).not.toContain("stack");
  });
});
