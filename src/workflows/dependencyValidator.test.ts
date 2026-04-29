import { describe, it, expect } from "vitest";
import {
  detectDependencyCycle,
  validateWorkflowSteps,
} from "./dependencyValidator";
import { ApiErrorCode } from "../utils/errorResponse";

// Merged co-located unit tests for the pure dependency-graph helpers exposed
// by `dependencyValidator`. Two top-level groupings preserve the original
// /tests/ unit suites' coverage:
//   1. detectDependencyCycle — pure DAG / cycle / self-dep checker
//   2. validateWorkflowSteps — in-memory shape + reference + cycle gate
// No DB, no YAML, no Express.

// Cycle detector exercised in pure isolation — no DB, no YAML, no Express.
// Inputs are step-number → number[] adjacency; output is `null` for a DAG, or
// the smallest cycle path expressed as `[a, b, ..., a]` for the user-facing
// `Cycle detected: 2 → 3 → 2` message.
describe("detectDependencyCycle — pure DAG / cycle / self-dep checker", () => {
  describe("happy path: returns null for a valid DAG", () => {
    it("returns null for a strictly linear chain 1 → 2 → 3", () => {
      // step 1 has no deps; step 2 depends on 1; step 3 depends on 2.
      const cycle = detectDependencyCycle([
        { stepNumber: 1, dependsOn: [] },
        { stepNumber: 2, dependsOn: [1] },
        { stepNumber: 3, dependsOn: [2] },
      ]);
      expect(cycle).toBeNull();
    });

    it("returns null for a diamond 1 → {2,3} → 4", () => {
      // Steps 2 and 3 both depend on 1; step 4 joins on both — still acyclic.
      const cycle = detectDependencyCycle([
        { stepNumber: 1, dependsOn: [] },
        { stepNumber: 2, dependsOn: [1] },
        { stepNumber: 3, dependsOn: [1] },
        { stepNumber: 4, dependsOn: [2, 3] },
      ]);
      expect(cycle).toBeNull();
    });
  });

  describe("error path: returns the cycle path for any cycle or self-dep", () => {
    it("flags a self-dependency 2 → 2 as a cycle [2,2]", () => {
      const cycle = detectDependencyCycle([
        { stepNumber: 1, dependsOn: [] },
        { stepNumber: 2, dependsOn: [2] },
      ]);
      expect(cycle).toEqual([2, 2]);
    });

    it("flags a 2-node cycle 2 → 3 → 2", () => {
      const cycle = detectDependencyCycle([
        { stepNumber: 1, dependsOn: [] },
        { stepNumber: 2, dependsOn: [3] },
        { stepNumber: 3, dependsOn: [2] },
      ]);
      // Either rotation of the cycle is acceptable, but the path must close
      // (first element repeats at the end) and contain only the cycle nodes.
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
      expect(new Set(cycle)).toEqual(new Set([2, 3]));
    });

    it("flags a longer cycle 1 → 2 → 3 → 1", () => {
      const cycle = detectDependencyCycle([
        { stepNumber: 1, dependsOn: [3] },
        { stepNumber: 2, dependsOn: [1] },
        { stepNumber: 3, dependsOn: [2] },
      ]);
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
      expect(new Set(cycle)).toEqual(new Set([1, 2, 3]));
    });
  });
});

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
