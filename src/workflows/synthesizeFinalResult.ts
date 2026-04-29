import type { Task } from '../models/Task';
import type { Result } from '../models/Result';
import type { Workflow } from '../models/Workflow';
import { TaskStatus } from '../models/Task';
import { JobErrorReason } from '../utils/serializeJobError';

/**
 * The framework-owned shape persisted on `Workflow.finalResult` (PRD
 * §Decision 8). Public-facing — `taskId` is deliberately omitted (US16);
 * `failedAtStep` is omitted entirely on success (US15).
 */
export interface FinalResultTaskEntry {
    stepNumber: number;
    taskType: string;
    status: TaskStatus;
    output?: unknown;
    error?: { message: string; reason: JobErrorReason };
}

export interface FinalResultPayload {
    workflowId: string;
    failedAtStep?: number;
    tasks: FinalResultTaskEntry[];
}

/**
 * Pure synthesizer for `Workflow.finalResult`. No DB access — Wave 3's lazy
 * patch on `/results` will reuse this same helper. Inputs:
 *   - `workflow`: provides `workflowId` (the only field consumed).
 *   - `tasks`: the workflow's tasks (any order — sorted ascending by
 *     `stepNumber` here so the contract is deterministic).
 *   - `results`: every `Result` row associated with `tasks` (lookup by
 *     `taskId`). Skipped tasks have no Result row; the helper tolerates that.
 *
 * Per-entry contract (PRD §Decision 8):
 *   - `completed` → carries `output` (parsed from `Result.data`)
 *   - `failed`    → carries `error: { message, reason }` — `stack` is
 *     stripped here so internals never reach the column or any API caller.
 *   - `skipped`   → neither `output` nor `error`.
 */
export function synthesizeFinalResult(
    workflow: Pick<Workflow, 'workflowId'>,
    tasks: Task[],
    results: Result[],
): FinalResultPayload {
    const resultByTaskId = new Map<string, Result>();
    for (const result of results) resultByTaskId.set(result.taskId, result);

    const orderedTasks = [...tasks].sort((a, b) => a.stepNumber - b.stepNumber);

    const entries: FinalResultTaskEntry[] = orderedTasks.map((task) => {
        const entry: FinalResultTaskEntry = {
            stepNumber: task.stepNumber,
            taskType: task.taskType,
            status: task.status,
        };
        if (task.status === TaskStatus.Completed) {
            const result = resultByTaskId.get(task.taskId);
            entry.output = parseOutputOrNull(result);
        } else if (task.status === TaskStatus.Failed) {
            const result = resultByTaskId.get(task.taskId);
            entry.error = extractPublicError(result);
        }
        return entry;
    });

    const failedSteps = orderedTasks
        .filter((t) => t.status === TaskStatus.Failed)
        .map((t) => t.stepNumber);
    const payload: FinalResultPayload = {
        workflowId: workflow.workflowId,
        tasks: entries,
    };
    if (failedSteps.length > 0) payload.failedAtStep = Math.min(...failedSteps);
    return payload;
}

/**
 * Reads the persisted `Result.error` (a JSON-stringified `SerializedJobError`)
 * and projects it onto the public `{ message, reason }` shape — `stack` is
 * dropped (US23). Falls back to a minimal `job_error` shape if the row is
 * missing or malformed so the synthesizer never throws.
 */
/**
 * Reads `Result.data` for a completed task and JSON-parses it. Returns `null`
 * when the row is missing, the column is null, or the payload is malformed —
 * the synthesizer never throws so a single corrupt row cannot block the
 * lifecycle eager write.
 */
function parseOutputOrNull(result: Result | undefined): unknown {
    if (!result || result.data === null || result.data === undefined) return null;
    try {
        return JSON.parse(result.data) as unknown;
    } catch {
        return null;
    }
}

const UNKNOWN_JOB_ERROR: { message: string; reason: JobErrorReason } = {
    message: 'unknown',
    reason: JobErrorReason.JobError,
};

function extractPublicError(result: Result | undefined): { message: string; reason: JobErrorReason } {
    if (!result || !result.error) return UNKNOWN_JOB_ERROR;
    try {
        const parsed = JSON.parse(result.error) as { message?: unknown };
        const message = typeof parsed.message === 'string' ? parsed.message : UNKNOWN_JOB_ERROR.message;
        return { message, reason: JobErrorReason.JobError };
    } catch {
        return UNKNOWN_JOB_ERROR;
    }
}
