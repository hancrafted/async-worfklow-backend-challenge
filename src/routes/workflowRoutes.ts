import { Router } from 'express';
import type { DataSource } from 'typeorm';
import { AppDataSource } from '../data-source';
import type { Task } from '../models/Task';
import { Workflow } from '../models/Workflow';
import { TaskStatus } from '../workers/taskRunner';
import { ApiErrorCode, errorResponse } from '../utils/errorResponse';
import { JobErrorReason } from '../utils/serializeJobError';

interface CreateWorkflowRouterOptions {
    dataSource: DataSource;
}

interface StatusTaskEntry {
    stepNumber: number;
    taskType: string;
    status: TaskStatus;
    dependsOn: number[];
    failureReason?: JobErrorReason;
}

/**
 * Pure helper. Translates a task's stored `taskId[]` `dependsOn` array into
 * the user-facing `stepNumber[]` shape (PRD §Decision 4 / US16) by joining
 * against the same workflow's tasks. Insertion order is preserved — the
 * route handler decides whether downstream callers see a sort. Throws when
 * an upstream taskId is missing from `allTasks` (defence-in-depth: a miss
 * means the workflow is in a malformed state, not a user error).
 */
export function translateDependsOnToStepNumbers(
    task: Task,
    allTasks: Task[],
): number[] {
    const stepNumberByTaskId = new Map<string, number>();
    for (const candidate of allTasks) {
        stepNumberByTaskId.set(candidate.taskId, candidate.stepNumber);
    }
    return task.dependsOn.map((upstreamTaskId) => {
        const stepNumber = stepNumberByTaskId.get(upstreamTaskId);
        if (stepNumber === undefined) {
            throw new Error(
                `internal: dependsOn taskId=${upstreamTaskId} not found in workflow tasks`,
            );
        }
        return stepNumber;
    });
}

/**
 * Builds a `/workflow` router bound to a specific DataSource. Read-only —
 * never advances workflow lifecycle (PRD §Implementation Decision 13). The
 * default export wires up production defaults; tests use
 * `createWorkflowRouter({ dataSource })` to inject fixtures.
 */
export function createWorkflowRouter(
    options: CreateWorkflowRouterOptions,
): Router {
    const router = Router();

    router.get('/:id/status', async (req, res) => {
        const workflowId = req.params.id;
        const workflow = await options.dataSource.getRepository(Workflow).findOne({
            where: { workflowId },
            relations: ['tasks'],
        });
        if (!workflow) {
            errorResponse(
                res,
                404,
                ApiErrorCode.WORKFLOW_NOT_FOUND,
                `Workflow with id '${workflowId}' was not found`,
            );
            return;
        }

        const tasks = [...workflow.tasks].sort((a, b) => a.stepNumber - b.stepNumber);
        const completedTasks = tasks.filter((t) => t.status === TaskStatus.Completed).length;
        const taskEntries: StatusTaskEntry[] = tasks.map((task) => {
            const entry: StatusTaskEntry = {
                stepNumber: task.stepNumber,
                taskType: task.taskType,
                status: task.status,
                dependsOn: translateDependsOnToStepNumbers(task, tasks),
            };
            if (task.status === TaskStatus.Failed) entry.failureReason = JobErrorReason.JobError;
            return entry;
        });

        res.status(200).json({
            workflowId: workflow.workflowId,
            status: workflow.status,
            totalTasks: tasks.length,
            completedTasks,
            tasks: taskEntries,
        });
    });

    return router;
}

const defaultRouter = createWorkflowRouter({ dataSource: AppDataSource });

export default defaultRouter;
