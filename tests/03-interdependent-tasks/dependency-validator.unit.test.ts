import { describe, it, expect } from "vitest";
import { validateWorkflowSteps } from "../../src/workflows/dependencyValidator";
import { ApiErrorCode } from "../../src/utils/errorResponse";

// Sidecar TDD unit tests for `validateWorkflowSteps`. Each error-code branch
// of PRD decision 3 is exercised in isolation against the pure validator
// (no DB, no Express).
describe("validateWorkflowSteps — in-memory dependency validator", () => {
  describe("happy path: returns normalised steps for a valid graph", () => {
    it("normalises a 3-step DAG with mixed dependsOn presence", () => {
      // Step 1: no deps; Step 2: depends on 1; Step 3: depends on 1 and 2.
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1 },
        { taskType: "analysis", stepNumber: 2, dependsOn: [1] },
        { taskType: "notification", stepNumber: 3, dependsOn: [1, 2] },
      ]);
      expect(result.finding).toBeNull();
      expect(result.steps).toEqual([
        { taskType: "polygonArea", stepNumber: 1, dependsOn: [] },
        { taskType: "analysis", stepNumber: 2, dependsOn: [1] },
        { taskType: "notification", stepNumber: 3, dependsOn: [1, 2] },
      ]);
    });
  });

  describe("error path: each PRD-decision-3 rule fires its own code + message", () => {
    it("rejects a duplicate stepNumber with INVALID_WORKFLOW_FILE and names the offender", () => {
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1 },
        { taskType: "analysis", stepNumber: 1 },
      ]);
      expect(result.finding).toEqual({
        code: ApiErrorCode.INVALID_WORKFLOW_FILE,
        message: "Duplicate stepNumber: 1",
      });
    });

    it("rejects a missing taskType with INVALID_WORKFLOW_FILE", () => {
      const result = validateWorkflowSteps([{ stepNumber: 1 }]);
      expect(result.finding?.code).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect(result.finding?.message).toMatch(/missing taskType/);
    });

    it("rejects an unknown taskType with INVALID_WORKFLOW_FILE", () => {
      const result = validateWorkflowSteps([
        { taskType: "doesNotExist", stepNumber: 1 },
      ]);
      expect(result.finding?.code).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect(result.finding?.message).toMatch(/unknown taskType/);
    });

    it("rejects a missing-step reference with INVALID_DEPENDENCY and the offending pair", () => {
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1 },
        { taskType: "analysis", stepNumber: 2, dependsOn: [9] },
      ]);
      expect(result.finding).toEqual({
        code: ApiErrorCode.INVALID_DEPENDENCY,
        message: "Step 2 references non-existent step 9",
      });
    });

    it("rejects a multi-node cycle with DEPENDENCY_CYCLE", () => {
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1 },
        { taskType: "analysis", stepNumber: 2, dependsOn: [3] },
        { taskType: "notification", stepNumber: 3, dependsOn: [2] },
      ]);
      expect(result.finding?.code).toBe(ApiErrorCode.DEPENDENCY_CYCLE);
      expect(result.finding?.message).toMatch(/Cycle detected:/);
    });

    it("rejects a self-dependency with DEPENDENCY_CYCLE", () => {
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1, dependsOn: [1] },
      ]);
      expect(result.finding?.code).toBe(ApiErrorCode.DEPENDENCY_CYCLE);
      expect(result.finding?.message).toBe("Cycle detected: 1 → 1");
    });

    it("rejects a non-array dependsOn with INVALID_WORKFLOW_FILE (no scalar shorthand)", () => {
      const result = validateWorkflowSteps([
        { taskType: "polygonArea", stepNumber: 1 },
        { taskType: "analysis", stepNumber: 2, dependsOn: 1 },
      ]);
      expect(result.finding?.code).toBe(ApiErrorCode.INVALID_WORKFLOW_FILE);
      expect(result.finding?.message).toMatch(/must be an array/);
    });
  });
});
