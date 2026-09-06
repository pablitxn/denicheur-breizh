import type { FeatureCollection, Point } from "geojson";
import {
  pointIsInAdministrativeArea,
  type AdministrativeArea,
} from "../features/map/mapGeography";
import type { PropertyMapListing } from "../types";

export interface MapCoverage {
  mapped: PropertyMapListing[];
  sourcePropertyCount: number;
  approximateCount: number;
  unmappedCount: number;
}

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function summarizeMapCoverage(properties: PropertyMapListing[]): MapCoverage {
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

export function propertiesWithinBounds(
  properties: PropertyMapListing[],
  bounds: MapBounds,
): PropertyMapListing[] {
  return properties.filter((property) => {
    const coordinates = property.coordinates;
    if (!coordinates) return false;

    const withinLatitude = coordinates.latitude >= bounds.south
      && coordinates.latitude <= bounds.north;
    const withinLongitude = bounds.west <= bounds.east
      ? coordinates.longitude >= bounds.west && coordinates.longitude <= bounds.east
      : coordinates.longitude >= bounds.west || coordinates.longitude <= bounds.east;

    return withinLatitude && withinLongitude;
  });
}

export function propertiesWithinAdministrativeArea(
  properties: PropertyMapListing[],
  area: AdministrativeArea,
): PropertyMapListing[] {
  return properties.filter((property) => {
    const coordinates = property.coordinates;
    return coordinates !== undefined && pointIsInAdministrativeArea(
      [coordinates.longitude, coordinates.latitude],
      area,
    );
  });
}

export function propertiesToGeoJson(properties: PropertyMapListing[]): FeatureCollection<Point> {
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
