import type { Readable } from "node:stream";

import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IngestionRequest } from "../src/contracts.js";
import type { Logger } from "../src/logger.js";
import { MEDIA_RETRY_DELAYS_MS, MediaService } from "../src/mediaService.js";
import { MemoryObjectStorage } from "../src/objectStorage.js";
import { DenicheurRepository, type MediaAdmissionPolicy } from "../src/repository.js";
import type { MediaFetch } from "../src/mediaProcessor.js";

const INITIAL_NOW = new Date("2026-07-19T12:00:00.000Z");
const contexts: Array<{ repository: DenicheurRepository; service: MediaService }> = [];
let imageFixture: Buffer;

beforeAll(async () => {
  imageFixture = await sharp({
    create: { width: 1_600, height: 900, channels: 3, background: "#789abc" },
  }).jpeg({ quality: 88 }).toBuffer();
});

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) {
    try {
      await context.service.stop();
    } finally {
      context.repository.close();
    }
  }
});

describe("MediaService worker", () => {
  it("processes queued assets, streams variants, and deduplicates identical content", async () => {
    const sourceUrls = [
      "https://img.leboncoin.fr/listing-a.jpg",
      "https://img.leboncoin.fr/listing-b.jpg",
    ];
    const fetchMock = vi.fn<MediaFetch>(async () => imageResponse(imageFixture));
    const storage = new MemoryObjectStorage();
    const { repository, service } = await startService({ sourceUrls, storage, fetchImpl: fetchMock });

    await vi.waitFor(() => {
      expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 2, failed: 0 });
    }, { timeout: 2_000, interval: 5 });

    const listing = repository.getListing({ source: "leboncoin", externalId: "listing-media" });
    expect(listing?.imageAssets).toEqual(sourceUrls.map((sourceUrl) => expect.objectContaining({
      sourceUrl,
      status: "ready",
      thumbnailPath: expect.stringMatching(/^\/v1\/media\/[a-f0-9]{64}\/thumbnail\.webp$/),
      galleryPath: expect.stringMatching(/^\/v1\/media\/[a-f0-9]{64}\/gallery\.webp$/),
    })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.keys()).toHaveLength(3);
    expect(repository.listMediaObjectKeys()).toHaveLength(3);

    const firstAsset = listing?.imageAssets?.[0];
    expect(firstAsset).toBeDefined();
    const thumbnail = await service.getVariant(firstAsset!.id, "thumbnail");
    const thumbnailBytes = await readAll(thumbnail.body);
    expect(thumbnail).toMatchObject({
      contentLength: thumbnailBytes.byteLength,
      contentType: "image/webp",
      etag: expect.stringMatching(/^"[a-f0-9]{64}"$/),
    });
    await expect(sharp(thumbnailBytes).metadata()).resolves.toMatchObject({
      format: "webp",
      width: 480,
      height: 270,
    });
  });

  it("fails an over-budget processed asset once without uploading or retrying it", async () => {
    const fetchMock = vi.fn<MediaFetch>(async () => imageResponse(imageFixture));
    const storage = new MemoryObjectStorage();
    const logger = recordingLogger();
    const { repository } = await startService({
      sourceUrls: ["https://img.leboncoin.fr/over-budget.jpg"],
      storage,
      fetchImpl: fetchMock,
      logger,
      mediaAdmission: {
        maxAssetsPerRun: 10,
        maxPendingJobs: 10,
        maxReservedBytes: 1,
        reservedBytesPerAsset: 1,
      },
    });

    await vi.waitFor(() => {
      expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 1 });
    }, { timeout: 2_000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.keys()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "media_asset_failed",
      code: "MEDIA_STORAGE_BUDGET_EXCEEDED",
      attempt: 1,
    }));
  });

  it("uses all five retry delays before making a retryable CDN failure terminal", async () => {
    const clock = mutableClock();
    const fetchMock = vi.fn<MediaFetch>(async () => new Response(null, { status: 503 }));
    const logger = recordingLogger();
    const { repository, service } = await startService({
      sourceUrls: ["https://img.leboncoin.fr/retry.jpg"],
      storage: new MemoryObjectStorage(),
      fetchImpl: fetchMock,
      logger,
      now: clock.now,
    });

    for (const [index, retryDelayMs] of MEDIA_RETRY_DELAYS_MS.entries()) {
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledTimes(index + 1);
      }, { timeout: 2_000, interval: 5 });
      expect(logger.error).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
        event: "media_asset_retry_scheduled",
        attempt: index + 1,
        code: "SOURCE_HTTP_503",
        retryDelayMs,
      }));
      expect(repository.mediaHealthCounts().pending).toBe(1);
      clock.advance(retryDelayMs);
      service.kick();
    }

    await vi.waitFor(() => {
      expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 1 });
      expect(logger.error).toHaveBeenCalledTimes(6);
    }, { timeout: 2_000, interval: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(logger.error).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "media_asset_failed",
      attempt: 6,
      code: "SOURCE_HTTP_503",
    }));
  });

  it("marks a non-allowlisted source as permanently failed without downloading it", async () => {
    const fetchMock = vi.fn<MediaFetch>();
    const logger = recordingLogger();
    const { repository } = await startService({
      sourceUrls: ["https://example.com/not-allowed.jpg"],
      storage: new MemoryObjectStorage(),
      fetchImpl: fetchMock,
      logger,
    });

    await vi.waitFor(() => {
      expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 1 });
    }, { timeout: 2_000, interval: 5 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: "media_asset_failed",
      attempt: 1,
      code: "SOURCE_URL_NOT_ALLOWED",
    }));
  });
});

