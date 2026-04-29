import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import {
  ApiErrorCode,
  errorResponse,
} from "./errorResponse";

// Sidecar TDD unit tests for the errorResponse helper. Asserts the helper
// emits the unified `{ error, message }` shape and uses the ApiErrorCode enum
// rather than magic strings.
describe("errorResponse helper — unified API error response shape", () => {
  describe("happy path: emits { error, message } with the supplied status", () => {
    it("calls res.status(400).json({ error: 'INVALID_PAYLOAD', message }) for INVALID_PAYLOAD", () => {
      const json = vi.fn();
      const status = vi.fn(() => ({ json }));
      const res = { status } as unknown as Response;

      errorResponse(res, 400, ApiErrorCode.INVALID_PAYLOAD, "missing clientId");

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({
        error: "INVALID_PAYLOAD",
        message: "missing clientId",
      });
    });

    it("propagates DEPENDENCY_CYCLE / INVALID_DEPENDENCY / INVALID_WORKFLOW_FILE codes verbatim", () => {
      // Every ApiErrorCode the helper must support in this slice — exercised
      // in a single it() to keep the unit table-driven.
      const codes: Array<[ApiErrorCode, string]> = [
        [ApiErrorCode.INVALID_DEPENDENCY, "Step 2 references non-existent step 9"],
        [ApiErrorCode.DEPENDENCY_CYCLE, "Cycle detected: 2 → 3 → 2"],
        [ApiErrorCode.INVALID_WORKFLOW_FILE, "Duplicate stepNumber: 1"],
      ];
      for (const [code, message] of codes) {
        const json = vi.fn();
        const status = vi.fn(() => ({ json }));
        const res = { status } as unknown as Response;
        errorResponse(res, 400, code, message);
        expect(status).toHaveBeenCalledWith(400);
        expect(json).toHaveBeenCalledWith({ error: code, message });
      }
    });
  });

  describe("ApiErrorCode enum — no magic strings", () => {
    it("exports the four codes this slice introduces", () => {
      // Locks the enum surface so callers can rely on these constants existing.
      expect(ApiErrorCode.INVALID_PAYLOAD).toBe("INVALID_PAYLOAD");
      expect(ApiErrorCode.INVALID_WORKFLOW_FILE).toBe("INVALID_WORKFLOW_FILE");
      expect(ApiErrorCode.INVALID_DEPENDENCY).toBe("INVALID_DEPENDENCY");
      expect(ApiErrorCode.DEPENDENCY_CYCLE).toBe("DEPENDENCY_CYCLE");
    });
  });
});
