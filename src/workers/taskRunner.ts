import type { Repository, EntityManager } from 'typeorm';
import { Task } from '../models/Task';
import { getJobForTaskType } from '../jobs/JobFactory';
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import { Workflow } from "../models/Workflow";
import { Result } from "../models/Result";
import { serializeJobError, type SerializedJobError } from '../utils/serializeJobError';

export enum TaskStatus {
    Queued = 'queued',
    Waiting = 'waiting',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed',
    Skipped = 'skipped'
}

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Skipped,
]);

type JobOutcome =
    | { status: TaskStatus.Completed; data: unknown }
    | { status: TaskStatus.Failed; error: SerializedJobError; thrown: unknown };

export class TaskRunner {
    constructor(
        private taskRepository: Repository<Task>,
    ) {}

    /**
     * Runs the appropriate job based on the task's type and persists the
     * terminal task state plus the workflow lifecycle update in a single
     * transaction (CLAUDE.md §Transactions, PRD §Decision 8).
     * @param task - The task entity that determines which job to run.
     * @throws If the job fails, it rethrows the original error after the
     *         terminal Failed state and lifecycle update have been committed.
     */
    async run(task: Task): Promise<void> {
        task.progress = 'starting job...';
        await this.taskRepository.save(task);

        const outcome = await this.executeJob(task);

        await this.taskRepository.manager.transaction(async (entityManager) => {
            await this.persistTerminalTaskState(entityManager, task, outcome);
            await this.evaluateWorkflowLifecycle(entityManager, task.workflowId);
        });

        if (outcome.status === TaskStatus.Failed) throw outcome.thrown;
    }

    /** Invokes the job and normalises success / failure into a JobOutcome. */
    private async executeJob(task: Task): Promise<JobOutcome> {
        const job = getJobForTaskType(task.taskType);
        try {
            // eslint-disable-next-line no-console -- TODO: replace with structured logger (PRD §Decision 11)
            console.log(`Starting job ${task.taskType} for task ${task.taskId}...`);
            const data = await job.run({ task, dependencies: [] });
            // eslint-disable-next-line no-console -- TODO: replace with structured logger (PRD §Decision 11)
            console.log(`Job ${task.taskType} for task ${task.taskId} completed successfully.`);
            return { status: TaskStatus.Completed, data };
        } catch (error) {
            console.error(`Error running job ${task.taskType} for task ${task.taskId}:`, error);
            return { status: TaskStatus.Failed, error: serializeJobError(error), thrown: error };
        }
    }

    /** Writes the Result row and flips the task to its terminal status. */
    private async persistTerminalTaskState(
        entityManager: EntityManager,
        task: Task,
        outcome: JobOutcome,
    ): Promise<void> {
        const result = new Result();
        result.taskId = task.taskId;
        if (outcome.status === TaskStatus.Completed) {
            result.data = JSON.stringify(outcome.data ?? {});
        } else {
            result.data = null;
            result.error = JSON.stringify(outcome.error);
        }
        await entityManager.getRepository(Result).save(result);
        task.resultId = result.resultId;
        task.status = outcome.status;
        task.progress = null;
        await entityManager.getRepository(Task).save(task);
    }

    /**
     * PRD §Decision 8 — re-evaluates workflow lifecycle inside the post-task
     * transaction. The workflow only transitions to a terminal status once
     * every task is terminal; otherwise it keeps its current non-terminal
     * status (Initial is bumped to InProgress at claim time, PRD §Decision 9).
     */
    private async evaluateWorkflowLifecycle(
        entityManager: EntityManager,
        workflowId: string,
    ): Promise<void> {
        const workflowRepository = entityManager.getRepository(Workflow);
        const workflow = await workflowRepository.findOne({
            where: { workflowId },
            relations: ['tasks'],
        });
        if (!workflow) return;
        // Defence-in-depth: skip when the workflow is already terminal (PRD §Decision 8).
        if (workflow.status === WorkflowStatus.Completed || workflow.status === WorkflowStatus.Failed) return;

        const allTerminal = workflow.tasks.every((t) =>
            TERMINAL_TASK_STATUSES.has(t.status),
        );
        if (!allTerminal) return;

        const anyFailed = workflow.tasks.some((t) => t.status === TaskStatus.Failed);
        workflow.status = anyFailed ? WorkflowStatus.Failed : WorkflowStatus.Completed;
        await workflowRepository.save(workflow);
    }
}