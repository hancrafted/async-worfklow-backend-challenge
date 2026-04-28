import { describe, it, expect } from "vitest";
import { DataAnalysisJob } from "./DataAnalysisJob";
import type { Task } from "../models/Task";

const makeTask = (geoJson: string): Task =>
  ({
    taskId: "task-under-test",
    geoJson,
    taskType: "analysis",
  }) as Task;

// Co-located unit test for DataAnalysisJob — exercises the new JobContext
// signature mandated by PRD §Implementation Decision 5 / Issue #6 / Task 3b-i.

describe("DataAnalysisJob — JobContext signature (PRD §Decision 5)", () => {
  describe("happy path", () => {
    it("returns 'No country found' for an equator-square polygon (ocean) using context.task", async () => {
      // The job reads task.geoJson via context.task; for a polygon centered on
      // (0,0)–(1,1) lat/lng (open ocean) the country lookup yields the
      // documented "No country found" sentinel — behavior unchanged from the
      // pre-3b-i implementation.
      const job = new DataAnalysisJob();
      const polygon = JSON.stringify({
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        },
      });
      const result = await job.run({
        task: makeTask(polygon),
        dependencies: [],
      });
      expect(result).toBe("No country found");
    });
  });

  describe("error path", () => {
    it("throws when geoJson is not valid JSON", async () => {
      // DataAnalysisJob calls JSON.parse(task.geoJson) directly, so malformed
      // input must surface as a thrown error — the runner depends on this to
      // mark the task failed.
      const job = new DataAnalysisJob();
      await expect(
        job.run({ task: makeTask("not-json{"), dependencies: [] }),
      ).rejects.toThrow();
    });
  });
});
