import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import type {
  CompletedMediaAsset,
  DenicheurRepository as RepositoryType,
  MediaAdmissionPolicy,
} from "../src/repository.js";
import { DenicheurRepository } from "../src/repository.js";

const NOW = new Date("2026-07-19T10:00:00.000Z");
const SOURCE_URL = "https://img.leboncoin.fr/shared.jpg";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("media repository", () => {
  it("deduplicates assets by canonical source URL while retaining listing order", () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => NOW });
    try {
      repository.ingest({
        run: { id: "run-shared", source: "leboncoin", status: "completed" },
        listings: [
          listing("listing-a", [SOURCE_URL, "https://img.leboncoin.fr/a.jpg"]),
          listing("listing-b", [SOURCE_URL]),
        ],
      });

      expect(repository.mediaHealthCounts()).toEqual({ pending: 2, processing: 0, ready: 0, failed: 0 });
      const first = repository.getListing({ source: "leboncoin", externalId: "listing-a" });
      const second = repository.getListing({ source: "leboncoin", externalId: "listing-b" });
      expect(first?.imageAssets?.map((asset) => asset.sourceUrl)).toEqual([
        SOURCE_URL,
        "https://img.leboncoin.fr/a.jpg",
      ]);
      expect(second?.imageAssets?.[0]?.id).toBe(first?.imageAssets?.[0]?.id);
    } finally {
      repository.close();
    }
  });

  it("deduplicates URLs that differ only by a fragment before linking them", () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => NOW });
    try {
      repository.ingest({
        run: { id: "run-fragments", source: "leboncoin", status: "completed" },
        listings: [listing("listing-fragments", [
          "https://img.leboncoin.fr/fragment.jpg#first",
          "https://img.leboncoin.fr/fragment.jpg#second",
        ])],
      });

      expect(repository.mediaHealthCounts()).toEqual({ pending: 1, processing: 0, ready: 0, failed: 0 });
      expect(repository.getListing({ source: "leboncoin", externalId: "listing-fragments" })?.imageAssets)
        .toEqual([expect.objectContaining({ sourceUrl: "https://img.leboncoin.fr/fragment.jpg" })]);
    } finally {
      repository.close();
    }
  });

  it("fences an abandoned lease after startup recovery", () => {
    let currentTime = NOW;
    const repository = new DenicheurRepository({ path: ":memory:", now: () => currentTime });
    try {
      seed(repository);
      const first = repository.claimMediaJob("worker-one", 300_000);
      expect(first).toBeDefined();
      expect(repository.recoverProcessingMediaJobs()).toBe(0);
      expect(repository.claimMediaJob("worker-two", 300_000)).toBeUndefined();

      currentTime = new Date(NOW.getTime() + 300_001);
      expect(repository.recoverProcessingMediaJobs()).toBe(1);
      const second = repository.claimMediaJob("worker-two", 300_000);
      expect(second?.leaseOwner).not.toBe(first?.leaseOwner);

      expect(() => repository.completeMediaJob(first!.assetId, first!.leaseOwner, completedMedia()))
        .toThrow(/lease is no longer owned/i);
      repository.failMediaJob(second!.assetId, second!.leaseOwner, { code: "TEST", message: "terminal" });
      expect(repository.mediaHealthCounts().failed).toBe(1);
    } finally {
      repository.close();
    }
  });

  it("backfills listings when opening a database that predates migration 4", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-backfill-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const first = new DenicheurRepository({ path, now: () => NOW });
    seed(first);
    first.close();

    rewindToMigrationThree(path);

    const migrated = new DenicheurRepository({ path, now: () => NOW });
    try {
      expect(migrated.mediaHealthCounts()).toEqual({ pending: 1, processing: 0, ready: 0, failed: 0 });
      expect(migrated.getListing({ source: "leboncoin", externalId: "listing-media" })?.imageAssets)
        .toEqual([expect.objectContaining({ sourceUrl: SOURCE_URL, status: "pending" })]);
    } finally {
      migrated.close();
    }
  });

  it("rolls legacy media backfill back at the configured cap and permits no-growth replay after upgrade", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-upgrade-budget-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const sourceUrls = [
      "https://img.leboncoin.fr/legacy-a.jpg",
      "https://img.leboncoin.fr/legacy-b.jpg",
    ];
    const first = new DenicheurRepository({ path, now: () => NOW });
    first.ingest(ingestion("run-legacy", "listing-legacy", sourceUrls));
    first.close();
    rewindToMigrationThree(path);

    const error = captureApiError(() => new DenicheurRepository({
      path,
      now: () => NOW,
      mediaAdmission: mediaPolicy(1),
    }));
    expect(error).toMatchObject({ statusCode: 429, code: "MEDIA_RUN_BUDGET_EXCEEDED" });
    expect(error.message).toContain("MEDIA_MAX_ASSETS_PER_RUN=1");
    expect(mediaTopologyCounts(path)).toEqual({ assets: 0, jobs: 0, links: 0, admissions: 0 });

    const upgraded = new DenicheurRepository({
      path,
      now: () => NOW,
      mediaAdmission: mediaPolicy(2),
    });
    expect(mediaTopologyCounts(path)).toEqual({ assets: 2, jobs: 2, links: 2, admissions: 2 });
    upgraded.close();

    const grandfathered = new DenicheurRepository({
      path,
      now: () => NOW,
      mediaAdmission: mediaPolicy(1),
    });
    try {
      expect(grandfathered.ingest(ingestion("run-legacy", "listing-legacy", sourceUrls)))
        .toMatchObject({ accepted: 1 });
      expect(mediaTopologyCounts(path)).toEqual({ assets: 2, jobs: 2, links: 2, admissions: 2 });

      const growthError = captureApiError(() => grandfathered.ingest(ingestion(
        "run-legacy",
        "listing-legacy",
        [...sourceUrls, "https://img.leboncoin.fr/legacy-c.jpg"],
        new Date(NOW.getTime() + 1_000),
      )));
      expect(growthError).toMatchObject({ statusCode: 429, code: "MEDIA_RUN_BUDGET_EXCEEDED" });
      expect(mediaTopologyCounts(path)).toEqual({ assets: 2, jobs: 2, links: 2, admissions: 2 });
    } finally {
      grandfathered.close();
    }
  });

  it.each([
    {
      name: "queue",
      policy: { maxAssetsPerRun: 100, maxPendingJobs: 1, maxReservedBytes: 100, reservedBytesPerAsset: 1 },
      code: "MEDIA_QUEUE_BUDGET_EXCEEDED",
      variable: "MEDIA_MAX_PENDING_JOBS=1",
    },
    {
      name: "storage",
      policy: { maxAssetsPerRun: 100, maxPendingJobs: 100, maxReservedBytes: 1, reservedBytesPerAsset: 1 },
      code: "MEDIA_STORAGE_BUDGET_EXCEEDED",
      variable: "MEDIA_MAX_RESERVED_BYTES=1",
    },
  ])("rolls legacy media backfill back when the $name limit would be exceeded", ({ policy, code, variable }) => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-upgrade-global-budget-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const first = new DenicheurRepository({ path, now: () => NOW });
    first.ingest(ingestion("run-global-legacy", "listing-global-legacy", [
      "https://img.leboncoin.fr/global-legacy-a.jpg",
      "https://img.leboncoin.fr/global-legacy-b.jpg",
    ]));
    first.close();
    rewindToMigrationThree(path);

    const error = captureApiError(() => new DenicheurRepository({
      path,
      now: () => NOW,
      mediaAdmission: policy,
    }));

    expect(error.code).toBe(code);
    expect(error.message).toContain(variable);
    expect(mediaTopologyCounts(path)).toEqual({ assets: 0, jobs: 0, links: 0, admissions: 0 });
  });

  it("does not reuse deterministic object keys from a ready pre-generation asset", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-media-generation-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const first = new DenicheurRepository({ path, now: () => NOW });
    first.ingest(ingestion("run-generation", "listing-generation", [SOURCE_URL]));
    const firstJob = first.claimMediaJob("generation-seed-worker", 60_000);
    if (!firstJob) throw new Error("Expected the original media job.");
    const seeded = first.stageMediaJobObjects(firstJob.assetId, firstJob.leaseOwner, completedMedia());
    first.completeMediaJob(firstJob.assetId, firstJob.leaseOwner, seeded);
    first.close();

    const legacyKeys = completedMedia();
    const legacy = new DatabaseSync(path);
    legacy.prepare(`
      UPDATE media_assets SET
        original_object_key = ?, thumbnail_object_key = ?, gallery_object_key = ?,
        object_keys_json = ?
      WHERE id = ?
    `).run(
      legacyKeys.originalObjectKey,
      legacyKeys.thumbnailObjectKey,
      legacyKeys.galleryObjectKey,
      JSON.stringify([
        legacyKeys.originalObjectKey,
        legacyKeys.thumbnailObjectKey,
        legacyKeys.galleryObjectKey,
      ]),
      firstJob.assetId,
    );
    legacy.exec(`
      DROP INDEX media_assets_storage_generation_idx;
      ALTER TABLE media_assets DROP COLUMN storage_generation;
      DELETE FROM schema_migrations WHERE version = 7;
    `);
    legacy.close();

    const upgraded = new DenicheurRepository({ path, now: () => NOW });
    try {
      upgraded.ingest(ingestion(
        "run-generation",
        "listing-generation-new",
        ["https://img.leboncoin.fr/shared-generation.jpg"],
        new Date(NOW.getTime() + 1_000),
      ));
      const newJob = upgraded.claimMediaJob("generation-new-worker", 60_000);
      if (!newJob) throw new Error("Expected the new media job.");
      const staged = upgraded.stageMediaJobObjects(newJob.assetId, newJob.leaseOwner, completedMedia());

      expect([
        staged.originalObjectKey,
        staged.thumbnailObjectKey,
        staged.galleryObjectKey,
      ]).not.toEqual([
        legacyKeys.originalObjectKey,
        legacyKeys.thumbnailObjectKey,
        legacyKeys.galleryObjectKey,
      ]);
      expect(staged.originalObjectKey).toContain("/generation-");
      expect(upgraded.getMediaAsset(firstJob.assetId)).toMatchObject({ status: "ready" });
    } finally {
      upgraded.close();
    }
  });
});

