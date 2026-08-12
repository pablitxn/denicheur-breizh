import { randomUUID } from "node:crypto";

import type {
  ClearCollectedDataOptions,
  CollectedDataCounts,
  DenicheurRepository,
  MediaGarbageCollectionJob,
  MediaHealthCounts,
  MediaJob,
} from "./repository.js";
import { ApiError } from "./errors.js";
import type { Logger } from "./logger.js";
import { MediaDeliveryBudget, type MediaDeliveryBudgetOptions } from "./mediaDeliveryBudget.js";
import { MediaProcessingError, processMediaSource, type MediaFetch } from "./mediaProcessor.js";
import type { ObjectStorage, StoredObject } from "./objectStorage.js";

export const MEDIA_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MEDIA_LEASE_DURATION_MS = 5 * 60_000;
const STORAGE_HEALTH_INTERVAL_MS = 30_000;

export interface MediaServiceOptions {
  readonly repository: DenicheurRepository;
  readonly storage?: ObjectStorage;
  readonly logger: Logger;
  readonly fetchImpl?: MediaFetch;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly deliveryBudget?: MediaDeliveryBudget;
  readonly deliveryBudgetOptions?: MediaDeliveryBudgetOptions;
}

export interface MediaHealth extends MediaHealthCounts {
  readonly status: "disabled" | "ok" | "degraded";
}

export type MediaVariant = "thumbnail" | "gallery";

