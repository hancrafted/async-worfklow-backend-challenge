import type { Repository } from 'typeorm';
import { AppDataSource } from '../data-source';
import { Task } from '../models/Task';
import { Workflow, WorkflowStatus } from '../models/Workflow';
import { TaskRunner, TaskStatus } from './taskRunner';
import * as logger from '../utils/logger';

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
            logger.error('task execution failed; terminal state already persisted by TaskRunner', {
                workflowId: candidate.workflowId,
                taskId: candidate.taskId,
                stepNumber: candidate.stepNumber,
                taskType: candidate.taskType,
                error,
            });
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

/** Mutable shutdown signal shared between the loop and its driver. */
export interface StopSignal {
    stopped: boolean;
}

export type TickFn = () => Promise<boolean>;
export type SleepFn = (sleepMs: number) => Promise<void>;

export interface RunWorkerLoopOptions {
    tickFn: TickFn;
    sleepMs: number;
    sleepFn?: SleepFn;
    stopSignal: StopSignal;
}

const realSleep: SleepFn = (sleepMs) =>
    new Promise((resolve) => setTimeout(resolve, sleepMs));

/**
 * Loop-of-last-resort (PRD §11 / US21). Wraps `tickFn` in try/catch so any
 * runner-level exception is swallowed, logged at `error`, followed by a
 * `sleepFn(sleepMs)` cool-down, and the loop continues. Tests inject a no-op
 * `sleepFn` and flip `stopSignal.stopped` from inside the spy `tickFn` to
 * drive a deterministic, real-timer-free drain (CLAUDE.md §Worker-loop tests).
 */
export async function runWorkerLoop({
    tickFn,
    sleepMs,
    sleepFn = realSleep,
    stopSignal,
}: RunWorkerLoopOptions): Promise<void> {
    while (!stopSignal.stopped) {
        try {
            const ran = await tickFn();
            if (stopSignal.stopped) return;
            if (!ran) {
                logger.warn('worker idle — queue empty, sleeping');
                await sleepFn(sleepMs);
            }
        } catch (error) {
            logger.error('runner-level exception (transient); worker continues', { error });
            if (stopSignal.stopped) return;
            await sleepFn(sleepMs);
        }
    }
}

export async function taskWorker(): Promise<void> {
    const taskRepository = AppDataSource.getRepository(Task);
    const stopSignal: StopSignal = { stopped: false };
    await runWorkerLoop({
        tickFn: () => tickOnce(taskRepository),
        sleepMs: POLL_INTERVAL_MS,
        stopSignal,
    });
}

/** Default in-process worker pool size when WORKER_POOL_SIZE is unset. */
export const DEFAULT_WORKER_POOL_SIZE = 3;

export enum WorkerPoolConfigError {
    INVALID_POOL_SIZE = 'INVALID_POOL_SIZE',
}

/**
 * Boot-time validation error for worker pool configuration. Carries the
 * structured `code` so the boot site can log a discriminator-friendly
 * `error.code` field next to the human message.
 */
export class WorkerPoolConfigValidationError extends Error {
    public readonly code: WorkerPoolConfigError;

    constructor(code: WorkerPoolConfigError, message: string) {
        super(message);
        this.name = 'WorkerPoolConfigValidationError';
        this.code = code;
    }
}

/**
 * Parses the `WORKER_POOL_SIZE` env value (raw string from `process.env`) and
 * returns the resolved pool size. `undefined` or empty string → default 3.
 * Anything else must parse to a positive integer; non-integer, non-numeric,
 * zero, and negative values throw `WorkerPoolConfigValidationError` so the
 * boot site can log + exit non-zero (PRD §10).
 */
export function resolveWorkerPoolSize(
    rawValue: string | undefined,
    defaultSize: number = DEFAULT_WORKER_POOL_SIZE,
): number {
    if (rawValue === undefined || rawValue === '') return defaultSize;
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new WorkerPoolConfigValidationError(
            WorkerPoolConfigError.INVALID_POOL_SIZE,
            `WORKER_POOL_SIZE must be a positive integer, received: '${rawValue}'`,
        );
    }
    return parsed;
}

export interface StartWorkerPoolOptions {
    size: number;
    repository: Repository<Task>;
    sleepMs: number;
    sleepFn?: SleepFn;
    stopSignal: StopSignal;
}

/**
 * Spawns `size` `runWorkerLoop(...)` coroutines that share the same
 * Repository and the same `StopSignal` (PRD §10 / US17, US18). Returns a
 * promise that resolves once every coroutine has exited the loop. Pool size
 * is re-validated here so the in-process call site (tests, alternate boot
 * paths) gets the same fail-fast behaviour as the env path.
 */
export function startWorkerPool(
    options: StartWorkerPoolOptions,
): Promise<void[]> {
    if (!Number.isInteger(options.size) || options.size <= 0) {
        throw new WorkerPoolConfigValidationError(
            WorkerPoolConfigError.INVALID_POOL_SIZE,
            `worker pool size must be a positive integer, received: ${String(options.size)}`,
        );
    }
    const coroutines: Promise<void>[] = [];
    for (let workerIndex = 0; workerIndex < options.size; workerIndex++) {
        coroutines.push(
            runWorkerLoop({
                tickFn: () => tickOnce(options.repository),
                sleepMs: options.sleepMs,
                sleepFn: options.sleepFn,
                stopSignal: options.stopSignal,
            }),
        );
    }
    return Promise.all(coroutines);
}