import area from "@turf/area";
import type { Feature, Geometry, Polygon } from "geojson";
import type { Job, JobContext } from "./Job";
import type { Task } from "../models/Task";

type GenericFeature = Feature<Geometry | null>;

export interface PolygonAreaResult {
  areaSqMeters: number;
}

export enum GeoJsonType {
  Polygon = "Polygon",
  Feature = "Feature",
}

export enum PolygonAreaJobValidationError {
  INVALID_JSON = "INVALID_JSON",
  NOT_AN_OBJECT = "NOT_AN_OBJECT",
  NOT_A_POLYGON = "NOT_A_POLYGON",
}

export class PolygonAreaJob implements Job {
  async run(context: JobContext): Promise<PolygonAreaResult> {
    const { task } = context;
    const validationError = this.validate(task);
    if (validationError) {
      throw new Error(`Invalid GeoJSON (Polygon expected): ${validationError}`);
    }

    const parsed: unknown = JSON.parse(task.geoJson);
    const geometry = this.extractPolygon(parsed);
    const sqMeters = area(geometry);
    return { areaSqMeters: sqMeters };
  }

  private validate(task: Task): PolygonAreaJobValidationError | null {
    let validationError: PolygonAreaJobValidationError | null = null;
    let parsed: unknown;

    try {
      parsed = JSON.parse(task.geoJson);
    } catch {
      validationError = PolygonAreaJobValidationError.INVALID_JSON;
      return validationError;
    }

    if (parsed === null || typeof parsed !== "object") {
      validationError = PolygonAreaJobValidationError.NOT_AN_OBJECT;
      return validationError;
    }

    const type = (parsed as { type?: unknown }).type;
    if (type === GeoJsonType.Polygon) {
      return validationError;
    }
    if (type === GeoJsonType.Feature) {
      const feature = parsed as GenericFeature;
      if (
        feature.geometry &&
        feature.geometry.type === (GeoJsonType.Polygon as string)
      ) {
        return validationError;
      }
    }

    validationError = PolygonAreaJobValidationError.NOT_A_POLYGON;
    return validationError;
  }

  private extractPolygon(parsed: unknown): Feature<Polygon> | Polygon {
    const type = (parsed as { type?: unknown }).type;
    if (type === GeoJsonType.Polygon) return parsed as Polygon;
    return parsed as Feature<Polygon>;
  }
}
