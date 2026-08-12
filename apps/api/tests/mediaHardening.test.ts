import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import type { IngestionRequest } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import type { Logger } from "../src/logger.js";
import { MEDIA_RETRY_DELAYS_MS, MediaService } from "../src/mediaService.js";
import { MemoryObjectStorage } from "../src/objectStorage.js";
import {
  DenicheurRepository,
  type CompletedMediaAsset,
} from "../src/repository.js";

const INITIAL_NOW = new Date("2026-08-11T12:00:00.000Z");
const SOURCE_URL = "https://img.leboncoin.fr/media-hardening.jpg";
const SHARED_SOURCE_URL = "https://img.leboncoin.fr/media-hardening-shared.jpg";
const ORIGINAL_BYTES = Buffer.from("original-media-hardening");
const THUMBNAIL_BYTES = Buffer.from("thumbnail-media-hardening");
const GALLERY_BYTES = Buffer.from("gallery-media-hardening");
const COMPLETED_MEDIA: CompletedMediaAsset = {
  contentSha256: "a".repeat(64),
  sourceMimeType: "image/jpeg",
  originalObjectKey: "media/aa/original.jpg",
  thumbnailObjectKey: "media/aa/thumbnail.webp",
  galleryObjectKey: "media/aa/gallery.webp",
  originalSizeBytes: ORIGINAL_BYTES.byteLength,
  thumbnailSizeBytes: THUMBNAIL_BYTES.byteLength,
  gallerySizeBytes: GALLERY_BYTES.byteLength,
  width: 1_600,
  height: 900,
};

describe("media delivery admission", () => {
  it("reserves concurrency before opening storage for a second delivery", async () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => INITIAL_NOW });
    const storage = new TrackingStorage();
    const seeded = await seedReadyAsset(repository, storage);
    const service = createService(repository, storage, {
      maxConcurrent: 1,
      maxBytesPerWindow: 1_000,
    });

    try {
      const first = await service.getVariant(seeded.assetId, "thumbnail");

      await expect(service.getVariant(seeded.assetId, "thumbnail")).rejects.toMatchObject({
        statusCode: 429,
        code: "MEDIA_DELIVERY_CONCURRENCY_LIMITED",
      });
      expect(storage.getCalls).toEqual([seeded.completed.thumbnailObjectKey]);
      first.body.destroy();
    } finally {
      await service.stop();
      repository.close();
    }
  });

  it("retains released bytes for the window and rejects before reopening storage", async () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => INITIAL_NOW });
    const storage = new TrackingStorage();
    const seeded = await seedReadyAsset(repository, storage);
    const service = createService(repository, storage, {
      maxConcurrent: 1,
      maxBytesPerWindow: THUMBNAIL_BYTES.byteLength,
    });

    try {
      const first = await service.getVariant(seeded.assetId, "thumbnail");
      const closed = once(first.body, "close");
      first.body.destroy();
      await closed;

      await expect(service.getVariant(seeded.assetId, "thumbnail")).rejects.toMatchObject({
        statusCode: 429,
        code: "MEDIA_DELIVERY_BYTES_LIMITED",
      });
      expect(storage.getCalls).toEqual([seeded.completed.thumbnailObjectKey]);
    } finally {
      await service.stop();
      repository.close();
    }
  });
});

