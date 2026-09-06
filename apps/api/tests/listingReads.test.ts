import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { MAX_LISTING_IMAGE_URLS, type FilterListingsResponse, type ListingIngestion } from "../src/contracts.js";
import { DenicheurRepository } from "../src/repository.js";

const NOW = "2026-09-06T10:00:00.000Z";
const PAGE_QUERY = { limit: 100, sort: "updatedAt", order: "desc" } as const;
const RECIPE = {
  name: "Garden",
  threshold: 50,
  criteria: [{ id: "garden", name: "Garden", description: "Has a garden", weight: 1, required: false }],
};

describe("listing page reads", () => {
  it("hydrates a full page and maximum galleries with bounded SQL calls and preserves detail data", () => {
    const repository = new DenicheurRepository({
      path: ":memory:",
      now: () => new Date(NOW),
      mediaAdmission: {
        maxAssetsPerRun: 6_000,
        maxPendingJobs: 6_000,
        maxReservedBytes: 10_000_000,
        reservedBytesPerAsset: 1_024,
      },
    });
    try {
      repository.saveRecipe("recipe-a", RECIPE);
      for (let offset = 0; offset < 101; offset += 20) {
        const listings = Array.from({ length: Math.min(20, 101 - offset) }, (_, index) => {
          const item = listing(String(offset + index).padStart(3, "0"));
          return {
            ...item,
            ...(offset + index === 1 ? {} : {
              imageUrls: [
                "https://img.leboncoin.fr/shared.jpg#cover",
                ...Array.from({ length: MAX_LISTING_IMAGE_URLS - 1 }, (_, imageIndex) =>
                  `https://img.leboncoin.fr/${item.externalId}-${imageIndex}.jpg`),
              ],
            }),
          };
        });
        repository.ingest({ run: { id: "run-a", source: "leboncoin", status: "completed" }, listings });
        for (const item of listings.filter((_, index) => index % 2 === 0)) {
          saveEvaluation(repository, item.externalId);
        }
      }
      const job = repository.claimMediaJob("test-worker", 60_000);
      if (!job) throw new Error("Expected a queued media job.");
      repository.failMediaJob(job.assetId, job.leaseOwner, { code: "TEST", message: "Synthetic failure" });

      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      let page;
      try {
        page = repository.listListings(PAGE_QUERY);
        // Snapshot admission has a fixed query cost; related payloads must not add per-listing reads.
        expect(prepare.mock.calls.length).toBeLessThanOrEqual(14);
      } finally {
        prepare.mockRestore();
      }

      expect(page).toMatchObject({ total: 101, nextCursor: expect.any(String) });
      expect(page.items).toHaveLength(100);
      for (const item of page.items) {
        const detail = repository.getListing({ source: item.source, externalId: item.externalId });
        if (!detail) throw new Error("Expected the page listing to exist.");
        const { runs, evaluations, ...detailRecord } = detail;
        expect(runs).toHaveLength(1);
        expect(evaluations).toHaveLength(item.latestEvaluation ? 1 : 0);
        expect(item).toEqual(detailRecord);
      }
      expect(page.items[0]?.imageAssets).toHaveLength(MAX_LISTING_IMAGE_URLS);
      expect(page.items[0]?.imageAssets?.[0]?.sourceUrl).toBe("https://img.leboncoin.fr/shared.jpg");
      expect(page.items[0]?.imageAssets?.[0]?.id).toBe(page.items[2]?.imageAssets?.[0]?.id);
      expect(page.items[1]?.imageAssets).toEqual([]);
      expect(page.items[1]).not.toHaveProperty("latestEvaluation");
      expect(repository.listListings({ ...PAGE_QUERY, cursor: page.nextCursor! }).items)
        .toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it.each([
    ["timestamp", { runId: "run-a", evaluatedAt: "2026-09-06T11:00:00.000Z" }, { runId: "run-z" }],
    ["run", { runId: "run-z" }, { runId: "run-a" }],
    ["recipe", { recipeId: "recipe-a" }, { recipeId: "recipe-z" }],
    ["recipe version", { recipeVersion: 2 }, { recipeVersion: 1 }],
    ["locale", { locale: "en" }, { locale: "fr" }],
  ] satisfies Array<[string, EvaluationOptions, EvaluationOptions]>)
  ("uses the same latest %s in detail, listing cards, and decision filters", (_, winner, other) => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => new Date(NOW) });
    try {
      repository.saveRecipe("recipe-a", RECIPE);
      repository.saveRecipe("recipe-a", RECIPE);
      repository.saveRecipe("recipe-z", RECIPE);
      for (const runId of ["run-a", "run-z"]) {
        repository.ingest({ run: { id: runId, source: "leboncoin", status: "completed" }, listings: [listing("tie")] });
      }
      saveEvaluation(repository, "tie", { ...winner, decision: "relevant" });
      saveEvaluation(repository, "tie", { ...other, decision: "not-relevant" });

      const detail = repository.getListing({ source: "leboncoin", externalId: "tie" });
      const relevant = repository.listListings({ ...PAGE_QUERY, decision: "relevant" });
      const excluded = repository.listListings({ ...PAGE_QUERY, decision: "not-relevant" });
      expect(detail?.latestEvaluation).toMatchObject({ ...winner, decision: "relevant" });
      expect(relevant.total).toBe(1);
      expect(relevant.items[0]?.latestEvaluation).toEqual(detail?.latestEvaluation);
      expect(excluded).toEqual({ total: 0, items: [], nextCursor: null });
    } finally {
      repository.close();
    }
  });

  it("returns empty pages without related-data lookups", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      expect(repository.listListings(PAGE_QUERY)).toEqual({ total: 0, items: [], nextCursor: null });
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(7);
    } finally {
      prepare.mockRestore();
      repository.close();
    }
  });
});

type EvaluationOptions = Partial<Pick<FilterListingsResponse, "runId" | "locale" | "recipeId" | "recipeVersion">> & {
  decision?: "relevant" | "not-relevant";
  evaluatedAt?: string;
};

function listing(externalId: string): ListingIngestion {
  return {
    source: "leboncoin", externalId,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
    status: "detailed", scrapedAt: NOW,
  };
}

function saveEvaluation(repository: DenicheurRepository, externalId: string, options: EvaluationOptions = {}): void {
  repository.saveEvaluationBatch({
    runId: options.runId ?? "run-a", locale: options.locale ?? "fr",
    recipeId: options.recipeId ?? "recipe-a", recipeVersion: options.recipeVersion ?? 1,
    evaluator: { provider: "openai", model: "synthetic", version: "1.0.0" },
    results: [{
      listingId: `leboncoin:${externalId}`, decision: options.decision ?? "relevant", score: 90,
      summary: "Synthetic result",
      criteria: [{ criterionId: "garden", verdict: "pass", reason: "Synthetic", evidence: ["garden"] }],
      missingData: [], evaluatedAt: options.evaluatedAt ?? NOW,
    }],
  });
}
