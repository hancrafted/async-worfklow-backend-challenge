export const MAX_STACK_LINES = 10;

/**
 * Truncate an Error `stack` string to the first `maxLines` newline-delimited
 * lines. Shared by `serializeJobError` (persisted `Result.error.stack`) and
 * the JSON-line logger (PRD §11) so both bound stack output identically.
 */
export function truncateStack(stack: string, maxLines: number = MAX_STACK_LINES): string {
    return stack.split('\n').slice(0, maxLines).join('\n');
}
