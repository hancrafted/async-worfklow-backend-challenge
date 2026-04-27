import { describe, it, expect } from "vitest";
import { PolygonAreaJob } from "../../src/jobs/PolygonAreaJob";
import { getJobForTaskType } from "../../src/jobs/JobFactory";
import type { Task } from "../../src/models/Task";

const makeTask = (geoJson: string): Task =>
  ({
    taskId: "task-under-test",
    geoJson,
    taskType: "polygonArea",
  }) as Task;

describe("PolygonAreaJob", () => {
  it("is registered in the JobFactory under taskType 'polygonArea'", () => {
    const job = getJobForTaskType("polygonArea");
    expect(job).toBeInstanceOf(PolygonAreaJob);
  });


  it("computes area of a 1°×1° square polygon at the equator", async () => {
    const polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    };
    const job = new PolygonAreaJob();

    const result = await job.run(makeTask(JSON.stringify(polygon)));

    // @turf/area returns ~12,363,718,145 m² for this square. Assert a tolerant
    // range rather than an exact float so the test isn't brittle to library
    // recomputation.
    expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
    expect(result.areaSqMeters).toBeLessThan(1.3e10);
  });

  it("throws a descriptive Error when geoJson is not valid JSON", async () => {
    const job = new PolygonAreaJob();
    await expect(job.run(makeTask("not-valid-json{"))).rejects.toThrow(
      /Invalid GeoJSON|parse/i,
    );
  });

  it("throws when the GeoJSON is not a Polygon (e.g. Point)", async () => {
    const point = { type: "Point", coordinates: [0, 0] };
    const job = new PolygonAreaJob();
    await expect(job.run(makeTask(JSON.stringify(point)))).rejects.toThrow(
      /Polygon/,
    );
  });

  it("returns 0 m² for a degenerate (collinear) polygon ring", async () => {
    // Locked to @turf/area's actual behavior: it returns 0 for a degenerate
    // ring rather than throwing. See PRD §Task 1 Definition of Done.
    const degenerate = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]],
    };
    const job = new PolygonAreaJob();
    const result = await job.run(makeTask(JSON.stringify(degenerate)));
    expect(result.areaSqMeters).toBe(0);
  });

  it("accepts a Feature<Polygon> wrapper", async () => {
    const feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
    };
    const job = new PolygonAreaJob();
    const result = await job.run(makeTask(JSON.stringify(feature)));
    expect(result.areaSqMeters).toBeGreaterThan(1.2e10);
  });
});
