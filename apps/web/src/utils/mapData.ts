import type { FeatureCollection, Point } from "geojson";
import type { PropertyListing } from "../types";

export interface MapCoverage {
  mapped: PropertyListing[];
  sourcePropertyCount: number;
  approximateCount: number;
  unmappedCount: number;
}

export function summarizeMapCoverage(properties: PropertyListing[]): MapCoverage {
  const mapped = properties.filter((property) => property.coordinates !== undefined);
  const sourcePropertyCount = mapped.filter(
    (property) => property.coordinates?.locationKind === "source-property",
  ).length;

  return {
    mapped,
    sourcePropertyCount,
    approximateCount: mapped.length - sourcePropertyCount,
    unmappedCount: properties.length - mapped.length,
  };
}

export function propertiesToGeoJson(properties: PropertyListing[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: properties.flatMap((property) => {
      if (!property.coordinates) return [];
      return [{
        type: "Feature" as const,
        properties: {
          id: property.key,
          decision: property.evaluation?.decision ?? "unevaluated",
          locationKind: property.coordinates.locationKind,
          positionAccuracy: property.coordinates.locationKind === "source-property" ? "property" : "approximate",
        },
        geometry: {
          type: "Point" as const,
          coordinates: [property.coordinates.longitude, property.coordinates.latitude],
        },
      }];
    }),
  };
}
