import area from "@turf/area";
import type { Feature, Geometry, Polygon } from "geojson";
import type { Job } from "./Job";
import type { Task } from "../models/Task";

type GenericFeature = Feature<Geometry | null>;

export interface PolygonAreaResult {
  areaSqMeters: number;
}

export class PolygonAreaJob implements Job {
  async run(task: Task): Promise<PolygonAreaResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(task.geoJson);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`Invalid GeoJSON: failed to parse: ${detail}`);
      (wrapped as Error & { cause: unknown }).cause = err;
      throw wrapped;
    }
    const geometry = this.assertPolygon(parsed);
    const sqMeters = area(geometry);
    return { areaSqMeters: sqMeters };
  }

  private assertPolygon(parsed: unknown): Feature<Polygon> | Polygon {
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(
        `Invalid GeoJSON: expected a Polygon or Feature<Polygon>, got ${typeof parsed}`,
      );
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === "Polygon") return parsed as Polygon;
    if (type === "Feature") {
      const feature = parsed as GenericFeature;
      if (feature.geometry && feature.geometry.type === "Polygon") {
        return feature as Feature<Polygon>;
      }
    }
    throw new Error(
      `Invalid GeoJSON: expected a Polygon or Feature<Polygon>, got type=${String(type)}`,
    );
  }
}
