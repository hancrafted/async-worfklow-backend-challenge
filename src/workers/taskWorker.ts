import type { Repository } from 'typeorm';
import { AppDataSource } from '../data-source';
import { Task } from '../models/Task';
import { Workflow, WorkflowStatus } from '../models/Workflow';
import { TaskRunner, TaskStatus } from './taskRunner';

const POLL_INTERVAL_MS = 5000;

/**
 * Runs at most one queued task. Returns `true` if a task was claimed and
 * driven to a terminal state (or threw — in which case `TaskRunner` already
 * persisted the failure), `false` only when no `queued` row remains.
 *
 * The claim primitive (PRD §Decision 10) is the conditional UPDATE
 * `WHERE taskId=? AND status='queued'`: two workers picking the same
 * candidate cannot both win — the loser sees `affected === 0` and immediately
 * tries the next candidate without sleeping. The same transaction also bumps
 * the parent workflow from `initial → in_progress` (PRD §Decision 9 — Wave 1)
 * via an idempotent `WHERE status='initial'` UPDATE.
 */
export async function tickOnce(taskRepository: Repository<Task>): Promise<boolean> {
    while (true) {
        const candidate = await taskRepository.findOne({
            where: { status: TaskStatus.Queued },
            relations: ['workflow'],
        });
        if (!candidate) return false;

        const claimed = await claimTaskAndBumpWorkflow(taskRepository, candidate);
        if (!claimed) continue;

        candidate.status = TaskStatus.InProgress;
        const taskRunner = new TaskRunner(taskRepository);
        try {
            await taskRunner.run(candidate);
        } catch (error) {
            console.error('Task execution failed. Task status has already been updated by TaskRunner.');
            console.error(error);
        }
        return true;
    }
}

/**
 * Atomically transitions the candidate task `queued → in_progress` and bumps
 * its workflow `initial → in_progress` in the same transaction. Returns
 * `true` when this caller won the claim race, `false` when another worker
 * beat us to the task (the workflow bump is skipped in that branch).
 */
async function claimTaskAndBumpWorkflow(
    taskRepository: Repository<Task>,
    candidate: Task,
): Promise<boolean> {
    return taskRepository.manager.transaction(async (entityManager) => {
        const claim = await entityManager.getRepository(Task).update(
            { taskId: candidate.taskId, status: TaskStatus.Queued },
            { status: TaskStatus.InProgress },
        );
        if (claim.affected !== 1) return false;

        await entityManager.getRepository(Workflow).update(
            { workflowId: candidate.workflowId, status: WorkflowStatus.Initial },
            { status: WorkflowStatus.InProgress },
        );
        return true;
    });
}

export async function taskWorker(): Promise<void> {
    const taskRepository = AppDataSource.getRepository(Task);

    while (true) {
        const ran = await tickOnce(taskRepository);
        if (!ran) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }
}