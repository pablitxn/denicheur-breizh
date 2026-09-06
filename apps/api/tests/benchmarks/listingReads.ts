// Synthetic in-memory benchmark; no provider calls or user database access.
// From the workspace root:
// node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/listingReads.ts
// Compare median/p95 on the same machine; do not treat timings as pass/fail thresholds.
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { DenicheurRepository } from "../../src/repository.js";

const repository = new DenicheurRepository({
  path: ":memory:",
  now: () => new Date("2026-09-06T10:00:00.000Z"),
  mediaAdmission: { maxAssetsPerRun: 5000, maxPendingJobs: 5000, maxReservedBytes: 1_000_000_000, reservedBytesPerAsset: 1024 },
});
try {
  const recipe = repository.saveRecipe("benchmark", {
    name: "Benchmark", threshold: 50,
    criteria: [{ id: "garden", name: "Garden", description: "Has garden", weight: 1, required: false }],
  });
  for (let offset = 0; offset < 1000; offset += 20) {
    const listings = Array.from({ length: 20 }, (_, index) => {
      const id = String(offset + index).padStart(5, "0");
      return {
        source: "leboncoin" as const, externalId: id,
        url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`,
        title: `Benchmark ${id}`, description: "Synthetic listing. ".repeat(50),
        status: "detailed" as const, scrapedAt: "2026-09-06T10:00:00.000Z",
        imageUrls: [`https://img.leboncoin.fr/shared.jpg`, `https://img.leboncoin.fr/${id}.jpg`],
      };
    });
    repository.ingest({ run: { id: "benchmark", source: "leboncoin", status: "completed" }, listings });
    repository.saveEvaluationBatch({
      runId: "benchmark", locale: "fr", recipeId: recipe.id, recipeVersion: recipe.version,
      evaluator: { provider: "openai", model: "synthetic", version: "1.0.0" },
      results: listings.map(listing => ({
        listingId: `leboncoin:${listing.externalId}`, decision: "relevant", score: 90,
        summary: "Synthetic result", criteria: [{ criterionId: "garden", verdict: "pass", reason: "Synthetic", evidence: ["garden"] }], missingData: [], evaluatedAt: "2026-09-06T10:00:00.000Z",
      })),
    });
  }
  const query = { limit: 100, sort: "updatedAt" as const, order: "desc" as const };
  let statements = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(...args) { statements += 1; return prepare.apply(this, args); };
  let page;
  try {
    page = repository.listListings(query);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
  for (let index = 0; index < 30; index++) repository.listListings(query);
  const durations: number[] = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    repository.listListings(query);
    durations.push(performance.now() - start);
  }
  durations.sort((a,b) => a-b);
  process.stdout.write(JSON.stringify({ listings: 1000, pageSize: page.items.length, statements, medianMs: durations[50], p95Ms: durations[95] }) + "\n");
} finally { repository.close(); }
