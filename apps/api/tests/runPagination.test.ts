import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { IngestionRequest } from "../src/contracts.js";
import { DenicheurRepository } from "../src/repository.js";

describe("run listing pagination", () => {
  it("returns a bounded summary and cursor-pages snapshots without materializing the full run", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      for (let offset = 0; offset < 125; offset += 20) {
        repository.ingest(batch(offset, Math.min(20, 125 - offset)));
      }

      const summary = repository.getRun("run-large");
      const first = repository.listRunListings("run-large", { limit: 100 });
      const second = repository.listRunListings("run-large", {
        cursor: first?.nextCursor ?? undefined,
        limit: 100,
      });

      expect(summary).toMatchObject({ listingCount: 125, detailedListingCount: 125 });
      expect(summary).not.toHaveProperty("listings");
      expect(first).toMatchObject({ total: 125 });
      expect(first?.items).toHaveLength(100);
      expect(first?.nextCursor).toEqual(expect.any(String));
      expect(first?.items[0]).not.toHaveProperty("imageAssets");
      expect(first?.items[0]).not.toHaveProperty("latestEvaluation");
      expect(second).toMatchObject({ total: 125, nextCursor: null });
      expect(second?.items).toHaveLength(25);
      expect(new Set([...first!.items, ...second!.items].map((listing) => listing.id)).size).toBe(125);
    } finally {
      repository.close();
    }
  });

  it("does not duplicate prior-page snapshots when a newer observation arrives", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      for (let index = 0; index < 3; index += 1) {
        repository.ingest(singleListingBatch(index));
      }
      const first = repository.listRunListings("run-live", { limit: 2 });
      if (!first?.nextCursor) throw new Error("Expected the first page to have a cursor.");

      repository.ingest(singleListingBatch(3));
      const second = repository.listRunListings("run-live", { cursor: first.nextCursor, limit: 2 });

      expect(first.items.map((listing) => listing.externalId)).toEqual(["listing-2", "listing-1"]);
      expect(second?.items.map((listing) => listing.externalId)).toEqual(["listing-0"]);
      expect(second?.nextCursor).toBeNull();
    } finally {
      repository.close();
    }
  });

  it("installs the composite index used by the run-listing order", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-run-pagination-"));
    const path = join(directory, "denicheur.sqlite");
    const repository = new DenicheurRepository({ path });
    repository.close();
    const database = new DatabaseSync(path);
    try {
      const columns = database.prepare("PRAGMA index_info(run_listings_run_page_idx)")
        .all().map((row) => row.name);
      expect(columns).toEqual(["run_id", "observed_at", "source", "external_id"]);
      const plan = database.prepare(`
        EXPLAIN QUERY PLAN
        SELECT * FROM run_listings
        WHERE run_id = ? AND (
          observed_at < ?
          OR (observed_at = ? AND source > ?)
          OR (observed_at = ? AND source = ? AND external_id > ?)
        )
        ORDER BY observed_at DESC, source ASC, external_id ASC
        LIMIT ?
      `).all(
        "run-large",
        "2026-08-11T10:00:00.000Z",
        "2026-08-11T10:00:00.000Z",
        "leboncoin",
        "2026-08-11T10:00:00.000Z",
        "leboncoin",
        "listing-100",
        101,
      ) as Array<{ detail: string }>;
      expect(plan.map((step) => step.detail).join("\n"))
        .toContain("USING INDEX run_listings_run_page_idx");
      expect(plan.map((step) => step.detail).join("\n"))
        .not.toContain("USE TEMP B-TREE");
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function batch(offset: number, count: number): IngestionRequest {
  const scrapedAt = new Date(Date.UTC(2026, 7, 11, 10, 0, offset)).toISOString();
  return {
    run: { id: "run-large", source: "leboncoin", status: "completed" },
    listings: Array.from({ length: count }, (_, index) => {
      const listingNumber = offset + index;
      return {
        source: "leboncoin" as const,
        externalId: `listing-${listingNumber}`,
        url: `https://www.leboncoin.fr/ad/ventes_immobilieres/listing-${listingNumber}`,
        title: `Listing ${listingNumber}`,
        status: "detailed" as const,
        scrapedAt,
      };
    }),
  };
}

function singleListingBatch(index: number): IngestionRequest {
  return {
    run: { id: "run-live", source: "leboncoin", status: "collecting-search" },
    listings: [{
      source: "leboncoin",
      externalId: `listing-${index}`,
      url: `https://www.leboncoin.fr/ad/ventes_immobilieres/listing-${index}`,
      status: "listing",
      scrapedAt: new Date(Date.UTC(2026, 7, 11, 10, 0, index)).toISOString(),
    }],
  };
}
