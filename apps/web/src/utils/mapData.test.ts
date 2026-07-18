import { describe, expect, it } from "vitest";
import type { PropertyListing } from "../types";
import { propertiesToGeoJson, summarizeMapCoverage } from "./mapData";

const observedAt = "2026-07-18T10:00:00.000Z";

function listing(externalId: string, coordinates?: PropertyListing["coordinates"]): PropertyListing {
  return {
    source: "leboncoin",
    externalId,
    key: `leboncoin:${externalId}`,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
    imageUrls: [],
    features: [],
    runs: [],
    evaluations: [],
    coordinates,
  };
}

describe("propertiesToGeoJson", () => {
  it("emits only listings with coordinates, retains their kind and never fabricates a score", () => {
    const result = propertiesToGeoJson([
      listing("mapped", {
        latitude: 48.4,
        longitude: -4.2,
        verifiedAt: observedAt,
        provenance: "leboncoin listing payload",
        locationKind: "source-locality",
      }),
      listing("unmapped"),
    ]);

    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.geometry.coordinates).toEqual([-4.2, 48.4]);
    expect(result.features[0]?.properties).toEqual({
      id: "leboncoin:mapped",
      decision: "unevaluated",
      locationKind: "source-locality",
      positionAccuracy: "approximate",
    });
    expect(result.features[0]?.properties).not.toHaveProperty("score");
  });

  it("marks source-property coordinates separately from approximate positions", () => {
    const result = propertiesToGeoJson([listing("property", {
      latitude: 48.1,
      longitude: -3.8,
      verifiedAt: observedAt,
      provenance: "source property coordinates",
      locationKind: "source-property",
    })]);

    expect(result.features[0]?.properties).toMatchObject({
      locationKind: "source-property",
      positionAccuracy: "property",
    });
  });
});

describe("summarizeMapCoverage", () => {
  it("counts exact-source, approximate and missing positions without changing the listing set", () => {
    const coordinates = (locationKind: NonNullable<PropertyListing["coordinates"]>["locationKind"]) => ({
      latitude: 48.4,
      longitude: -4.2,
      verifiedAt: observedAt,
      provenance: `test:${locationKind}`,
      locationKind,
    });
    const properties = [
      listing("property", coordinates("source-property")),
      listing("source-locality", coordinates("source-locality")),
      listing("locality", coordinates("locality-centroid")),
      listing("postal", coordinates("postal-code-centroid")),
      listing("missing"),
    ];

    const coverage = summarizeMapCoverage(properties);

    expect(coverage.mapped.map((property) => property.externalId)).toEqual([
      "property",
      "source-locality",
      "locality",
      "postal",
    ]);
    expect(coverage).toMatchObject({
      sourcePropertyCount: 1,
      approximateCount: 3,
      unmappedCount: 1,
    });
  });
});
