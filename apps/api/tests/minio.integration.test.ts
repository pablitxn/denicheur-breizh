import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import sharp from "sharp";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp, evaluationExecutionWorkerFor } from "../src/app.js";
import { loadConfig, type MediaConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { MediaService } from "../src/mediaService.js";
import { S3ObjectStorage } from "../src/objectStorage.js";
import { DenicheurRepository } from "../src/repository.js";

const RUN_MINIO_INTEGRATION = process.env.RUN_MINIO_INTEGRATION === "1";
const describeMinio = RUN_MINIO_INTEGRATION ? describe : describe.skip;
const TEST_TIMEOUT_MS = 30_000;

describeMinio("S3ObjectStorage with local MinIO", () => {
  it("puts, streams, and deletes an object through the real S3-compatible client", async () => {
    const storage = new S3ObjectStorage(localMinioConfig());
    const key = `integration-tests/${randomUUID()}/stream.txt`;
    const expected = Buffer.from(`denicheur-minio-${randomUUID()}`);

    try {
      await expect(storage.checkHealth()).resolves.toBe(true);
      await storage.putObject(key, expected, "text/plain; charset=utf-8");

      const object = await storage.getObject(key);
      expect(object).toBeDefined();
      expect(object?.body).toBeInstanceOf(Readable);
      expect(object).toMatchObject({
        contentLength: expected.byteLength,
        contentType: "text/plain; charset=utf-8",
        etag: expect.stringMatching(/^"[a-f0-9]+"$/),
      });
      expect(await readAll(object!.body)).toEqual(expected);

      await storage.deleteObjects([key]);
      await expect(storage.getObject(key)).resolves.toBeUndefined();
    } finally {
      await storage.deleteObjects([key]).catch(() => undefined);
      storage.close();
    }
  }, TEST_TIMEOUT_MS);

  it("recovers a leased job, serves ETag/304, and removes MinIO objects before SQLite", async () => {
    const storage = new S3ObjectStorage(localMinioConfig());
    const repository = new DenicheurRepository({ path: ":memory:" });
    const logger = recordingLogger();
    const sourceUrl = `https://img.leboncoin.fr/minio-integration-${randomUUID()}.jpg`;
    const jpeg = await uniqueJpeg();
    seedListing(repository, sourceUrl);

    const abandonedLease = repository.claimMediaJob("abandoned-integration-worker", 60_000);
    expect(abandonedLease).toMatchObject({ sourceUrl, attempt: 1 });
    expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 1, ready: 0, failed: 0 });

    const fetchMock = vi.fn(async () => new Response(new Uint8Array(jpeg), {
      headers: {
        "content-length": String(jpeg.byteLength),
        "content-type": "image/jpeg",
      },
    }));
    const mediaService = new MediaService({
      repository,
      storage,
      logger,
      fetchImpl: fetchMock,
      pollIntervalMs: 10,
    });
    let app: ReturnType<typeof createApp> | undefined;

    try {
      await mediaService.start();
      await vi.waitFor(() => {
        expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 1, failed: 0 });
      }, { timeout: 10_000, interval: 25 });

      expect(logger.info).toHaveBeenCalledWith({ event: "media_jobs_recovered", count: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const objectKeys = repository.listMediaObjectKeys();
      expect(objectKeys).toHaveLength(3);
      for (const key of objectKeys) {
        const storedObject = await storage.getObject(key);
        expect(storedObject).toBeDefined();
        await readAll(storedObject!.body);
      }

      const asset = repository.getListing({ source: "leboncoin", externalId: "minio-integration" })
        ?.imageAssets?.[0];
      expect(asset).toMatchObject({ sourceUrl, status: "ready" });
      app = createApp({
        config: loadConfig({ NODE_ENV: "test", DENICHEUR_DB_PATH: ":memory:" }),
        filterService: { filter: vi.fn() },
        repository,
        logger,
        mediaService,
      });

      const first = await request(app).get(asset!.thumbnailPath!).expect(200);
      expect(first.headers["content-type"]).toMatch(/^image\/webp/);
      expect(first.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(first.headers.etag).toMatch(/^"[a-f0-9]+"$/);
      expect(Number(first.headers["content-length"])).toBe(first.body.length);
      await expect(sharp(first.body).metadata()).resolves.toMatchObject({ format: "webp", width: 480 });

      await request(app)
        .get(asset!.thumbnailPath!)
        .set("If-None-Match", `W/${first.headers.etag as string}`)
        .expect(304)
        .expect("ETag", first.headers.etag as string)
        .expect("Cache-Control", "public, max-age=31536000, immutable");

      await request(app)
        .post("/v1/maintenance/collected-data/clear")
        .send({ confirm: "clear-collected-data" })
        .expect(200);
      expect(repository.listListings({ limit: 10, sort: "updatedAt", order: "desc" }).total).toBe(0);
      expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 0 });
      for (const key of objectKeys) await expect(storage.getObject(key)).resolves.toBeUndefined();
    } finally {
      if (app) await evaluationExecutionWorkerFor(app).dispose();
      await mediaService.clearCollectedData().catch(async () => {
        const keys = repository.listMediaObjectKeys();
        if (keys.length) await storage.deleteObjects(keys).catch(() => undefined);
      });
      await mediaService.stop();
      repository.close();
    }
  }, TEST_TIMEOUT_MS);
});

function localMinioConfig(): MediaConfig {
  const endpoint = process.env.MEDIA_S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsedEndpoint.hostname)) {
    throw new Error("The opt-in MinIO integration test only accepts a loopback HTTP endpoint.");
  }

  return loadConfig({
    NODE_ENV: "test",
    MEDIA_STORAGE_MODE: "minio",
    MEDIA_S3_ENDPOINT: endpoint,
    MEDIA_S3_BUCKET: process.env.MEDIA_S3_BUCKET ?? "denicheur-breizh-media",
    MEDIA_S3_REGION: process.env.MEDIA_S3_REGION ?? "us-east-1",
    MEDIA_S3_ACCESS_KEY_ID: process.env.MEDIA_S3_ACCESS_KEY_ID ?? "denicheur-local-media",
    MEDIA_S3_SECRET_ACCESS_KEY: process.env.MEDIA_S3_SECRET_ACCESS_KEY ?? "denicheur-local-media-password",
    MEDIA_S3_FORCE_PATH_STYLE: process.env.MEDIA_S3_FORCE_PATH_STYLE ?? "true",
  }).media;
}

function seedListing(repository: DenicheurRepository, sourceUrl: string): void {
  repository.ingest({
    run: { id: "minio-integration-run", source: "leboncoin", status: "completed" },
    listings: [{
      source: "leboncoin",
      externalId: "minio-integration",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/minio-integration",
      imageUrl: sourceUrl,
      imageUrls: [sourceUrl],
      status: "detailed",
      scrapedAt: "2026-07-19T12:00:00.000Z",
    }],
  });
}

async function uniqueJpeg(): Promise<Buffer> {
  const width = 640;
  const height = 400;
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).jpeg({ quality: 82 }).toBuffer();
}

function recordingLogger(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn<Logger["info"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
