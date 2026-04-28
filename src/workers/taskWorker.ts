import {Repository} from 'typeorm';
import {AppDataSource} from '../data-source';
import {Task} from '../models/Task';
import {TaskRunner, TaskStatus} from './taskRunner';

const POLL_INTERVAL_MS = 5000;

/**
 * Runs at most one queued task. Returns `true` if a task was claimed and
 * driven to a terminal state (or threw — in which case `TaskRunner` already
 * persisted the failure), `false` only when no `queued` row remains.
 *
 * The claim primitive (PRD §10) is the conditional UPDATE
 * `WHERE taskId=? AND status='queued'`: two workers picking the same
 * candidate cannot both win — the loser sees `affected === 0` and immediately
 * tries the next candidate without sleeping. Single-process today,
 * race-safe for a worker pool tomorrow.
 */
export async function tickOnce(taskRepository: Repository<Task>): Promise<boolean> {
    while (true) {
        const candidate = await taskRepository.findOne({
            where: { status: TaskStatus.Queued },
            relations: ['workflow'],
        });
        if (!candidate) return false;

        const claim = await taskRepository.update(
            { taskId: candidate.taskId, status: TaskStatus.Queued },
            { status: TaskStatus.InProgress },
        );
        if (claim.affected !== 1) continue;

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

export async function taskWorker(): Promise<void> {
    const taskRepository = AppDataSource.getRepository(Task);

    while (true) {
        const ran = await tickOnce(taskRepository);
        if (!ran) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }
}