export class MediaService {
  private readonly repository: DenicheurRepository;
  private readonly storage: ObjectStorage | undefined;
  private readonly logger: Logger;
  private readonly fetchImpl: MediaFetch | undefined;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly deliveryBudget: MediaDeliveryBudget;
  private readonly workerId = `media-worker-${randomUUID()}`;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private running = false;
  private paused = false;
  private pumping = false;
  private storageHealthy = false;
  private maintenanceActive = false;
  private lastStorageHealthCheckAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: MediaServiceOptions) {
    this.repository = options.repository;
    this.storage = options.storage;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl;
    this.concurrency = options.concurrency ?? 2;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.deliveryBudget = options.deliveryBudget ?? new MediaDeliveryBudget(options.deliveryBudgetOptions);
  }

  async start(): Promise<void> {
    if (this.running || !this.storage) return;
    this.running = true;
    this.paused = false;
    const recoveredJobs = this.repository.recoverProcessingMediaJobs();
    if (recoveredJobs > 0) {
      this.logger.info({ event: "media_jobs_recovered", count: recoveredJobs });
    }
    this.storageHealthy = await this.storage.checkHealth();
    this.lastStorageHealthCheckAt = Date.now();
    this.schedulePump(0);
  }

  async stop(): Promise<void> {
    if (!this.storage) return;
    this.running = false;
    await this.pause();
    this.storage.close();
  }

  health(): MediaHealth {
    const counts = this.repository.mediaHealthCounts();
    return {
      status: !this.storage ? "disabled" : this.storageHealthy ? "ok" : "degraded",
      ...counts,
    };
  }

  kick(): void {
    if (!this.running || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedulePump(0);
  }

  isMaintenanceActive(): boolean {
    return this.maintenanceActive || this.repository.isCollectedDataCleanupActive();
  }

  async getVariant(assetId: string, variant: MediaVariant): Promise<StoredObject> {
    const asset = this.repository.getMediaAsset(assetId);
    if (!asset) throw new ApiError(404, "MEDIA_ASSET_NOT_FOUND", "The requested media asset does not exist.");
    if (asset.status !== "ready") {
      throw new ApiError(404, "MEDIA_ASSET_NOT_READY", "The requested media asset is not ready.");
    }
    if (!this.storage) {
      throw new ApiError(503, "MEDIA_STORAGE_DISABLED", "Media storage is not enabled.");
    }
    const objectKey = variant === "thumbnail" ? asset.thumbnailObjectKey : asset.galleryObjectKey;
    const expectedSize = variant === "thumbnail" ? asset.thumbnailSizeBytes : asset.gallerySizeBytes;
    if (!objectKey) {
      throw new ApiError(503, "MEDIA_OBJECT_UNAVAILABLE", "The requested media variant is unavailable.");
    }
    if (expectedSize === undefined) {
      throw new ApiError(503, "MEDIA_OBJECT_UNAVAILABLE", "The requested media variant metadata is unavailable.");
    }
    const releaseDelivery = this.deliveryBudget.acquire(expectedSize);
    try {
      const object = await this.storage.getObject(objectKey);
      if (!object) {
        releaseDelivery();
        this.storageHealthy = false;
        throw new ApiError(503, "MEDIA_OBJECT_UNAVAILABLE", "The requested media variant is unavailable.");
      }
      if (object.contentLength !== expectedSize) {
        object.body.destroy();
        releaseDelivery();
        this.storageHealthy = false;
        throw new ApiError(503, "MEDIA_OBJECT_UNAVAILABLE", "The requested media variant metadata is inconsistent.");
      }
      object.body.once("end", releaseDelivery);
      object.body.once("close", releaseDelivery);
      object.body.once("error", releaseDelivery);
      this.storageHealthy = true;
      return object;
    } catch (error) {
      releaseDelivery();
      if (error instanceof ApiError) throw error;
      this.storageHealthy = false;
      throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "Media storage is temporarily unavailable.", { cause: error });
    }
  }

  async clearCollectedData(options: ClearCollectedDataOptions = {}): Promise<CollectedDataCounts> {
    if (this.maintenanceActive) {
      throw new ApiError(409, "MEDIA_CLEANUP_IN_PROGRESS", "Collected data cleanup is already in progress.");
    }
    this.maintenanceActive = true;
    const shouldResume = this.running && !this.paused;
    let cleanupLeaseOwner: string | undefined;
    try {
      await this.pause();
      const cleanup = this.repository.beginCollectedDataCleanup(options);
      cleanupLeaseOwner = cleanup.leaseOwner;
      if (this.storage && !(await this.storage.checkHealth())) {
        this.storageHealthy = false;
        throw new ApiError(
          503,
          "MEDIA_CLEANUP_FAILED",
          "Media storage is unavailable; SQLite was preserved for an idempotent retry.",
        );
      }
      if (cleanup.objectKeys.length) {
        if (!this.storage) {
          throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "Media storage must be available before collected data can be cleared.");
        }
        try {
          await this.storage.deleteObjects(cleanup.objectKeys);
          this.storageHealthy = true;
        } catch (error) {
          this.storageHealthy = false;
          throw new ApiError(
            503,
            "MEDIA_CLEANUP_FAILED",
            "Media objects could not be deleted; SQLite was preserved for an idempotent retry.",
            { cause: error },
          );
        }
      }
      this.repository.renewCollectedDataCleanup(cleanup.leaseOwner);
      return this.repository.clearCollectedData(options, cleanup.leaseOwner);
    } finally {
      if (cleanupLeaseOwner) this.repository.releaseCollectedDataCleanup(cleanupLeaseOwner);
      this.maintenanceActive = false;
      if (shouldResume) this.resume();
    }
  }

  private schedulePump(delayMs: number): void {
    if (!this.running || this.paused || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, delayMs);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.running || this.paused || !this.storage) return;
    this.pumping = true;
    let foundWork = false;
    try {
      while (this.running && !this.paused && this.activeTasks.size < this.concurrency) {
        const garbage = this.repository.claimMediaGarbage(this.workerId);
        if (garbage) {
          foundWork = true;
          const task = this.processGarbage(garbage).finally(() => {
            this.activeTasks.delete(task);
            this.schedulePump(0);
          });
          this.activeTasks.add(task);
          continue;
        }
        const job = this.repository.claimMediaJob(this.workerId, MEDIA_LEASE_DURATION_MS);
        if (!job) break;
        foundWork = true;
        const controller = new AbortController();
        this.activeControllers.set(job.leaseOwner, controller);
        const task = this.processJob(job, controller.signal).finally(() => {
          this.activeControllers.delete(job.leaseOwner);
          this.activeTasks.delete(task);
          this.schedulePump(0);
        });
        this.activeTasks.add(task);
      }
    } finally {
      this.pumping = false;
    }
    if (!foundWork && this.activeTasks.size < this.concurrency) {
      if (Date.now() - this.lastStorageHealthCheckAt >= STORAGE_HEALTH_INTERVAL_MS) {
        this.storageHealthy = await this.storage.checkHealth();
        this.lastStorageHealthCheckAt = Date.now();
      }
      this.schedulePump(this.pollIntervalMs);
    }
  }

  private async processJob(job: MediaJob, signal: AbortSignal): Promise<void> {
    try {
      const processed = await processMediaSource(job.sourceUrl, {
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        signal,
      });
      const completed = this.repository.stageMediaJobObjects(job.assetId, job.leaseOwner, processed.completed);
      try {
        const uploads = await Promise.allSettled([
          this.storage!.putObject(
            completed.originalObjectKey,
            processed.original,
            completed.sourceMimeType,
          ),
          this.storage!.putObject(completed.thumbnailObjectKey, processed.thumbnail, "image/webp"),
          this.storage!.putObject(completed.galleryObjectKey, processed.gallery, "image/webp"),
        ]);
        const failures = uploads.flatMap((upload) => upload.status === "rejected" ? [upload.reason] : []);
        if (failures.length) {
          throw new AggregateError(failures, "One or more media objects could not be stored.");
        }
        this.storageHealthy = true;
      } catch (error) {
        this.storageHealthy = false;
        throw new MediaProcessingError(
          "MEDIA_STORAGE_UNAVAILABLE",
          "Media variants could not be stored.",
          true,
          { cause: error },
        );
      }
      this.repository.completeMediaJob(job.assetId, job.leaseOwner, completed);
      this.logger.info({ event: "media_asset_ready", assetId: job.assetId, attempt: job.attempt });
    } catch (error) {
      const failure = error instanceof MediaProcessingError
        ? error
        : error instanceof ApiError && error.retryable !== undefined
          ? new MediaProcessingError(error.code, error.message, error.retryable, { cause: error })
        : new MediaProcessingError("MEDIA_PROCESSING_FAILED", "The media job failed.", true, { cause: error });
      const retryDelay = failure.retryable && job.attempt <= MEDIA_RETRY_DELAYS_MS.length
        ? MEDIA_RETRY_DELAYS_MS[job.attempt - 1]
        : undefined;
      try {
        this.repository.failMediaJob(job.assetId, job.leaseOwner, {
          code: failure.code,
          message: failure.message,
        }, retryDelay);
      } catch {
        this.logger.error({ event: "media_job_lease_lost", assetId: job.assetId, attempt: job.attempt });
        return;
      }
      this.logger.error({
        event: retryDelay === undefined ? "media_asset_failed" : "media_asset_retry_scheduled",
        assetId: job.assetId,
        attempt: job.attempt,
        code: failure.code,
        ...(retryDelay === undefined ? {} : { retryDelayMs: retryDelay }),
      });
    }
  }

  private async processGarbage(job: MediaGarbageCollectionJob): Promise<void> {
    try {
      if (job.objectKeys.length > 0) {
        if (!this.storage) throw new Error("Media storage is unavailable for garbage collection.");
        await this.storage.deleteObjects(job.objectKeys);
      }
      this.repository.completeMediaGarbage(job.assetId, job.leaseOwner);
      this.storageHealthy = true;
      this.logger.info({ event: "media_orphan_deleted", assetId: job.assetId, attempt: job.attempt });
    } catch {
      this.storageHealthy = false;
      const retryDelay = MEDIA_RETRY_DELAYS_MS[Math.min(job.attempt - 1, MEDIA_RETRY_DELAYS_MS.length - 1)]
        ?? 21_600_000;
      try {
        this.repository.failMediaGarbage(job.assetId, job.leaseOwner, retryDelay);
      } catch {
        this.logger.error({ event: "media_gc_lease_lost", assetId: job.assetId, attempt: job.attempt });
        return;
      }
      this.logger.error({
        event: "media_orphan_delete_retry_scheduled",
        assetId: job.assetId,
        attempt: job.attempt,
        retryDelayMs: retryDelay,
      });
    }
  }

  private async pause(): Promise<void> {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.activeControllers.values()) controller.abort();
    if (this.activeTasks.size) await Promise.allSettled(Array.from(this.activeTasks));
  }

  private resume(): void {
    if (!this.running) return;
    this.paused = false;
    this.schedulePump(0);
  }
}