describe("MediaService cleanup", () => {
  it("waits for every in-flight upload before deleting staged object keys", async () => {
    const storage = new PartiallyFailingPutStorage();
    const { repository, service } = await startService({
      sourceUrls: ["https://img.leboncoin.fr/in-flight-cleanup.jpg"],
      storage,
      fetchImpl: async () => imageResponse(imageFixture),
    });
    await vi.waitFor(() => expect(storage.putCalls).toBe(3), { timeout: 2_000, interval: 5 });

    let cleanupFinished = false;
    const cleanup = service.clearCollectedData().then((deleted) => {
      cleanupFinished = true;
      return deleted;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanupFinished).toBe(false);
    expect(repository.getListing({ source: "leboncoin", externalId: "listing-media" })).toBeDefined();

    storage.releaseUploads();
    await expect(cleanup).resolves.toMatchObject({ listings: 1, runs: 1 });
    expect(storage.keys()).toEqual([]);
    expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 0 });
  });

  it("preserves SQLite when object deletion fails and supports an idempotent retry", async () => {
    const storage = new ToggleDeleteStorage();
    const { repository, service } = await startService({
      sourceUrls: ["https://img.leboncoin.fr/cleanup.jpg"],
      storage,
      fetchImpl: async () => imageResponse(imageFixture),
    });
    await vi.waitFor(() => {
      expect(repository.mediaHealthCounts().ready).toBe(1);
    }, { timeout: 2_000, interval: 5 });
    expect(storage.keys()).toHaveLength(3);

    storage.failDeletes = true;
    await expect(service.clearCollectedData()).rejects.toMatchObject({
      statusCode: 503,
      code: "MEDIA_CLEANUP_FAILED",
    });
    expect(repository.getListing({ source: "leboncoin", externalId: "listing-media" })).toBeDefined();
    expect(repository.mediaHealthCounts().ready).toBe(1);
    expect(storage.keys()).toHaveLength(3);
    expect(service.health().status).toBe("degraded");

    storage.failDeletes = false;
    await expect(service.clearCollectedData()).resolves.toMatchObject({ listings: 1, runs: 1 });
    expect(repository.listListings({ limit: 10, sort: "updatedAt", order: "desc" }).total).toBe(0);
    expect(repository.mediaHealthCounts()).toEqual({ pending: 0, processing: 0, ready: 0, failed: 0 });
    expect(storage.keys()).toEqual([]);
    expect(service.health().status).toBe("ok");
  });

  it("checks active runs before deleting any stored object", async () => {
    const storage = new MemoryObjectStorage();
    const { repository, service } = await startService({
      sourceUrls: ["https://img.leboncoin.fr/active-cleanup.jpg"],
      storage,
      fetchImpl: async () => imageResponse(imageFixture),
    });
    await vi.waitFor(() => expect(repository.mediaHealthCounts().ready).toBe(1), {
      timeout: 2_000,
      interval: 5,
    });
    repository.ingest({
      run: { id: "run-active", source: "leboncoin", status: "collecting-search" },
      listings: [],
    });

    await expect(service.clearCollectedData()).rejects.toMatchObject({ code: "ACTIVE_RUN" });
    expect(storage.keys()).toHaveLength(3);
    expect(repository.getListing({ source: "leboncoin", externalId: "listing-media" })).toBeDefined();
  });
});