describe("persistent media job recovery", () => {
  it("keeps an unexpired processing lease across service startup and recovers it only after expiry", async () => {
    vi.useFakeTimers();
    const clock = mutableClock();
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-job-recovery-"));
    const databasePath = join(directory, "denicheur.sqlite");
    const initialRepository = new DenicheurRepository({ path: databasePath, now: clock.now });
    initialRepository.ingest(ingestionRequest({
      externalId: "listing-job-recovery",
      runId: "run-job-recovery",
      sourceUrls: [SOURCE_URL],
    }));
    const first = initialRepository.claimMediaJob("abandoned-worker", 60_000);
    if (!first) throw new Error("Expected the seeded media job to be claimable.");
    initialRepository.close();

    try {
      const activeRepository = new DenicheurRepository({ path: databasePath, now: clock.now });
      const activeLogger = recordingLogger();
      const activeService = createService(activeRepository, new TrackingStorage(), undefined, activeLogger);
      try {
        await activeService.start();

        expect(activeRepository.mediaHealthCounts()).toMatchObject({ pending: 0, processing: 1 });
        expect(activeLogger.info).not.toHaveBeenCalledWith(expect.objectContaining({
          event: "media_jobs_recovered",
        }));
      } finally {
        await activeService.stop();
        activeRepository.close();
      }

      clock.advance(60_001);
      const expiredRepository = new DenicheurRepository({ path: databasePath, now: clock.now });
      const expiredLogger = recordingLogger();
      const expiredService = createService(expiredRepository, new TrackingStorage(), undefined, expiredLogger);
      try {
        await expiredService.start();

        expect(expiredRepository.mediaHealthCounts()).toMatchObject({ pending: 1, processing: 0 });
        expect(expiredLogger.info).toHaveBeenCalledWith({ event: "media_jobs_recovered", count: 1 });
        expect(() => expiredRepository.completeMediaJob(first.assetId, first.leaseOwner, COMPLETED_MEDIA))
          .toThrow(/lease is no longer owned/i);
      } finally {
        await expiredService.stop();
        expiredRepository.close();
      }
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("distributed collected-data cleanup fencing", () => {
  it("rejects media ingestion from another replica while object deletion is in progress", async () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-cleanup-fence-"));
    const databasePath = join(directory, "denicheur.sqlite");
    const storage = new BlockFirstDeleteStorage();
    const maintenanceRepository = new DenicheurRepository({ path: databasePath, now: () => INITIAL_NOW });
    await seedReadyAsset(maintenanceRepository, storage);
    maintenanceRepository.ingest(ingestionRequest({
      externalId: "listing-pending-before-cleanup",
      runId: "run-pending-before-cleanup",
      sourceUrls: ["https://img.leboncoin.fr/media-pending-before-cleanup.jpg"],
    }));
    const replicaRepository = new DenicheurRepository({ path: databasePath, now: () => INITIAL_NOW });
    const service = createService(maintenanceRepository, storage);
    const cleanup = service.clearCollectedData();
    let released = false;

    try {
      await storage.firstDeleteStarted;

      expect(replicaRepository.claimMediaJob("other-replica", 60_000)).toBeUndefined();

      expect(captureApiError(() => replicaRepository.ingest(ingestionRequest({
        externalId: "listing-during-cleanup",
        runId: "run-during-cleanup",
        sourceUrls: [SHARED_SOURCE_URL],
      })))).toMatchObject({
        statusCode: 503,
        code: "MAINTENANCE_IN_PROGRESS",
      });

      storage.releaseFirstDelete();
      released = true;
      await expect(cleanup).resolves.toMatchObject({ listings: 2, runs: 2 });
      expect(storage.keys()).toEqual([]);
      expect(replicaRepository.getRun("run-during-cleanup")).toBeUndefined();
      expect(replicaRepository.ingest(ingestionRequest({
        externalId: "listing-after-cleanup",
        runId: "run-after-cleanup",
        sourceUrls: [SHARED_SOURCE_URL],
      }))).toMatchObject({ inserted: 1 });
      expect(replicaRepository.getRun("run-after-cleanup")).toBeDefined();
    } finally {
      if (!released) storage.releaseFirstDelete();
      await cleanup.catch(() => undefined);
      await service.stop();
      replicaRepository.close();
      maintenanceRepository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to start deletion while another replica owns an active media job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-cleanup-active-job-"));
    const databasePath = join(directory, "denicheur.sqlite");
    const storage = new TrackingStorage();
    const maintenanceRepository = new DenicheurRepository({ path: databasePath, now: () => INITIAL_NOW });
    maintenanceRepository.ingest(ingestionRequest({
      externalId: "listing-active-job",
      runId: "run-active-job",
      sourceUrls: [SOURCE_URL],
    }));
    const replicaRepository = new DenicheurRepository({ path: databasePath, now: () => INITIAL_NOW });
    const activeJob = replicaRepository.claimMediaJob("other-replica", 60_000);
    if (!activeJob) throw new Error("Expected the other replica to claim its media job.");
    const service = createService(maintenanceRepository, storage);

    try {
      await expect(service.clearCollectedData()).rejects.toMatchObject({
        statusCode: 409,
        code: "ACTIVE_MEDIA_JOB",
      });
      expect(storage.deleteCalls).toEqual([]);
      expect(replicaRepository.getRun("run-active-job")).toBeDefined();
      replicaRepository.failMediaJob(activeJob.assetId, activeJob.leaseOwner, {
        code: "TEST_COMPLETE",
        message: "Release the active test lease.",
      });
    } finally {
      await service.stop();
      replicaRepository.close();
      maintenanceRepository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a crashed cleanup fenced and permits only an expired-lease takeover to clear SQLite", async () => {
    const clock = mutableClock();
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-cleanup-takeover-"));
    const databasePath = join(directory, "denicheur.sqlite");
    const storage = new TrackingStorage();
    const crashedRepository = new DenicheurRepository({ path: databasePath, now: clock.now });
    await seedReadyAsset(crashedRepository, storage);
    const abandoned = crashedRepository.beginCollectedDataCleanup();
    crashedRepository.close();
    const recoveryRepository = new DenicheurRepository({ path: databasePath, now: clock.now });

    try {
      expect(captureApiError(() => recoveryRepository.ingest(ingestionRequest({
        externalId: "listing-before-takeover",
        runId: "run-before-takeover",
        sourceUrls: [SHARED_SOURCE_URL],
      })))).toMatchObject({ code: "MAINTENANCE_IN_PROGRESS" });
      expect(captureApiError(() => recoveryRepository.beginCollectedDataCleanup()))
        .toMatchObject({ code: "MEDIA_CLEANUP_IN_PROGRESS" });

      clock.advance(5 * 60_000 + 1);
      const replacement = recoveryRepository.beginCollectedDataCleanup();
      expect(replacement.leaseOwner).not.toBe(abandoned.leaseOwner);
      expect(captureApiError(() => recoveryRepository.clearCollectedData({}, abandoned.leaseOwner)))
        .toMatchObject({ code: "MEDIA_CLEANUP_LEASE_LOST" });

      await storage.deleteObjects(replacement.objectKeys);
      recoveryRepository.renewCollectedDataCleanup(replacement.leaseOwner);
      expect(recoveryRepository.clearCollectedData({}, replacement.leaseOwner))
        .toMatchObject({ listings: 1, runs: 1 });
      recoveryRepository.releaseCollectedDataCleanup(replacement.leaseOwner);
      expect(storage.keys()).toEqual([]);
    } finally {
      recoveryRepository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("persistent media garbage collection", () => {
  it("denies an orphaned ready asset without opening its stored object", async () => {
    const context = await createPersistentOrphan(new TrackingStorage());
    const service = createService(context.repository, context.storage);

    try {
      expect(context.repository.getMediaAsset(context.assetId)).toBeUndefined();

      await expect(service.getVariant(context.assetId, "thumbnail")).rejects.toMatchObject({
        statusCode: 404,
        code: "MEDIA_ASSET_NOT_FOUND",
      });
      expect(context.storage.getCalls).toEqual([]);
    } finally {
      await service.stop();
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it("retries object deletion, removes persistent rows, and remains idempotent", async () => {
    vi.useFakeTimers();
    const clock = mutableClock();
    const storage = new FailOnceDeleteStorage();
    const context = await createPersistentOrphan(storage, clock.now);
    const logger = recordingLogger();
    const service = createService(context.repository, storage, undefined, logger);

    try {
      await service.start();
      await flushWorkerTimers();

      expect(storage.deleteCalls).toEqual([[...objectKeys(context.completed)]]);
      expect(storage.keys()).toEqual(objectKeys(context.completed));
      expect(context.repository.listMediaObjectKeys().sort()).toEqual(objectKeys(context.completed));
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
        event: "media_orphan_delete_retry_scheduled",
        attempt: 1,
        retryDelayMs: MEDIA_RETRY_DELAYS_MS[0],
      }));

      clock.advance(MEDIA_RETRY_DELAYS_MS[0]);
      service.kick();
      await flushWorkerTimers();

      expect(storage.deleteCalls).toEqual([
        [...objectKeys(context.completed)],
        [...objectKeys(context.completed)],
      ]);
      expect(storage.keys()).toEqual([]);
      expect(context.repository.listMediaObjectKeys()).toEqual([]);
      expect(mediaRows(context.databasePath, context.assetId)).toEqual({
        assets: 0,
        jobs: 0,
        tombstones: 0,
      });
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
        event: "media_orphan_deleted",
        attempt: 2,
      }));

      service.kick();
      await flushWorkerTimers();
      expect(storage.deleteCalls).toHaveLength(2);
    } finally {
      await service.stop();
      vi.useRealTimers();
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it("keeps content-addressed objects that are still referenced by another asset", async () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => INITIAL_NOW });
    const storage = new TrackingStorage();
    try {
      repository.ingest(ingestionRequest({
        externalId: "listing-shared-content",
        runId: "run-shared-content",
        sourceUrls: [SOURCE_URL, SHARED_SOURCE_URL],
      }));
      let sharedCompleted: CompletedMediaAsset | undefined;
      for (let index = 0; index < 2; index += 1) {
        const job = repository.claimMediaJob("shared-content-worker", 60_000);
        if (!job) throw new Error("Expected both shared-content jobs to be claimable.");
        const staged = repository.stageMediaJobObjects(job.assetId, job.leaseOwner, COMPLETED_MEDIA);
        if (sharedCompleted) expect(objectKeys(staged)).toEqual(objectKeys(sharedCompleted));
        else sharedCompleted = staged;
        repository.completeMediaJob(job.assetId, job.leaseOwner, staged);
      }
      if (!sharedCompleted) throw new Error("Expected shared media metadata.");
      await storeCompletedMedia(storage, sharedCompleted);
      const survivor = repository.getListing({
        source: "leboncoin",
        externalId: "listing-shared-content",
      })?.imageAssets?.find((asset) => asset.sourceUrl === SHARED_SOURCE_URL);
      if (!survivor) throw new Error("Expected the shared-content survivor asset.");

      repository.ingest(ingestionRequest({
        externalId: "listing-shared-content",
        runId: "run-shared-content",
        sourceUrls: [
          SHARED_SOURCE_URL,
          ...Array.from(
            { length: 49 },
            (_, index) => `https://img.leboncoin.fr/media-hardening-replacement-${index}.jpg`,
          ),
        ],
        scrapedAt: new Date(INITIAL_NOW.getTime() + 60_000).toISOString(),
      }));
      const garbage = repository.claimMediaGarbage("shared-content-gc");
      if (!garbage) throw new Error("Expected the displaced asset to be garbage collectable.");

      expect(garbage.objectKeys).toEqual([]);
      await storage.deleteObjects(garbage.objectKeys);
      repository.completeMediaGarbage(garbage.assetId, garbage.leaseOwner);
      expect(storage.keys()).toEqual(objectKeys(sharedCompleted));
      expect(repository.getMediaAsset(survivor.id)).toMatchObject({ status: "ready" });
    } finally {
      repository.close();
    }
  });

  it("isolates a new asset from object keys owned by an active GC lease", async () => {
    const context = await createPersistentOrphan(new TrackingStorage());
    const garbage = context.repository.claimMediaGarbage("object-key-race-worker");
    if (!garbage) throw new Error("Expected the persisted orphan to be claimable.");
    try {
      context.repository.ingest(ingestionRequest({
        externalId: "listing-object-key-race",
        runId: "run-object-key-race",
        sourceUrls: [SHARED_SOURCE_URL],
      }));
      const job = context.repository.claimMediaJob("object-key-stage-worker", 60_000);
      if (!job) throw new Error("Expected the new media job to be claimable.");

      const staged = context.repository.stageMediaJobObjects(
        job.assetId,
        job.leaseOwner,
        COMPLETED_MEDIA,
      );

      expect(objectKeys(staged)).not.toEqual(objectKeys(context.completed));
      expect(objectKeys(staged).some((key) => garbage.objectKeys.includes(key))).toBe(false);
    } finally {
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it("preserves an active deletion lease across a second repository connection", async () => {
    const context = await createPersistentOrphan(new TrackingStorage());
    const garbage = context.repository.claimMediaGarbage("race-test-worker");
    if (!garbage) throw new Error("Expected the persisted orphan to be claimable.");
    const reopenedRepository = new DenicheurRepository({
      path: context.databasePath,
      now: () => INITIAL_NOW,
    });
    const service = createService(context.repository, context.storage);
    const relink = ingestionRequest({
      externalId: "listing-relink",
      runId: "run-relink",
      sourceUrls: [SOURCE_URL],
    });

    try {
      const error = captureApiError(() => reopenedRepository.ingest(relink));

      expect(error).toMatchObject({
        statusCode: 409,
        code: "MEDIA_ASSET_GC_IN_PROGRESS",
      });
      expect(reopenedRepository.getRun("run-relink")).toBeUndefined();
      expect(reopenedRepository.getListing({
        source: "leboncoin",
        externalId: "listing-relink",
      })).toBeUndefined();
      expect(context.repository.getMediaAsset(context.assetId)).toBeUndefined();
      await expect(service.getVariant(context.assetId, "thumbnail")).rejects.toMatchObject({
        statusCode: 404,
        code: "MEDIA_ASSET_NOT_FOUND",
      });
      expect(context.storage.getCalls).toEqual([]);

      await context.storage.deleteObjects(garbage.objectKeys);
      context.repository.completeMediaGarbage(garbage.assetId, garbage.leaseOwner);
      expect(context.repository.listMediaObjectKeys()).toEqual([]);

      expect(reopenedRepository.ingest(relink)).toMatchObject({ inserted: 1 });
      expect(reopenedRepository.getMediaAsset(context.assetId)).toMatchObject({ status: "pending" });
    } finally {
      await service.stop();
      reopenedRepository.close();
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it("keeps an expired tombstone deleting until a replacement lease claims it", async () => {
    const clock = mutableClock();
    const context = await createPersistentOrphan(new TrackingStorage(), clock.now);
    const first = context.repository.claimMediaGarbage("expired-lease-worker");
    if (!first) throw new Error("Expected the persisted orphan to be claimable.");
    clock.advance(5 * 60_000 + 1);
    const reopenedRepository = new DenicheurRepository({
      path: context.databasePath,
      now: clock.now,
    });
    const relink = ingestionRequest({
      externalId: "listing-expired-lease",
      runId: "run-expired-lease",
      sourceUrls: [SOURCE_URL],
    });

    try {
      expect(captureApiError(() => reopenedRepository.ingest(relink))).toMatchObject({
        statusCode: 409,
        code: "MEDIA_ASSET_GC_IN_PROGRESS",
      });
      const replacement = reopenedRepository.claimMediaGarbage("replacement-gc-worker");
      expect(replacement?.leaseOwner).not.toBe(first.leaseOwner);
      expect(() => context.repository.completeMediaGarbage(first.assetId, first.leaseOwner))
        .toThrow(/lease is no longer owned/i);

      await context.storage.deleteObjects(replacement?.objectKeys ?? []);
      reopenedRepository.completeMediaGarbage(replacement!.assetId, replacement!.leaseOwner);
      expect(reopenedRepository.listMediaObjectKeys()).toEqual([]);
    } finally {
      reopenedRepository.close();
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });

  it("keeps a reincarnated asset after an expired worker finishes a delayed object deletion", async () => {
    const clock = mutableClock();
    const storage = new BlockFirstDeleteStorage();
    const context = await createPersistentOrphan(storage, clock.now);
    const first = context.repository.claimMediaGarbage("stale-delete-worker");
    if (!first) throw new Error("Expected the persisted orphan to be claimable.");
    const delayedDelete = storage.deleteObjects(first.objectKeys);
    await storage.firstDeleteStarted;
    clock.advance(5 * 60_000 + 1);
    const replacementRepository = new DenicheurRepository({ path: context.databasePath, now: clock.now });
    let released = false;

    try {
      const replacement = replacementRepository.claimMediaGarbage("replacement-delete-worker");
      if (!replacement) throw new Error("Expected the expired garbage lease to be claimable.");
      await storage.deleteObjects(replacement.objectKeys);
      replacementRepository.completeMediaGarbage(replacement.assetId, replacement.leaseOwner);

      replacementRepository.ingest(ingestionRequest({
        externalId: "listing-reincarnated",
        runId: "run-reincarnated",
        sourceUrls: [SOURCE_URL],
      }));
      const mediaJob = replacementRepository.claimMediaJob("reincarnation-worker", 60_000);
      if (!mediaJob) throw new Error("Expected the reincarnated media job to be claimable.");
      const reincarnated = replacementRepository.stageMediaJobObjects(
        mediaJob.assetId,
        mediaJob.leaseOwner,
        COMPLETED_MEDIA,
      );
      expect(objectKeys(reincarnated).some((key) => first.objectKeys.includes(key))).toBe(false);
      await storeCompletedMedia(storage, reincarnated);
      replacementRepository.completeMediaJob(mediaJob.assetId, mediaJob.leaseOwner, reincarnated);

      storage.releaseFirstDelete();
      released = true;
      await delayedDelete;
      expect(() => context.repository.completeMediaGarbage(first.assetId, first.leaseOwner))
        .toThrow(/lease is no longer owned/i);
      expect(storage.keys()).toEqual(objectKeys(reincarnated));

      const service = createService(replacementRepository, storage);
      const variant = await service.getVariant(mediaJob.assetId, "thumbnail");
      variant.body.destroy();
      await service.stop();
    } finally {
      if (!released) {
        storage.releaseFirstDelete();
        await delayedDelete.catch(() => undefined);
      }
      replacementRepository.close();
      context.repository.close();
      rmSync(context.directory, { recursive: true, force: true });
    }
  });
});

interface DeliveryBudgetOverrides {
  readonly maxConcurrent: number;
  readonly maxBytesPerWindow: number;
}

interface PersistentOrphanContext {
  readonly repository: DenicheurRepository;
  readonly storage: TrackingStorage;
  readonly assetId: string;
  readonly completed: CompletedMediaAsset;
  readonly directory: string;
  readonly databasePath: string;
}

function createService(
  repository: DenicheurRepository,
  storage: TrackingStorage,
  budget?: DeliveryBudgetOverrides,
  logger: Logger = recordingLogger(),
): MediaService {
  return new MediaService({
    repository,
    storage,
    logger,
    concurrency: 1,
    pollIntervalMs: 60_000,
    ...(budget ? {
      deliveryBudgetOptions: {
        ...budget,
        windowMs: 60_000,
        now: () => 0,
      },
    } : {}),
  });
}

async function createPersistentOrphan(
  storage: TrackingStorage,
  now: () => Date = () => INITIAL_NOW,
): Promise<PersistentOrphanContext> {
  const directory = mkdtempSync(join(tmpdir(), "denicheur-media-hardening-"));
  const databasePath = join(directory, "denicheur.sqlite");
  const initialRepository = new DenicheurRepository({ path: databasePath, now });
  const seeded = await seedReadyAsset(initialRepository, storage);
  initialRepository.close();

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("DELETE FROM listings WHERE source = ? AND external_id = ?")
    .run("leboncoin", "listing-media");
  database.close();

  const repository = new DenicheurRepository({ path: databasePath, now });
  return {
    repository,
    storage,
    assetId: seeded.assetId,
    completed: seeded.completed,
    directory,
    databasePath,
  };
}

async function seedReadyAsset(
  repository: DenicheurRepository,
  storage: MemoryObjectStorage,
): Promise<{ readonly assetId: string; readonly completed: CompletedMediaAsset }> {
  repository.ingest(ingestionRequest({
    externalId: "listing-media",
    runId: "run-media",
    sourceUrls: [SOURCE_URL],
  }));
  const assetId = repository.getListing({ source: "leboncoin", externalId: "listing-media" })
    ?.imageAssets?.[0]?.id;
  if (!assetId) throw new Error("Expected ingestion to create a media asset.");
  const job = repository.claimMediaJob("seed-worker", 60_000);
  if (!job || job.assetId !== assetId) throw new Error("Expected the seeded media job to be claimable.");

  const completed = repository.stageMediaJobObjects(assetId, job.leaseOwner, COMPLETED_MEDIA);
  await storeCompletedMedia(storage, completed);
  repository.completeMediaJob(assetId, job.leaseOwner, completed);
  return { assetId, completed };
}

async function storeCompletedMedia(
  storage: MemoryObjectStorage,
  completed: CompletedMediaAsset,
): Promise<void> {
  await Promise.all([
    storage.putObject(completed.originalObjectKey, ORIGINAL_BYTES, "image/jpeg"),
    storage.putObject(completed.thumbnailObjectKey, THUMBNAIL_BYTES, "image/webp"),
    storage.putObject(completed.galleryObjectKey, GALLERY_BYTES, "image/webp"),
  ]);
}

function ingestionRequest(input: {
  readonly externalId: string;
  readonly runId: string;
  readonly sourceUrls: readonly string[];
  readonly scrapedAt?: string;
}): IngestionRequest {
  return {
    run: {
      id: input.runId,
      source: "leboncoin",
      status: "completed",
      startedAt: INITIAL_NOW.toISOString(),
      finishedAt: INITIAL_NOW.toISOString(),
      collected: 1,
    },
    listings: [{
      source: "leboncoin",
      externalId: input.externalId,
      url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${input.externalId}`,
      imageUrls: [...input.sourceUrls],
      status: "detailed",
      scrapedAt: input.scrapedAt ?? INITIAL_NOW.toISOString(),
    }],
  };
}

function objectKeys(completed: CompletedMediaAsset): string[] {
  return [
    completed.galleryObjectKey,
    completed.originalObjectKey,
    completed.thumbnailObjectKey,
  ].sort();
}

function mediaRows(databasePath: string, assetId: string): {
  assets: number;
  jobs: number;
  tombstones: number;
} {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_assets WHERE id = ?) AS assets,
        (SELECT COUNT(*) FROM media_jobs WHERE asset_id = ?) AS jobs,
        (SELECT COUNT(*) FROM media_gc_tombstones WHERE asset_id = ?) AS tombstones
    `).get(assetId, assetId, assetId) as { assets: number; jobs: number; tombstones: number };
    return { assets: row.assets, jobs: row.jobs, tombstones: row.tombstones };
  } finally {
    database.close();
  }
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

async function flushWorkerTimers(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(1);
}

function recordingLogger(): Logger {
  return {
    info: vi.fn<Logger["info"]>(),
    error: vi.fn<Logger["error"]>(),
  };
}

function captureApiError(action: () => unknown): ApiError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected an ApiError to be thrown.");
}

class TrackingStorage extends MemoryObjectStorage {
  readonly getCalls: string[] = [];
  readonly deleteCalls: string[][] = [];

  override async getObject(key: string) {
    this.getCalls.push(key);
    return super.getObject(key);
  }

  override async deleteObjects(keys: readonly string[]): Promise<void> {
    this.deleteCalls.push([...keys].sort());
    await this.deleteStoredObjects(keys);
  }

  protected async deleteStoredObjects(keys: readonly string[]): Promise<void> {
    await super.deleteObjects(keys);
  }
}

class FailOnceDeleteStorage extends TrackingStorage {
  override async deleteObjects(keys: readonly string[]): Promise<void> {
    this.deleteCalls.push([...keys].sort());
    if (this.deleteCalls.length === 1) throw new Error("simulated persistent GC deletion failure");
    await this.deleteStoredObjects(keys);
  }
}

class BlockFirstDeleteStorage extends TrackingStorage {
  private release!: () => void;
  private started!: () => void;
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  readonly firstDeleteStarted = new Promise<void>((resolve) => {
    this.started = resolve;
  });

  override async deleteObjects(keys: readonly string[]): Promise<void> {
    this.deleteCalls.push([...keys].sort());
    if (this.deleteCalls.length === 1) {
      this.started();
      await this.releasePromise;
    }
    await this.deleteStoredObjects(keys);
  }

  releaseFirstDelete(): void {
    this.release();
  }
}
