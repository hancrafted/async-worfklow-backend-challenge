/**
 * Tiny in-house JSON-line logger (PRD §11 / US22). Emits one JSON object per
 * call to stdout (`info`/`warn`) or stderr (`error`) with the documented
 * shape: `{ level, ts, workflowId?, taskId?, stepNumber?, taskType?, msg,
 * error? }`. No new dependencies; `jq` is the dev-mode pretty-printer.
 *
 * `error` accepts an optional `error` field (any thrown value); Error
 * instances are serialized to `{ message, stack }` with the stack truncated
 * to the first 10 lines, matching `serializeJobError` (PRD §11).
 */

export const MAX_LOG_STACK_LINES = 10;

export enum LogLevel {
    Info = 'info',
    Warn = 'warn',
    Error = 'error',
}

export interface LogContext {
    workflowId?: string;
    taskId?: string;
    stepNumber?: number;
    taskType?: string;
    error?: unknown;
}

interface SerializedLogError {
    message: string;
    stack?: string;
}

interface LogLine {
    level: LogLevel;
    ts: string;
    msg: string;
    workflowId?: string;
    taskId?: string;
    stepNumber?: number;
    taskType?: string;
    error?: SerializedLogError;
}

function serializeError(error: unknown): SerializedLogError {
    if (error instanceof Error) {
        const serialized: SerializedLogError = { message: error.message };
        if (error.stack) {
            serialized.stack = error.stack
                .split('\n')
                .slice(0, MAX_LOG_STACK_LINES)
                .join('\n');
        }
        return serialized;
    }
    return { message: String(error) };
}

function buildLine(level: LogLevel, msg: string, context?: LogContext): LogLine {
    const line: LogLine = { level, ts: new Date().toISOString(), msg };
    if (!context) return line;
    if (context.workflowId !== undefined) line.workflowId = context.workflowId;
    if (context.taskId !== undefined) line.taskId = context.taskId;
    if (context.stepNumber !== undefined) line.stepNumber = context.stepNumber;
    if (context.taskType !== undefined) line.taskType = context.taskType;
    if (context.error !== undefined) line.error = serializeError(context.error);
    return line;
}

function emit(level: LogLevel, msg: string, context?: LogContext): void {
    const payload = JSON.stringify(buildLine(level, msg, context));
    if (level === LogLevel.Error) {
        console.error(payload);
        return;
    }
    // info + warn share stdout; the level field discriminates downstream.
    // eslint-disable-next-line no-console -- JSON-line wrapper owns the only stdout write site (PRD §11).
    console.log(payload);
}

export function info(msg: string, context?: LogContext): void {
    emit(LogLevel.Info, msg, context);
}

export function warn(msg: string, context?: LogContext): void {
    emit(LogLevel.Warn, msg, context);
}

export function error(msg: string, context?: LogContext): void {
    emit(LogLevel.Error, msg, context);
}
