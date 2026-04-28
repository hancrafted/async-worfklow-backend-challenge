import { describe, it, expect } from "vitest";
import { EmailNotificationJob } from "./EmailNotificationJob";
import type { Task } from "../models/Task";

const makeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    taskId: "task-under-test",
    taskType: "notification",
    ...overrides,
  }) as Task;

// Co-located unit test for EmailNotificationJob — exercises the new JobContext
// signature mandated by PRD §Implementation Decision 5 / Issue #6 / Task 3b-i.

describe("EmailNotificationJob — JobContext signature (PRD §Decision 5)", () => {
  describe("happy path", () => {
    it("resolves successfully when called with { task, dependencies: [] }", async () => {
      // 3b-i: notification is a no-op side-effect job; the only contract is
      // that it resolves without throwing under the new signature.
      const job = new EmailNotificationJob();
      await expect(
        job.run({ task: makeTask(), dependencies: [] }),
      ).resolves.not.toThrow();
    });
  });

  describe("error path", () => {
    it("does not crash when given a minimal task (defensive contract)", async () => {
      // Defensive: even a near-empty task object must not break the job's
      // signature contract — only the workflow runner is responsible for
      // populating Task fields, the job itself must remain crash-free.
      const job = new EmailNotificationJob();
      const minimalTask = { taskId: "minimal" } as Task;
      await expect(
        job.run({ task: minimalTask, dependencies: [] }),
      ).resolves.not.toThrow();
    });
  });
});
