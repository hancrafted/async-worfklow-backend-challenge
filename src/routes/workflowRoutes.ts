import { Router, type Response } from 'express';
import { In, IsNull, type DataSource, type EntityManager } from 'typeorm';
import { AppDataSource } from '../data-source';
import type { Task } from '../models/Task';
import { Result } from '../models/Result';
import { Workflow, WorkflowStatus } from '../models/Workflow';
import { TaskStatus } from '../models/Task';
import { ApiErrorCode, errorResponse } from '../utils/errorResponse';
import { JobErrorReason } from '../utils/serializeJobError';
import {
    synthesizeFinalResult,
    type FinalResultPayload,
} from '../workflows/synthesizeFinalResult';

const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
    WorkflowStatus.Completed,
    WorkflowStatus.Failed,
]);

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

    router.get('/:id/results', async (req, res) => {
        await handleGetWorkflowResults(options.dataSource, req.params.id, res);
    });

    return router;
}

/**
 * `/:id/results` handler body, extracted to keep `createWorkflowRouter`
 * under the per-function line ceiling. Strict-completion policy (literal
 * Readme §Task 6 — supersedes the original lenient terminal policy, see
 * issue #22 / `interview/design_decisions.md` §Task 6 follow-up):
 *   - 404 WORKFLOW_NOT_FOUND for unknown ids,
 *   - 400 WORKFLOW_NOT_TERMINAL for `initial` / `in_progress`,
 *   - 400 WORKFLOW_FAILED for `failed` (failure detail surfaces via
 *     `GET /workflow/:id/status` under per-task `failureReason`),
 *   - 200 { workflowId, status, finalResult } for `completed` (with the
 *     lazy-patch path for terminal rows whose `finalResult IS NULL`).
 * Read-only on every branch — never advances workflow lifecycle
 * (PRD §Implementation Decision 13).
 */
async function handleGetWorkflowResults(
    dataSource: DataSource,
    workflowId: string,
    res: Response,
): Promise<void> {
    const workflow = await dataSource.getRepository(Workflow).findOne({
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
    if (!TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
        errorResponse(
            res,
            400,
            ApiErrorCode.WORKFLOW_NOT_TERMINAL,
            `Workflow with id '${workflowId}' is not terminal (status: ${workflow.status})`,
        );
        return;
    }
    if (workflow.status === WorkflowStatus.Failed) {
        errorResponse(
            res,
            400,
            ApiErrorCode.WORKFLOW_FAILED,
            `Workflow with id '${workflowId}' failed; results are unavailable. Inspect /workflow/${workflowId}/status for per-task failureReason.`,
        );
        return;
    }

    let finalResult: FinalResultPayload;
    if (workflow.finalResult !== null) {
        finalResult = JSON.parse(workflow.finalResult) as FinalResultPayload;
    } else {
        finalResult = await dataSource.transaction((entityManager) =>
            applyLazyFinalResultPatch(entityManager, workflow),
        );
    }

    res.status(200).json({
        workflowId: workflow.workflowId,
        status: workflow.status,
        finalResult,
    });
}

/**
 * Lazy-patch helper for `Workflow.finalResult` (PRD §Implementation Decision
 * 8 / Task 6). Loads the workflow's `Result` rows, synthesizes the public
 * payload via the shared `synthesizeFinalResult(...)` helper (single source
 * of truth — same shape the runner persists eagerly), and conditionally
 * persists the column under `WHERE finalResult IS NULL` so concurrent eager
 * writes always win. Returns the synthesized payload regardless of whether
 * the UPDATE matched — the read handler returns this to the caller.
 *
 * Never advances workflow lifecycle (PRD §Decision 13 — only the runner does).
 */
export async function applyLazyFinalResultPatch(
    entityManager: EntityManager,
    workflow: Workflow,
): Promise<FinalResultPayload> {
    const taskIds = workflow.tasks.map((task) => task.taskId);
    const results = taskIds.length === 0
        ? []
        : await entityManager.getRepository(Result).find({
            where: { taskId: In(taskIds) },
        });
    const payload = synthesizeFinalResult(workflow, workflow.tasks, results);
    await entityManager.getRepository(Workflow).update(
        { workflowId: workflow.workflowId, finalResult: IsNull() },
        { finalResult: JSON.stringify(payload) },
    );
    return payload;
}

const defaultRouter = createWorkflowRouter({ dataSource: AppDataSource });

export default defaultRouter;
