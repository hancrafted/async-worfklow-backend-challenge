import { In, type Repository, type EntityManager } from 'typeorm';
import { Task } from '../models/Task';
import { getJobForTaskType } from '../jobs/JobFactory';
import { WorkflowStatus } from "../workflows/WorkflowFactory";
import { Workflow } from "../models/Workflow";
import { Result } from "../models/Result";
import type { JobDependencyOutput } from '../jobs/Job';
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
            const workflow = await this.loadWorkflowWithTasks(entityManager, task.workflowId);
            if (!workflow) return;
            if (outcome.status === TaskStatus.Completed) {
                await this.promoteReadyTasks(entityManager, workflow);
            }
            await this.evaluateWorkflowLifecycle(entityManager, workflow);
        });

        if (outcome.status === TaskStatus.Failed) throw outcome.thrown;
    }

    /** Invokes the job and normalises success / failure into a JobOutcome. */
    private async executeJob(task: Task): Promise<JobOutcome> {
        const job = getJobForTaskType(task.taskType);
        try {
            // eslint-disable-next-line no-console -- TODO: replace with structured logger (PRD §Decision 11)
            console.log(`Starting job ${task.taskType} for task ${task.taskId}...`);
            const dependencies = await this.buildDependencyEnvelope(task);
            const data = await job.run({ task, dependencies });
            // eslint-disable-next-line no-console -- TODO: replace with structured logger (PRD §Decision 11)
            console.log(`Job ${task.taskType} for task ${task.taskId} completed successfully.`);
            return { status: TaskStatus.Completed, data };
        } catch (error) {
            console.error(`Error running job ${task.taskType} for task ${task.taskId}:`, error);
            return { status: TaskStatus.Failed, error: serializeJobError(error), thrown: error };
        }
    }

    /**
     * Builds the upstream-output envelope passed to `job.run` (PRD §Decision 5
     * + §Decision 7). Returns an array of `{ stepNumber, taskType, taskId,
     * output }` entries — one per `task.dependsOn` taskId — sorted by
     * `stepNumber` ascending. Reads each upstream `Result.data` via a single
     * batched `IN (...)` query and parses it into the envelope's `output`
     * field. Empty `dependsOn` short-circuits with no DB round-trip.
     *
     * Throws a descriptive Error if any declared upstream is missing a
     * `Result` row — promotion only fires after the parent's terminal
     * transaction commits Result + status together, so a miss here means
     * the runner was invoked on a malformed state.
     */
    private async buildDependencyEnvelope(task: Task): Promise<JobDependencyOutput[]> {
        if (task.dependsOn.length === 0) return [];
        const taskRepository = this.taskRepository.manager.getRepository(Task);
        const resultRepository = this.taskRepository.manager.getRepository(Result);
        const upstreamTasks = await taskRepository.find({
            where: { taskId: In(task.dependsOn) },
        });
        const upstreamResults = await resultRepository.find({
            where: { taskId: In(task.dependsOn) },
        });
        const resultByTaskId = new Map<string, Result>();
        for (const result of upstreamResults) resultByTaskId.set(result.taskId, result);

        const envelope: JobDependencyOutput[] = upstreamTasks.map((upstream) => {
            const result = resultByTaskId.get(upstream.taskId);
            if (!result || result.data === null) {
                throw new Error(
                    `Missing upstream Result for dependency taskId=${upstream.taskId} stepNumber=${upstream.stepNumber}`,
                );
            }
            return {
                stepNumber: upstream.stepNumber,
                taskType: upstream.taskType,
                taskId: upstream.taskId,
                output: JSON.parse(result.data) as unknown,
            };
        });
        envelope.sort((a, b) => a.stepNumber - b.stepNumber);
        return envelope;
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
     * Single workflow+tasks read for the post-task transaction. Promotion and
     * lifecycle evaluation share this read to avoid an N+1 (PRD §Decision 8).
     */
    private async loadWorkflowWithTasks(
        entityManager: EntityManager,
        workflowId: string,
    ): Promise<Workflow | null> {
        return entityManager.getRepository(Workflow).findOne({
            where: { workflowId },
            relations: ['tasks'],
        });
    }

    /**
     * PRD §Decision 9 — after a task transitions to Completed, scans waiting
     * siblings whose entire `dependsOn` set is now Completed and flips them to
     * Queued. The conditional `WHERE status='waiting'` makes the per-row
     * UPDATE naturally idempotent under concurrent terminal transitions.
     */
    private async promoteReadyTasks(
        entityManager: EntityManager,
        workflow: Workflow,
    ): Promise<void> {
        const taskRepository = entityManager.getRepository(Task);
        const completedTaskIds = new Set(
            workflow.tasks
                .filter((t) => t.status === TaskStatus.Completed)
                .map((t) => t.taskId),
        );
        const waiters = workflow.tasks.filter((t) => t.status === TaskStatus.Waiting);
        for (const waiter of waiters) {
            const allDepsCompleted = waiter.dependsOn.every((depId) =>
                completedTaskIds.has(depId),
            );
            if (!allDepsCompleted) continue;
            await taskRepository.update(
                { taskId: waiter.taskId, status: TaskStatus.Waiting },
                { status: TaskStatus.Queued },
            );
        }
    }

    /**
     * PRD §Decision 8 — re-evaluates workflow lifecycle inside the post-task
     * transaction. The workflow only transitions to a terminal status once
     * every task is terminal; otherwise it keeps its current non-terminal
     * status (Initial is bumped to InProgress at claim time, PRD §Decision 9).
     * Operates on the pre-loaded workflow snapshot from `loadWorkflowWithTasks`
     * — promotion (waiting → queued) does not change terminal-ness, so the
     * snapshot's `allTerminal` / `anyFailed` computation is unaffected.
     */
    private async evaluateWorkflowLifecycle(
        entityManager: EntityManager,
        workflow: Workflow,
    ): Promise<void> {
        // Defence-in-depth: skip when the workflow is already terminal (PRD §Decision 8).
        if (workflow.status === WorkflowStatus.Completed || workflow.status === WorkflowStatus.Failed) return;

        const allTerminal = workflow.tasks.every((t) =>
            TERMINAL_TASK_STATUSES.has(t.status),
        );
        if (!allTerminal) return;

        const anyFailed = workflow.tasks.some((t) => t.status === TaskStatus.Failed);
        workflow.status = anyFailed ? WorkflowStatus.Failed : WorkflowStatus.Completed;
        await entityManager.getRepository(Workflow).save(workflow);
    }
}