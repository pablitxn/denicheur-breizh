import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { IngestionRequest } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import {
  DenicheurRepository,
  type CompletedMediaAsset,
  type MediaAdmissionPolicy,
} from "../src/repository.js";

const NOW = "2026-08-11T10:00:00.000Z";

describe("media admission budgets", () => {
  it("keeps the distinct-asset budget durable for a run after orphan GC", () => {
    const repository = createRepository({
      maxAssetsPerRun: 51,
      maxPendingJobs: 500,
      maxReservedBytes: 10_000,
      reservedBytesPerAsset: 1,
    });
    try {
      repository.ingest(ingestion("run-1", "listing-1", ["https://img.leboncoin.fr/original.jpg"]));
      const originalAsset = repository.getListing({ source: "leboncoin", externalId: "listing-1" })
        ?.imageAssets?.[0];
      expect(originalAsset).toBeDefined();

      const replacement = imageUrls("replacement", 50);
      repository.ingest(ingestion("run-1", "listing-1", replacement, "2026-08-11T10:01:00.000Z"));
      expect(repository.getMediaAsset(originalAsset!.id)).toBeUndefined();

      const garbage = repository.claimMediaGarbage("gc-worker");
      expect(garbage).toMatchObject({ assetId: originalAsset!.id, objectKeys: [] });
      repository.completeMediaGarbage(garbage!.assetId, garbage!.leaseOwner);

      const error = captureApiError(() => repository.ingest(
        ingestion("run-1", "listing-1", imageUrls("churn", 50), "2026-08-11T10:02:00.000Z"),
      ));

      expect(error).toMatchObject({ statusCode: 429, code: "MEDIA_RUN_BUDGET_EXCEEDED" });
      expect(repository.listRunListings("run-1", { limit: 20 })?.items[0]?.imageUrls).toEqual(replacement);
    } finally {
      repository.close();
    }
  });

  it("rejects global queue growth transactionally before creating a run or job", () => {
    const repository = createRepository({
      maxAssetsPerRun: 100,
      maxPendingJobs: 1,
      maxReservedBytes: 10_000,
      reservedBytesPerAsset: 1,
    });
    try {
      repository.ingest(ingestion("run-1", "listing-1", ["https://img.leboncoin.fr/a.jpg"]));

      const error = captureApiError(() => repository.ingest(
        ingestion("run-2", "listing-2", ["https://img.leboncoin.fr/b.jpg"]),
      ));

      expect(error).toMatchObject({ statusCode: 429, code: "MEDIA_QUEUE_BUDGET_EXCEEDED" });
      expect(repository.getRun("run-2")).toBeUndefined();
      expect(repository.mediaHealthCounts()).toMatchObject({ pending: 1, processing: 0 });
    } finally {
      repository.close();
    }
  });

  it("counts orphaned objects against the byte budget until GC commits their deletion", () => {
    const repository = createRepository({
      maxAssetsPerRun: 100,
      maxPendingJobs: 100,
      maxReservedBytes: 510,
      reservedBytesPerAsset: 10,
    });
    try {
      repository.ingest(ingestion("run-1", "listing-1", ["https://img.leboncoin.fr/a.jpg"]));
      const originalAsset = repository.getListing({ source: "leboncoin", externalId: "listing-1" })
        ?.imageAssets?.[0];
      expect(originalAsset).toBeDefined();
      repository.ingest(ingestion(
        "run-1",
        "listing-1",
        imageUrls("replacement", 50),
        "2026-08-11T10:01:00.000Z",
      ));
      expect(repository.getMediaAsset(originalAsset!.id)).toBeUndefined();

      const error = captureApiError(() => repository.ingest(
        ingestion("run-2", "listing-2", ["https://img.leboncoin.fr/new.jpg"]),
      ));

      expect(error).toMatchObject({ statusCode: 507, code: "MEDIA_STORAGE_BUDGET_EXCEEDED" });
      expect(repository.getRun("run-2")).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it("projects tombstones created by a media relink before committing the ingestion", () => {
    const repository = createRepository({
      maxAssetsPerRun: 100,
      maxPendingJobs: 1,
      maxReservedBytes: 10_000,
      reservedBytesPerAsset: 1,
    });
    try {
      const oldUrls = imageUrls("old", 2);
      const replacementUrls = imageUrls("replacement", 50);
      let completedAssets = 0;

      for (const sourceUrl of oldUrls) {
        repository.ingest(ingestion(
          "run-queue",
          "listing-old",
          [sourceUrl],
          timestamp(completedAssets),
        ));
        completeNextMediaJob(repository, completedAssets);
        completedAssets += 1;
      }
      for (const sourceUrl of replacementUrls) {
        repository.ingest(ingestion(
          "run-queue",
          "listing-replacements",
          [sourceUrl],
          timestamp(completedAssets),
        ));
        completeNextMediaJob(repository, completedAssets);
        completedAssets += 1;
      }

      const error = captureApiError(() => repository.ingest(ingestion(
        "run-queue",
        "listing-old",
        replacementUrls,
        timestamp(completedAssets),
      )));

      expect(error).toMatchObject({ statusCode: 429, code: "MEDIA_QUEUE_BUDGET_EXCEEDED" });
      expect(repository.getListing({ source: "leboncoin", externalId: "listing-old" })?.imageUrls)
        .toEqual([...oldUrls].reverse());
    } finally {
      repository.close();
    }
  });

  it("rejects actual staged bytes that would exceed the global storage cap", () => {
    const repository = createRepository({
      maxAssetsPerRun: 100,
      maxPendingJobs: 100,
      maxReservedBytes: 100,
      reservedBytesPerAsset: 10,
    });
    try {
      repository.ingest(ingestion("run-bytes", "listing-bytes", ["https://img.leboncoin.fr/bytes.jpg"]));
      const job = repository.claimMediaJob("bytes-worker", 60_000);
      if (!job) throw new Error("Expected the media job to be claimable.");

      const error = captureApiError(() => repository.stageMediaJobObjects(job.assetId, job.leaseOwner, {
        ...completedMedia(999),
        originalSizeBytes: 90,
        thumbnailSizeBytes: 60,
        gallerySizeBytes: 50,
      }));

      expect(error).toMatchObject({ statusCode: 507, code: "MEDIA_STORAGE_BUDGET_EXCEEDED" });
      expect(repository.getMediaAsset(job.assetId)).toMatchObject({ status: "processing" });
    } finally {
      repository.close();
    }
  });

  it("does not let completion replace the metadata that passed staged-byte admission", () => {
    const repository = createRepository({
      maxAssetsPerRun: 100,
      maxPendingJobs: 100,
      maxReservedBytes: 100,
      reservedBytesPerAsset: 10,
    });
    try {
      repository.ingest(ingestion("run-complete", "listing-complete", [
        "https://img.leboncoin.fr/complete.jpg",
      ]));
      const job = repository.claimMediaJob("complete-worker", 60_000);
      if (!job) throw new Error("Expected the media job to be claimable.");
      const staged = repository.stageMediaJobObjects(
        job.assetId,
        job.leaseOwner,
        completedMedia(1_000),
      );

      const error = captureApiError(() => repository.completeMediaJob(job.assetId, job.leaseOwner, {
        ...staged,
        originalSizeBytes: 99,
      }));

      expect(error).toMatchObject({
        statusCode: 409,
        code: "MEDIA_STAGED_OBJECT_MISMATCH",
        retryable: false,
      });
      expect(repository.getMediaAsset(job.assetId)).toMatchObject({
        status: "processing",
        thumbnailSizeBytes: 1,
        gallerySizeBytes: 1,
      });
    } finally {
      repository.close();
    }
  });

  it("allows staged bytes that reduce an already grandfathered storage overage", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-stage-grandfather-"));
    const path = join(directory, "denicheur.sqlite");
    const initial = new DenicheurRepository({
      path,
      mediaAdmission: {
        maxAssetsPerRun: 100,
        maxPendingJobs: 100,
        maxReservedBytes: 100,
        reservedBytesPerAsset: 10,
      },
    });
    initial.ingest(ingestion("run-grandfather", "listing-grandfather", [
      "https://img.leboncoin.fr/grandfather-a.jpg",
      "https://img.leboncoin.fr/grandfather-b.jpg",
    ]));
    initial.close();

    const grandfathered = new DenicheurRepository({
      path,
      mediaAdmission: {
        maxAssetsPerRun: 100,
        maxPendingJobs: 100,
        maxReservedBytes: 15,
        reservedBytesPerAsset: 10,
      },
    });
    try {
      const job = grandfathered.claimMediaJob("grandfather-stage-worker", 60_000);
      if (!job) throw new Error("Expected a grandfathered media job.");
      const staged = grandfathered.stageMediaJobObjects(job.assetId, job.leaseOwner, {
        ...completedMedia(2_000),
        originalSizeBytes: 3,
        thumbnailSizeBytes: 3,
        gallerySizeBytes: 3,
      });

      expect(staged.originalSizeBytes + staged.thumbnailSizeBytes + staged.gallerySizeBytes).toBe(9);
      expect(grandfathered.getMediaAsset(job.assetId)).toMatchObject({ status: "processing" });
    } finally {
      grandfathered.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function createRepository(mediaAdmission: MediaAdmissionPolicy): DenicheurRepository {
  return new DenicheurRepository({ path: ":memory:", mediaAdmission });
}

function ingestion(
  runId: string,
  externalId: string,
  urls: readonly string[],
  scrapedAt = NOW,
): IngestionRequest {
  return {
    run: { id: runId, source: "leboncoin", status: "completed" },
    listings: [{
      source: "leboncoin",
      externalId,
      url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
      imageUrl: urls[0],
      imageUrls: [...urls],
      status: "detailed",
      scrapedAt,
    }],
  };
}

function imageUrls(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://img.leboncoin.fr/${prefix}-${index}.jpg`);
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1_000).toISOString();
}

function completeNextMediaJob(repository: DenicheurRepository, index: number): void {
  const job = repository.claimMediaJob("admission-test-worker", 60_000);
  if (!job) throw new Error("Expected the next media job to be claimable.");
  const completed = repository.stageMediaJobObjects(
    job.assetId,
    job.leaseOwner,
    completedMedia(index),
  );
  repository.completeMediaJob(job.assetId, job.leaseOwner, completed);
}

function completedMedia(index: number): CompletedMediaAsset {
  const contentSha256 = index.toString(16).padStart(64, "0");
  const prefix = `media/test/${contentSha256}`;
  return {
    contentSha256,
    sourceMimeType: "image/jpeg",
    originalObjectKey: `${prefix}/original.jpg`,
    thumbnailObjectKey: `${prefix}/thumbnail.webp`,
    galleryObjectKey: `${prefix}/gallery.webp`,
    originalSizeBytes: 1,
    thumbnailSizeBytes: 1,
    gallerySizeBytes: 1,
    width: 100,
    height: 100,
  };
}

function captureApiError(action: () => unknown): ApiError {
  try {
    action();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected an ApiError.");
}
