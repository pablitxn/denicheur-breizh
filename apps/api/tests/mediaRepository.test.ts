import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { CompletedMediaAsset, DenicheurRepository as RepositoryType } from "../src/repository.js";
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
    const repository = new DenicheurRepository({ path: ":memory:", now: () => NOW });
    try {
      seed(repository);
      const first = repository.claimMediaJob("worker-one", 300_000);
      expect(first).toBeDefined();
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

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE media_jobs;
      DROP TABLE listing_media;
      DROP TABLE media_assets;
      DELETE FROM schema_migrations WHERE version = 4;
    `);
    legacy.close();

    const migrated = new DenicheurRepository({ path, now: () => NOW });
    try {
      expect(migrated.mediaHealthCounts()).toEqual({ pending: 1, processing: 0, ready: 0, failed: 0 });
      expect(migrated.getListing({ source: "leboncoin", externalId: "listing-media" })?.imageAssets)
        .toEqual([expect.objectContaining({ sourceUrl: SOURCE_URL, status: "pending" })]);
    } finally {
      migrated.close();
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
