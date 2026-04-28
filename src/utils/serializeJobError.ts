export const MAX_STACK_LINES = 10;

export enum JobErrorReason {
    JobError = 'job_error',
}

/**
 * The persisted shape of a job-level failure on `Result.error`. Lets a reviewer
 * reproduce and debug a failed task by querying the DB alone — no log scraping
 * required. The `stack` field is truncated to keep `Result` rows bounded.
 */
export interface SerializedJobError {
    message: string;
    reason: JobErrorReason;
    stack: string;
}

export function serializeJobError(error: unknown): SerializedJobError {
    const message = error instanceof Error ? error.message : String(error);
    const rawStack = error instanceof Error && error.stack ? error.stack : '';
    const stack = rawStack.split('\n').slice(0, MAX_STACK_LINES).join('\n');
    return { message, reason: JobErrorReason.JobError, stack };
}
