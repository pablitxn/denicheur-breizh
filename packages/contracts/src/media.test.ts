import { describe, expect, it } from "vitest";

import { healthResponseSchema, listingRecordSchema } from "./index.js";

const timestamp = "2026-07-19T10:00:00.000Z";
const assetId = "a".repeat(64);
const listing = {
  source: "leboncoin",
  externalId: "listing-1",
  id: "leboncoin:listing-1",
  url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
  status: "detailed",
  scrapedAt: timestamp,
  lastRunId: "run-1",
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  updatedAt: timestamp,
};

describe("media contracts", () => {
  it("keeps records without imageAssets backward compatible", () => {
    expect(listingRecordSchema.parse(listing)).not.toHaveProperty("imageAssets");
  });

  it("accepts ordered pending and ready assets with API-owned paths", () => {
    const parsed = listingRecordSchema.parse({
      ...listing,
      imageAssets: [
        {
          id: "b".repeat(64),
          sourceUrl: "https://img.leboncoin.fr/pending.jpg",
          status: "pending",
        },
        {
          id: assetId,
          sourceUrl: "https://img.leboncoin.fr/ready.jpg",
          status: "ready",
          thumbnailPath: `/v1/media/${assetId}/thumbnail.webp`,
          galleryPath: `/v1/media/${assetId}/gallery.webp`,
        },
      ],
    });

    expect(parsed.imageAssets?.map((asset) => asset.status)).toEqual(["pending", "ready"]);
  });

  it("rejects media paths that do not belong to the declared asset", () => {
    expect(listingRecordSchema.safeParse({
      ...listing,
      imageAssets: [{
        id: assetId,
        sourceUrl: "https://img.leboncoin.fr/ready.jpg",
        status: "ready",
        thumbnailPath: `/v1/media/${"b".repeat(64)}/thumbnail.webp`,
      }],
    }).success).toBe(false);
  });

  it("reports degraded media independently from database readiness", () => {
    expect(healthResponseSchema.parse({
      status: "degraded",
      service: "denicheur-api",
      database: { status: "ok" },
      media: { status: "degraded", pending: 2, processing: 1, ready: 7, failed: 3 },
      openAiConfigured: false,
    }).media).toEqual({ status: "degraded", pending: 2, processing: 1, ready: 7, failed: 3 });
  });
});
