import { describe, it, expect } from "vitest";
import { detectDependencyCycle } from "../../src/workflows/dependencyValidator";

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