function seed(repository: RepositoryType): void {
  repository.ingest({
    run: { id: "run-media", source: "leboncoin", status: "completed" },
    listings: [listing("listing-media", [SOURCE_URL])],
  });
}

function listing(externalId: string, imageUrls: string[]) {
  return {
    source: "leboncoin" as const,
    externalId,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
    imageUrl: imageUrls[0]!,
    imageUrls,
    status: "detailed" as const,
    scrapedAt: NOW.toISOString(),
  };
}

function ingestion(
  runId: string,
  externalId: string,
  imageUrls: string[],
  now = NOW,
) {
  return {
    run: { id: runId, source: "leboncoin" as const, status: "completed" as const },
    listings: [{ ...listing(externalId, imageUrls), scrapedAt: now.toISOString() }],
  };
}

function mediaPolicy(maxAssetsPerRun: number): MediaAdmissionPolicy {
  return {
    maxAssetsPerRun,
    maxPendingJobs: maxAssetsPerRun,
    maxReservedBytes: maxAssetsPerRun,
    reservedBytesPerAsset: 1,
  };
}

function rewindToMigrationThree(path: string): void {
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      DROP TABLE collected_data_cleanup_lease;
      DROP TABLE global_provider_call_reservations;
      DROP TABLE evaluation_provider_call_reservations;
      DROP TABLE evaluation_execution_budgets;
      DROP TABLE media_gc_tombstones;
      DROP TABLE run_media_admissions;
      DROP TABLE media_jobs;
      DROP TABLE listing_media;
      DROP TABLE media_assets;
      DROP INDEX IF EXISTS run_listings_run_page_idx;
      DELETE FROM schema_migrations WHERE version >= 4;
    `);
  } finally {
    legacy.close();
  }
}

function mediaTopologyCounts(path: string): {
  readonly assets: number;
  readonly jobs: number;
  readonly links: number;
  readonly admissions: number;
} {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_assets) AS assets,
        (SELECT COUNT(*) FROM media_jobs) AS jobs,
        (SELECT COUNT(*) FROM listing_media) AS links,
        (SELECT COUNT(*) FROM run_media_admissions) AS admissions
    `).get() as { assets: number; jobs: number; links: number; admissions: number };
    return row;
  } finally {
    database.close();
  }
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

function completedMedia(): CompletedMediaAsset {
  const hash = "c".repeat(64);
  return {
    contentSha256: hash,
    sourceMimeType: "image/jpeg",
    originalObjectKey: `media/${hash}/original.jpg`,
    thumbnailObjectKey: `media/${hash}/thumbnail.webp`,
    galleryObjectKey: `media/${hash}/gallery.webp`,
    originalSizeBytes: 100,
    thumbnailSizeBytes: 50,
    gallerySizeBytes: 80,
    width: 640,
    height: 480,
  };
}
