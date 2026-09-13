import { describe, expect, it } from "vitest";

import type { ListingIngestion, VerifiedCoordinates } from "../src/contracts.js";
import { mergeOrderedListings, normalizeListing } from "../src/listingNormalization.js";

describe("listing normalization", () => {
  it("normalizes a detached projection without inventing unavailable listing attributes", () => {
    const observation = createListing({
      imageUrl: "https://example.com/cover.jpg",
      imageUrls: ["https://example.com/garden.jpg", "https://example.com/cover.jpg"],
      features: ["Jardin", "Garage", "Jardin"],
    });
    const original = structuredClone(observation);

    const projection = normalizeListing(observation);

    expect(projection.imageUrls).toEqual([
      "https://example.com/cover.jpg",
      "https://example.com/garden.jpg",
    ]);
    expect(projection.features).toEqual(["Jardin", "Garage"]);
    for (const field of ["priceEuros", "surfaceM2", "description", "coordinates"]) {
      expect(projection).not.toHaveProperty(field);
    }
    projection.imageUrls?.push("https://example.com/new.jpg");
    projection.features?.push("Terrasse");
    expect(observation).toEqual(original);
  });

  it("preserves the existing ordered merge policy while leaving both source observations intact", () => {
    const older = createListing({
      title: "Ancien titre",
      priceEuros: 300_000,
      status: "detailed",
      description: "Une longue description ancienne avec un jardin et un garage.",
      rawTextSample: "Ancien texte intégral, plus long que le nouveau texte capturé.",
      imageUrl: "https://example.com/old.jpg",
      features: ["Jardin"],
    });
    const newer = createListing({
      title: "Nouveau titre",
      priceEuros: 280_000,
      description: "Description modifiée.",
      rawTextSample: "Nouveau texte.",
      imageUrl: "https://example.com/new.jpg",
      features: ["Garage", "Jardin"],
      scrapedAt: "2026-07-18T11:00:00.000Z",
    });
    const originals = structuredClone([older, newer]);

    const projection = mergeOrderedListings(older, newer);

    expect(projection).toMatchObject({
      title: newer.title,
      priceEuros: newer.priceEuros,
      status: "detailed",
      scrapedAt: newer.scrapedAt,
      description: older.description,
      rawTextSample: older.rawTextSample,
      imageUrl: newer.imageUrl,
      imageUrls: [newer.imageUrl, older.imageUrl],
      features: ["Jardin", "Garage"],
    });
    expect([older, newer]).toEqual(originals);
    expect(newer.rawTextSample).toBe("Nouveau texte.");
  });

  it("keeps precise coordinates and the original verification time of repeated identical observations", () => {
    const coordinates: VerifiedCoordinates = {
      latitude: 47.855831,
      longitude: -3.852705,
      locationKind: "source-property",
      provenance: "leboncoin:property-location",
      verifiedAt: "2026-07-18T08:00:00.000Z",
    };
    const older = createListing({ coordinates });
    const repeated = createListing({
      coordinates: { ...coordinates, verifiedAt: "2026-07-18T11:00:00.000Z" },
      scrapedAt: "2026-07-18T11:00:00.000Z",
    });
    const approximate = createListing({
      coordinates: {
        latitude: 47.85,
        longitude: -3.85,
        locationKind: "source-locality",
        provenance: "leboncoin:locality",
        verifiedAt: "2026-07-18T12:00:00.000Z",
      },
      scrapedAt: "2026-07-18T12:00:00.000Z",
    });

    expect(mergeOrderedListings(older, repeated).coordinates).toEqual(coordinates);
    const projection = mergeOrderedListings(older, approximate);
    expect(projection.coordinates).toEqual(coordinates);
    expect(mergeOrderedListings(approximate, older).coordinates).toEqual(coordinates);
    if (projection.coordinates) projection.coordinates.latitude = 48;
    expect(older.coordinates?.latitude).toBe(47.855831);
  });
});

function createListing(overrides: Partial<ListingIngestion> = {}): ListingIngestion {
  return {
    source: "leboncoin",
    externalId: "2876543210",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
    status: "listing",
    scrapedAt: "2026-07-18T09:00:00.000Z",
    ...overrides,
  };
}
