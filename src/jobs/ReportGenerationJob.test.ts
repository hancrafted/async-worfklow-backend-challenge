import { describe, it, expect } from "vitest";
import { ReportGenerationJob } from "./ReportGenerationJob";
import type { Task } from "../models/Task";
import type { JobDependencyOutput } from "./Job";

const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    taskId: "report-task",
    workflowId: "workflow-under-test",
    taskType: "reportGeneration",
    ...overrides,
  }) as Task;

const dep = (
  stepNumber: number,
  taskType: string,
  output: unknown,
): JobDependencyOutput => ({
  stepNumber,
  taskType,
  taskId: `task-${stepNumber}`,
  output,
});

// Co-located unit test for ReportGenerationJob — exercises the report shape
// locked in PRD §Task 2 (Issue #3) and Decision 4 (stepNumber-not-taskId).

describe("ReportGenerationJob — report aggregation (PRD §Task 2)", () => {
  describe("happy path", () => {
    it("aggregates context.dependencies into the locked report shape, sorted by stepNumber ASC", async () => {
      // Pass deps in non-sorted order to prove the job re-sorts by stepNumber
      // (PRD §Decision 4 — stepNumber is the public ordering key).
      const job = new ReportGenerationJob();
      const result = await job.run({
        task: makeTask(),
        dependencies: [
          dep(2, "analysis", { country: "Spain" }),
          dep(1, "polygonArea", { areaSqMeters: 1234567 }),
        ],
      });

      expect(result.workflowId).toBe("workflow-under-test");
      expect(result.tasks).toEqual([
        { stepNumber: 1, taskType: "polygonArea", output: { areaSqMeters: 1234567 } },
        { stepNumber: 2, taskType: "analysis", output: { country: "Spain" } },
      ]);
      // PRD §Decision 4 — taskId never leaks into the public report shape.
      expect(JSON.stringify(result)).not.toContain("task-1");
      expect(JSON.stringify(result)).not.toContain("task-2");
      // finalReport is a framework summary string referencing workflow + count.
      expect(result.finalReport).toContain("workflow-under-test");
      expect(result.finalReport).toContain("2");
    });
  });

  describe("error path", () => {
    it("emits a well-formed empty report when dependencies is empty (defensive — runner never calls it this way under fail-fast)", async () => {
      // Although the runner under fail-fast only ever invokes ReportGenerationJob
      // when every upstream is completed, the job itself remains well-defined
      // for the no-dep edge case so a future continue-on-error mode stays sane.
      const job = new ReportGenerationJob();
      const result = await job.run({
        task: makeTask({ workflowId: "workflow-empty" }),
        dependencies: [],
      });

      expect(result.workflowId).toBe("workflow-empty");
      expect(result.tasks).toEqual([]);
      expect(result.finalReport).toContain("workflow-empty");
      expect(result.finalReport).toContain("0");
    });
  });
});
