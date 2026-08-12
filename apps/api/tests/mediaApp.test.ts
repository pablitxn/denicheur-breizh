import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp, evaluationExecutionWorkerFor } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { MediaService } from "../src/mediaService.js";
import { MemoryObjectStorage } from "../src/objectStorage.js";
import { DenicheurRepository } from "../src/repository.js";

let jpeg: Buffer;

beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 800, height: 500, channels: 3, background: "#456789" },
  }).jpeg().toBuffer();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("media HTTP API", () => {
  it("streams immutable variants, honors ETag, reports health, and cleans storage before SQLite", async () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    const storage = new MemoryObjectStorage();
    const mediaService = new MediaService({
      repository,
      storage,
      logger: logger(),
      pollIntervalMs: 5,
      fetchImpl: async () => new Response(new Uint8Array(jpeg), {
        headers: { "content-type": "image/jpeg", "content-length": String(jpeg.byteLength) },
      }),
    });
    seed(repository);
    await mediaService.start();
    await vi.waitFor(() => expect(repository.mediaHealthCounts().ready).toBe(1), { timeout: 2_000, interval: 5 });
    const app = createApp({
      config: loadConfig({ DENICHEUR_DB_PATH: ":memory:" }),
      filterService: { filter: vi.fn() },
      repository,
      logger: logger(),
      mediaService,
    });

    try {
      const asset = repository.getListing({ source: "leboncoin", externalId: "listing-media" })?.imageAssets?.[0];
      expect(asset?.status).toBe("ready");
      const health = await request(app).get("/health").expect(200);
      expect(health.body).toEqual({ status: "ok", service: "denicheur-api" });
      const healthDetails = await request(app).get("/v1/health/details").expect(200);
      expect(healthDetails.body.media).toEqual({ status: "ok", pending: 0, processing: 0, ready: 1, failed: 0 });

      const response = await request(app).get(asset!.thumbnailPath!).expect(200);
      expect(response.headers["content-type"]).toMatch(/^image\/webp/);
      expect(response.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
      const etag = response.headers.etag as string;
      expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
      expect(Buffer.isBuffer(response.body)).toBe(true);
      await expect(sharp(response.body).metadata()).resolves.toMatchObject({ format: "webp", width: 480 });

      const notModified = await request(app)
        .get(asset!.thumbnailPath!)
        .set("If-None-Match", `W/${etag}`)
        .expect(304)
        .expect("ETag", etag);
      expect(notModified.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

      await request(app)
        .post("/v1/maintenance/collected-data/clear")
        .send({ confirm: "clear-collected-data" })
        .expect(200);
      expect(storage.keys()).toEqual([]);
      expect(repository.listListings({ limit: 10, sort: "updatedAt", order: "desc" }).total).toBe(0);
    } finally {
      await evaluationExecutionWorkerFor(app).dispose();
      await mediaService.stop();
      repository.close();
    }
  });

  it("returns pending assets immediately and a not-ready response for their variant", async () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    const mediaService = new MediaService({ repository, logger: logger() });
    seed(repository);
    const app = createApp({
      config: loadConfig({ DENICHEUR_DB_PATH: ":memory:" }),
      filterService: { filter: vi.fn() },
      repository,
      logger: logger(),
      mediaService,
    });
    try {
      const listing = await request(app)
        .get("/v1/listings/leboncoin/listing-media")
        .expect(200);
      expect(listing.body.imageAssets).toEqual([expect.objectContaining({ status: "pending" })]);
      const assetId = listing.body.imageAssets[0].id as string;
      const notReady = await request(app).get(`/v1/media/${assetId}/gallery.webp`).expect(404);
      expect(notReady.body).toEqual(expect.objectContaining({
        error: expect.objectContaining({ code: "MEDIA_ASSET_NOT_READY" }),
      }));
    } finally {
      await evaluationExecutionWorkerFor(app).dispose();
      repository.close();
    }
  });

  it("returns non-ready health when media storage is degraded", async () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    const storage = new MemoryObjectStorage();
    vi.spyOn(storage, "checkHealth").mockResolvedValue(false);
    const mediaService = new MediaService({ repository, storage, logger: logger() });
    await mediaService.start();
    const app = createApp({
      config: loadConfig({ DENICHEUR_DB_PATH: ":memory:" }),
      filterService: { filter: vi.fn() },
      repository,
      logger: logger(),
      mediaService,
    });
    try {
      const health = await request(app).get("/health").expect(503);
      expect(health.body).toEqual({ status: "degraded", service: "denicheur-api" });
      const healthDetails = await request(app).get("/v1/health/details").expect(503);
      expect(healthDetails.body).toMatchObject({
        status: "degraded",
        database: { status: "ok" },
        media: { status: "degraded" },
      });
    } finally {
      await evaluationExecutionWorkerFor(app).dispose();
      await mediaService.stop();
      repository.close();
    }
  });
});

function seed(repository: DenicheurRepository): void {
  repository.ingest({
    run: { id: "run-media", source: "leboncoin", status: "completed" },
    listings: [{
      source: "leboncoin",
      externalId: "listing-media",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-media",
      imageUrls: ["https://img.leboncoin.fr/http-test.jpg"],
      status: "detailed",
      scrapedAt: "2026-07-19T10:00:00.000Z",
    }],
  });
}

function logger(): Logger {
  return { info: vi.fn(), error: vi.fn() };
}
