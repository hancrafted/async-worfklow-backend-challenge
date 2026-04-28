import type { Response } from "express";

/**
 * Unified API error code catalogue. Per the CLAUDE.md style guide, callers
 * must use this enum rather than magic strings.
 */
export enum ApiErrorCode {
  INVALID_PAYLOAD = "INVALID_PAYLOAD",
  INVALID_WORKFLOW_FILE = "INVALID_WORKFLOW_FILE",
  INVALID_DEPENDENCY = "INVALID_DEPENDENCY",
  DEPENDENCY_CYCLE = "DEPENDENCY_CYCLE",
  WORKFLOW_NOT_FOUND = "WORKFLOW_NOT_FOUND",
  WORKFLOW_NOT_TERMINAL = "WORKFLOW_NOT_TERMINAL",
}

/**
 * Emits the unified `{ error, message }` API error shape.
 */
export function errorResponse(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
): Response {
  return res.status(status).json({ error: code, message });
}
