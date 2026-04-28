import { describe, it, expect } from "vitest";
import { PolygonAreaJob } from "./PolygonAreaJob";
import type { Task } from "../models/Task";

const makeTask = (geoJson: string): Task =>
  ({
    taskId: "task-under-test",
    geoJson,
    taskType: "polygonArea",
  }) as Task;

const VALID_POLYGON_JSON = JSON.stringify({
  type: "Polygon",
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
});

// Co-located unit test for PolygonAreaJob — exercises the new JobContext
// signature mandated by PRD §Implementation Decision 5 / Issue #6 / Task 3b-i.

describe("PolygonAreaJob — JobContext signature (PRD §Decision 5)", () => {
  describe("happy path", () => {
    it("computes areaSqMeters from context.task, ignoring dependencies", async () => {
      // The job must read inputs from context.task and ignore the dependencies
      // envelope — 3b-i is a pure signature migration with zero behavior change.
      const job = new PolygonAreaJob();
      const result = await job.run({
        task: makeTask(VALID_POLYGON_JSON),
        dependencies: [],
      });
      expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
      expect(result.areaSqMeters).toBeLessThan(1.3e10);
    });

    it("produces the same output when dependencies is non-empty (envelope is ignored)", async () => {
      // Defensive assertion: 3b-ii will start populating dependencies, but
      // 3b-i jobs must be insensitive to its contents.
      const job = new PolygonAreaJob();
      const withEmpty = await job.run({
        task: makeTask(VALID_POLYGON_JSON),
        dependencies: [],
      });
      const withSomething = await job.run({
        task: makeTask(VALID_POLYGON_JSON),
        dependencies: [
          { stepNumber: 1, taskType: "analysis", taskId: "x", output: "noise" },
        ],
      });
      expect(withSomething.areaSqMeters).toBe(withEmpty.areaSqMeters);
    });
  });

  describe("error path", () => {
    it("throws a descriptive Error for invalid (non-JSON) GeoJSON", async () => {
      const job = new PolygonAreaJob();
      await expect(
        job.run({ task: makeTask("not-json{"), dependencies: [] }),
      ).rejects.toThrow(/Invalid GeoJSON|parse/i);
    });
  });
});
