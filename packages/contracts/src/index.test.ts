import { describe, expect, it } from "vitest";

import {
  createListingKey,
  filterListingInputSchema,
  ingestionRequestSchema,
  MAX_CRITERIA_PER_RECIPE,
  MAX_EVALUATION_IMAGE_URLS,
  MAX_LISTING_IMAGE_URLS,
  listingCoordinatesSchema,
  listingIngestionSchema,
  parseListingKey,
  recipeDraftSchema,
} from "./index.js";

describe("shared contracts", () => {
  it("round-trips the stable source and external id key", () => {
    const identity = { source: "leboncoin" as const, externalId: "2876543210" };

    expect(parseListingKey(createListingKey(identity))).toEqual(identity);
  });

  it("accepts sparse listings without inventing absent fields", () => {
    const parsed = ingestionRequestSchema.parse({
      run: { id: "run-1", source: "leboncoin", status: "collecting-search" },
      listings: [{
        source: "leboncoin",
        externalId: "2876543210",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
        status: "listing",
        scrapedAt: "2026-07-18T09:00:00.000Z",
      }],
    });

    expect(parsed.listings[0]).not.toHaveProperty("title");
    expect(parsed.listings[0]).not.toHaveProperty("priceEuros");
  });

  it("round-trips source locality coordinates with their precision metadata", () => {
    const coordinates = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T09:00:00.000Z",
      provenance: "leboncoin:api:location",
      locationKind: "source-locality" as const,
    };

    const parsed = listingCoordinatesSchema.parse(JSON.parse(JSON.stringify(coordinates)));

    expect(parsed).toEqual(coordinates);
  });

  it("rejects coordinates with missing or unsupported precision metadata and invalid bounds", () => {
    const valid = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T09:00:00.000Z",
      provenance: "leboncoin:api:location",
      locationKind: "source-locality",
    };

    expect(listingCoordinatesSchema.safeParse({ ...valid, locationKind: undefined }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, locationKind: "city-center" }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, longitude: -181 }).success).toBe(false);
  });

  it("rejects duplicate listing identities in one ingestion batch", () => {
    const listing = {
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      status: "listing",
      scrapedAt: "2026-07-18T09:00:00.000Z",
    };

    expect(ingestionRequestSchema.safeParse({
      run: { id: "run-1", source: "leboncoin", status: "collecting-search" },
      listings: [listing, listing],
    }).success).toBe(false);
  });

  it(`limits recipes to ${MAX_CRITERIA_PER_RECIPE} criteria`, () => {
    const criteria = Array.from({ length: MAX_CRITERIA_PER_RECIPE + 1 }, (_, index) => ({
      id: `criterion-${index}`,
      name: `Criterion ${index}`,
      description: "Explicit criterion",
      weight: 1,
      required: false,
    }));

    expect(recipeDraftSchema.safeParse({ name: "Too large", threshold: 50, criteria }).success).toBe(false);
  });

  it("allows a compatibility image alongside a full valid image gallery", () => {
    const listing = {
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      imageUrl: "https://img.leboncoin.fr/primary.jpg",
      imageUrls: Array.from(
        { length: MAX_LISTING_IMAGE_URLS },
        (_, index) => `https://img.leboncoin.fr/gallery-${index}.jpg`,
      ),
      status: "detailed",
      scrapedAt: "2026-07-18T09:00:00.000Z",
    };

    expect(listingIngestionSchema.safeParse(listing).success).toBe(true);
    expect(listingIngestionSchema.safeParse({
      ...listing,
      imageUrls: [...listing.imageUrls, "https://img.leboncoin.fr/overflow.jpg"],
    }).success).toBe(false);
  });

  it(`limits evaluation payloads to ${MAX_EVALUATION_IMAGE_URLS} unique HTTPS images`, () => {
    const listing = {
      id: "leboncoin:2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      features: [],
      imageUrls: Array.from(
        { length: MAX_EVALUATION_IMAGE_URLS },
        (_, index) => `https://img.leboncoin.fr/evaluation-${index}.jpg`,
      ),
    };

    expect(filterListingInputSchema.safeParse(listing).success).toBe(true);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: [...listing.imageUrls, "https://img.leboncoin.fr/overflow.jpg"],
    }).success).toBe(false);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: [listing.imageUrls[0], listing.imageUrls[0]],
    }).success).toBe(false);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: ["http://img.leboncoin.fr/insecure.jpg"],
    }).success).toBe(false);
  });
});