interface StartServiceOptions {
  readonly sourceUrls: readonly string[];
  readonly storage: MemoryObjectStorage;
  readonly fetchImpl: MediaFetch;
  readonly logger?: ReturnType<typeof recordingLogger>;
  readonly now?: () => Date;
  readonly mediaAdmission?: MediaAdmissionPolicy;
}

async function startService(options: StartServiceOptions): Promise<{
  repository: DenicheurRepository;
  service: MediaService;
}> {
  const repository = new DenicheurRepository({
    path: ":memory:",
    ...(options.now ? { now: options.now } : { now: () => INITIAL_NOW }),
    ...(options.mediaAdmission ? { mediaAdmission: options.mediaAdmission } : {}),
  });
  seedListing(repository, options.sourceUrls);
  const service = new MediaService({
    repository,
    storage: options.storage,
    fetchImpl: options.fetchImpl,
    logger: options.logger ?? recordingLogger(),
    concurrency: 2,
    pollIntervalMs: 5,
  });
  contexts.push({ repository, service });
  await service.start();
  return { repository, service };
}

function seedListing(repository: DenicheurRepository, sourceUrls: readonly string[]): void {
  const request: IngestionRequest = {
    run: {
      id: "run-media",
      source: "leboncoin",
      status: "completed",
      startedAt: INITIAL_NOW.toISOString(),
      finishedAt: INITIAL_NOW.toISOString(),
      collected: 1,
    },
    listings: [{
      source: "leboncoin",
      externalId: "listing-media",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-media",
      imageUrl: sourceUrls[0],
      imageUrls: [...sourceUrls],
      status: "detailed",
      scrapedAt: INITIAL_NOW.toISOString(),
    }],
  };
  repository.ingest(request);
}

function recordingLogger() {
  return {
    info: vi.fn<Logger["info"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;
}

function mutableClock() {
  let nowMs = INITIAL_NOW.getTime();
  return {
    now: () => new Date(nowMs),
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
  };
}

function imageResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": "image/jpeg",
    },
  });
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class ToggleDeleteStorage extends MemoryObjectStorage {
  failDeletes = false;

  override async deleteObjects(keys: readonly string[]): Promise<void> {
    if (this.failDeletes) throw new Error("simulated object deletion failure");
    await super.deleteObjects(keys);
  }
}

class PartiallyFailingPutStorage extends MemoryObjectStorage {
  private releasePendingUploads!: () => void;
  private readonly uploadsReleased = new Promise<void>((resolve) => {
    this.releasePendingUploads = resolve;
  });
  putCalls = 0;

  override async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.putCalls += 1;
    if (this.putCalls === 1) throw new Error("simulated first upload failure");
    await this.uploadsReleased;
    await super.putObject(key, body, contentType);
  }

  releaseUploads(): void {
    this.releasePendingUploads();
  }
}
