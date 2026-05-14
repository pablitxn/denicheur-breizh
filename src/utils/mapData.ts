import type { FeatureCollection, Point, Polygon } from "geojson";
import type { PropertyListing } from "../types";

export function propertiesToGeoJson(properties: PropertyListing[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: properties.map((property) => ({
      type: "Feature",
      properties: { id: property.id, score: property.scores.overall },
      geometry: { type: "Point", coordinates: [property.coordinates.lng, property.coordinates.lat] },
    })),
  };
}

export function regionsGeoJson(): FeatureCollection<Polygon> {
  const features: FeatureCollection<Polygon>["features"] = [];

  for (let lng = -3.5; lng < -1.3; lng += 0.18) {
    for (let lat = 47.8; lat < 48.9; lat += 0.12) {
      const coastDist = Math.max(0, 48.7 - lat);
      const organic = Math.sin(lng * 6) + Math.cos(lat * 7) + Math.sin((lng + lat) * 11) * 0.5;
      const value = Math.max(0, Math.min(10, 9 - coastDist * 12 + organic));

      if ((Math.round((lng + 4) * 100) + Math.round(lat * 100)) % 7 === 0) {
        continue;
      }

      features.push({
        type: "Feature",
        properties: { value },
        geometry: {
          type: "Polygon",
          coordinates: [[[lng, lat], [lng + 0.18, lat], [lng + 0.18, lat + 0.12], [lng, lat + 0.12], [lng, lat]]],
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
