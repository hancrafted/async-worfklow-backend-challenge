import { describe, it, expect } from "vitest";
import { Task } from "../../src/models/Task";
import { TaskStatus } from "../../src/models/Task";
import { translateDependsOnToStepNumbers } from "../../src/routes/workflowRoutes";

// Builds a Task fixture with the minimum fields the translator reads
// (taskId + stepNumber). Other columns are populated with placeholders so the
// shape compiles against the real entity.
const makeTask = (taskId: string, stepNumber: number, dependsOn: string[] = []): Task => {
  const task = new Task();
  task.taskId = taskId;
  task.stepNumber = stepNumber;
  task.dependsOn = dependsOn;
  task.clientId = "test-client";
  task.geoJson = "{}";
  task.taskType = "polygonArea";
  task.status = TaskStatus.Queued;
  task.workflowId = "workflow-id";
  return task;
};

describe("translateDependsOnToStepNumbers — pure helper (Task 5, US16)", () => {
  describe("happy path: maps stored dependsOn taskIds to stepNumbers", () => {
    it("returns [] when the task has no dependencies", () => {
      const task = makeTask("a", 1, []);
      expect(translateDependsOnToStepNumbers(task, [task])).toEqual([]);
    });

    it("translates a single-dep array to a single stepNumber", () => {
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, ["a"]);
      expect(translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo])).toEqual([1]);
    });

    it("translates a multi-dep array preserving the stored taskId order", () => {
      // Insertion order from YAML is the source of truth — the translator
      // must NOT sort. The route handler decides whether downstream callers
      // see the order.
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, []);
      const stepThree = makeTask("c", 3, []);
      const stepFour = makeTask("d", 4, ["c", "a", "b"]);
      const allTasks = [stepOne, stepTwo, stepThree, stepFour];
      expect(translateDependsOnToStepNumbers(stepFour, allTasks)).toEqual([3, 1, 2]);
    });

    it("does not include any taskId in its output (US16 — UUIDs never leak)", () => {
      const stepOne = makeTask("uuid-one", 1, []);
      const stepTwo = makeTask("uuid-two", 2, ["uuid-one"]);
      const result = translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo]);
      for (const value of result) expect(typeof value).toBe("number");
    });
  });

  describe("error path: throws when an upstream taskId is missing from the workflow", () => {
    it("throws Error mentioning the orphan taskId so the operator can debug", () => {
      // Defence-in-depth: the persistence path guarantees every dependsOn
      // taskId exists in the same workflow's tasks. A miss is an invariant
      // violation (DB corruption, manual SQL surgery), not a user error.
      const stepOne = makeTask("a", 1, []);
      const stepTwo = makeTask("b", 2, ["nonexistent-uuid"]);
      expect(() =>
        translateDependsOnToStepNumbers(stepTwo, [stepOne, stepTwo]),
      ).toThrowError(/nonexistent-uuid/);
    });
  });
});
