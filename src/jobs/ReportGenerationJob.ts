import type { Job, JobContext, JobDependencyOutput } from "./Job";

export interface ReportGenerationTaskEntry {
  stepNumber: number;
  taskType: string;
  output: unknown;
}

export interface ReportGenerationResult {
  workflowId: string;
  tasks: ReportGenerationTaskEntry[];
  finalReport: string;
}

/**
 * Aggregates upstream task outputs into a single JSON report.
 *
 * Output shape (PRD §Task 2 / Issue #3):
 *   { workflowId, tasks: [{ stepNumber, taskType, output }], finalReport }
 *
 * `tasks[]` is ordered by `stepNumber` ascending and exposes `stepNumber` —
 * not the internal `taskId` UUID — as the public identifier per PRD
 * §Decision 4. `finalReport` is a framework-supplied summary string; per-task
 * error reporting is handled by the framework-synthesized `finalResult`
 * (Task 4) under fail-fast, so this job never sees failed-dep envelopes.
 */
export class ReportGenerationJob implements Job {
  async run(context: JobContext): Promise<ReportGenerationResult> {
    const { task, dependencies } = context;
    const tasks = this.buildTaskEntries(dependencies);
    return {
      workflowId: task.workflowId,
      tasks,
      finalReport: this.buildFinalReport(task.workflowId, tasks.length),
    };
  }

  private buildTaskEntries(
    dependencies: JobDependencyOutput[],
  ): ReportGenerationTaskEntry[] {
    const entries = dependencies.map((dep) => ({
      stepNumber: dep.stepNumber,
      taskType: dep.taskType,
      output: dep.output,
    }));
    entries.sort((a, b) => a.stepNumber - b.stepNumber);
    return entries;
  }

  private buildFinalReport(workflowId: string, taskCount: number): string {
    return `Generated report for workflow ${workflowId} with ${taskCount} tasks`;
  }
}
