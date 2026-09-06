import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DenicheurRepository } from "../src/repository.js";
import { listingsQuerySchema, type ListingIngestion, type ListingsQuery } from "../src/contracts.js";
import { executionResult, seedExecution } from "./fixtures/evaluationExecution.js";

const NOW = "2026-09-06T10:00:00.000Z";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const query = { limit: 2, sort: "priceEuros", order: "asc" } as const;

function listing(index: number, changes: Partial<ListingIngestion> = {}): ListingIngestion {
  return {
    source: "leboncoin", externalId: String(index), url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${index}`,
    status: "detailed", scrapedAt: NOW, title: `Property ${index}`, priceEuros: index * 10,
    surfaceM2: index * 5, imageUrls: [`https://img.leboncoin.fr/${index}.jpg`], ...changes,
  };
}
function ingest(repository: DenicheurRepository, listings: ListingIngestion[], runId = "run") {
  repository.ingest({ run: { id: runId, source: "leboncoin", status: "completed" }, listings });
}
function path() {
  const directory = mkdtempSync(join(tmpdir(), "denicheur-snapshot-"));
  directories.push(directory);
  return join(directory, "snapshot.sqlite");
}

function evaluations(repository: DenicheurRepository, values: Array<{ index: number; score: number | null }>) {
  const recipe = repository.getRecipe("recipe", 1) ?? repository.saveRecipe("recipe", {
    name: "Test", threshold: 50,
    criteria: [{ id: "garden", name: "Garden", description: "Has garden", required: false, weight: 1 }],
  });
  repository.saveEvaluationBatch({
    runId: "run", recipeId: recipe.id, recipeVersion: recipe.version, locale: "fr",
    evaluator: { provider: "openai", model: "synthetic", version: "1.0.0" },
    results: values.map(({ index, score }) => ({
      listingId: `leboncoin:${index}`, decision: "relevant", score, summary: "Synthetic",
      criteria: [{ criterionId: "garden", verdict: "unknown", reason: "Missing", evidence: [] }],
      missingData: [], evaluatedAt: NOW,
    })),
  });
}

function traverse(repository: DenicheurRepository, first: ReturnType<DenicheurRepository["listListings"]>, filters: ListingsQuery) {
  const items = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = repository.listListings({ ...filters, cursor });
    expect(page.total).toBe(first.total);
    items.push(...page.items);
    cursor = page.nextCursor;
  }
  return items;
}

describe("immutable pagination snapshots", () => {
  it.each((["priceEuros", "updatedAt", "scrapedAt", "title", "surfaceM2", "score", "source"] as const)
    .flatMap((sort) => (["asc", "desc"] as const).map((order) => ({ sort, order }))))
  ("freezes $sort $order order, membership and related payloads across writes from a second connection", ({ sort, order }) => {
    let now = new Date(NOW);
    const databasePath = path();
    const reader = new DenicheurRepository({ path: databasePath, now: () => now });
    const writer = new DenicheurRepository({ path: databasePath, now: () => now });
    try {
      ingest(writer, [1, 2, 3, 4, 5].map((index) => listing(index)));
      evaluations(writer, [{ index: 1, score: 0 }, { index: 2, score: null }, { index: 3, score: 50 }]);
      const filters = { ...query, sort, order, priceMin: 10, priceMax: 50 };
      const expected = reader.listListings({ ...filters, limit: 100 }).items;
      const first = reader.listListings(filters);
      now = new Date("2026-09-06T10:01:00.000Z");
      ingest(writer, [
        listing(1, { priceEuros: 1000, title: "Z", scrapedAt: now.toISOString() }),
        listing(3, { priceEuros: 0, title: "A", scrapedAt: now.toISOString() }),
        listing(6, { priceEuros: 20, scrapedAt: now.toISOString() }),
      ]);
      evaluations(writer, [{ index: 3, score: 99 }]);
      const job = writer.claimMediaJob("worker", 60_000)!;
      writer.failMediaJob(job.assetId, job.leaseOwner, { code: "SYNTHETIC", message: "failed after snapshot" });

      expect(traverse(reader, first, filters)).toEqual(expected);
      expect(reader.listListings({ ...filters, limit: 100 }).items).not.toEqual(expected);
    } finally { writer.close(); reader.close(); }
  });

  it("continues an immutable snapshot after repository restart", () => {
    const databasePath = path();
    const first = new DenicheurRepository({ path: databasePath });
    ingest(first, [1, 2, 3].map((index) => listing(index)));
    const page = first.listListings(query);
    first.close();
    const reopened = new DenicheurRepository({ path: databasePath });
    try {
      ingest(reopened, [listing(0)]);
      expect(reopened.listListings({ ...query, cursor: page.nextCursor! }).items.map((item) => item.externalId)).toEqual(["3"]);
    } finally { reopened.close(); }
  });

  it("freezes run status filters and run payloads while new runs arrive", () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => new Date(NOW) });
    try {
      for (const id of ["a", "b", "c"]) ingest(repository, [], id);
      const expected = repository.listRuns({ limit: 100, order: "desc", status: "completed" });
      const first = repository.listRuns({ limit: 1, order: "desc", status: "completed" });
      repository.ingest({ run: { id: "b", source: "leboncoin", status: "failed" }, listings: [] });
      ingest(repository, [], "aa");
      const second = repository.listRuns({ limit: 100, order: "desc", status: "completed", cursor: first.nextCursor! });
      expect([...first.items, ...second.items]).toEqual(expected.items);
      expect(second.total).toBe(3);
    } finally { repository.close(); }
  });

  it("reuses matching revisions but rejects incompatible, expired and legacy cursors explicitly", () => {
    let now = new Date(NOW);
    const repository = new DenicheurRepository({ path: ":memory:", now: () => now, paginationSnapshots: { ttlMs: 1000 } });
    try {
      ingest(repository, [1, 2, 3].map((index) => listing(index)));
      const first = repository.listListings(query);
      expect(repository.listListings(query)).toEqual(first);
      expect(() => repository.listListings({ ...query, order: "desc", cursor: first.nextCursor! }))
        .toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
      expect(() => repository.listListings({ ...query, cursor: Buffer.from('{"offset":2}').toString("base64url") }))
        .toThrowError(expect.objectContaining({ statusCode: 410, code: "PAGINATION_CURSOR_RESTART_REQUIRED" }));
      expect(() => repository.listListings({ ...query, cursor: "not-json" }))
        .toThrowError(expect.objectContaining({ statusCode: 400 }));
      now = new Date(now.getTime() + 1001);
      expect(() => repository.listListings({ ...query, cursor: first.nextCursor! }))
        .toThrowError(expect.objectContaining({ statusCode: 410, code: "PAGINATION_CURSOR_EXPIRED" }));
      expect(repository.listListings(query).nextCursor).not.toBe(first.nextCursor);
    } finally { repository.close(); }
  });

  it("shares immutable listing versions between revisions and filters, then collects expired references", () => {
    let now = new Date(NOW);
    const databasePath = path();
    const repository = new DenicheurRepository({ path: databasePath, now: () => now, paginationSnapshots: { ttlMs: 1000 } });
    const inspection = new DatabaseSync(databasePath);
    const cachedCount = () => inspection.prepare("SELECT COUNT(*) AS count FROM listing_projection_payloads").get()?.count;
    try {
      ingest(repository, [1, 2, 3].map((index) => listing(index)));
      repository.listListings(query);
      repository.listListings({ ...query, order: "desc" });
      expect(cachedCount()).toBe(3);
      ingest(repository, [listing(1, { title: "Changed" })]);
      repository.listListings(query);
      expect(cachedCount()).toBe(4);
      const sums = inspection.prepare("SELECT (SELECT SUM(size_bytes) FROM listing_projection_payloads) AS actual, (SELECT bytes FROM projection_cache_usage) AS tracked").get();
      expect(sums?.actual).toBe(sums?.tracked);
      now = new Date(now.getTime() + 1001);
      repository.listListings(query);
      expect(cachedCount()).toBe(3);
      repository.clearCollectedData();
      expect(cachedCount()).toBe(0);
      expect(inspection.prepare("SELECT bytes FROM projection_cache_usage").get()?.bytes).toBe(0);
    } finally { inspection.close(); repository.close(); }
  });

  it("freezes execution filters, counters and budgets across claims, completions and new executions", () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => new Date(NOW) });
    try {
      for (const id of ["a", "b", "c"]) seedExecution(repository, 1, id);
      const filters = { limit: 1, order: "asc", status: "queued", runId: "run" } as const;
      const expected = repository.listEvaluationExecutions({ ...filters, limit: 100 });
      const first = repository.listEvaluationExecutions(filters);
      repository.claimNextEvaluationExecution("worker-a", 60_000);
      repository.claimNextEvaluationExecution("worker-b", 60_000);
      repository.reserveEvaluationProviderCall("b", "worker-b", { providerCalls: 1, inputTokens: 100, outputTokens: 10, costMicroUsd: 1 });
      repository.completeEvaluationExecutionItem("worker-b", executionResult(0, "relevant", false, "b"));
      repository.finishEvaluationExecution("b", "worker-b");
      seedExecution(repository, 1, "aa");
      const rest = repository.listEvaluationExecutions({ ...filters, limit: 100, cursor: first.nextCursor! });
      expect([...first.items, ...rest.items]).toEqual(expected.items);
      expect(rest.total).toBe(3);
      expect(repository.listEvaluationExecutions({ ...filters, limit: 100 }).items.map((execution) => execution.id)).toEqual(["aa", "c"]);
    } finally { repository.close(); }
  });

  it("bounds retained snapshots with LRU eviction and rolls oversized snapshot creation back", () => {
    const databasePath = path();
    const repository = new DenicheurRepository({ path: databasePath, paginationSnapshots: { maxSnapshots: 1, maxSnapshotRows: 3 } });
    try {
      ingest(repository, [1, 2, 3].map((index) => listing(index)));
      const first = repository.listListings(query);
      const other = repository.listListings({ ...query, order: "desc" });
      expect(() => repository.listListings({ ...query, cursor: first.nextCursor! }))
        .toThrowError(expect.objectContaining({ code: "PAGINATION_CURSOR_EXPIRED" }));
      ingest(repository, [listing(4)]);
      expect(() => repository.listListings(query)).toThrowError(expect.objectContaining({ code: "PAGINATION_SNAPSHOT_TOO_LARGE" }));
      expect(repository.listListings({ ...query, order: "desc", cursor: other.nextCursor! }).items).toHaveLength(1);
      const inspection = new DatabaseSync(databasePath);
      try { expect(inspection.prepare("SELECT COUNT(*) AS count FROM pagination_snapshots").get()?.count).toBe(1); }
      finally { inspection.close(); }
      repository.clearCollectedData();
      expect(() => repository.listListings({ ...query, order: "desc", cursor: other.nextCursor! }))
        .toThrowError(expect.objectContaining({ code: "PAGINATION_CURSOR_EXPIRED" }));
    } finally { repository.close(); }
  });
});

describe("server sort and compact catalog reads", () => {
  it.each(["priceEuros", "surfaceM2", "score", "title"] as const)("keeps missing %s last in both directions and preserves zero", (sort) => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      const absent = listing(3);
      delete absent.priceEuros;
      delete absent.surfaceM2;
      delete absent.title;
      ingest(repository, [listing(1, { priceEuros: 0, surfaceM2: 0 }), listing(2), absent]);
      evaluations(repository, [{ index: 1, score: 0 }, { index: 2, score: 90 }, { index: 3, score: null }]);
      expect(repository.listListings({ limit: 100, sort, order: "asc" }).items.map((item) => item.externalId)).toEqual(["1", "2", "3"]);
      expect(repository.listListings({ limit: 100, sort, order: "desc" }).items.map((item) => item.externalId)).toEqual(["2", "1", "3"]);
    } finally { repository.close(); }
  });

  it("normalizes repeated source filters and rejects mixing single and multiple sources", () => {
    expect(listingsQuerySchema.parse({ sources: ["leboncoin", "leboncoin"] }).sources).toEqual(["leboncoin"]);
    expect(listingsQuerySchema.parse({ sources: "leboncoin" }).sources).toEqual(["leboncoin"]);
    expect(listingsQuerySchema.safeParse({ source: "leboncoin", sources: "leboncoin" }).success).toBe(false);
  });

  it("returns global facets and conditional map summaries with frozen related values and page-specific ETags", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      ingest(repository, [1, 2, 3].map((index) => listing(index, { description: "Long text", features: ["Garden"] })));
      evaluations(repository, [{ index: 3, score: null }]);
      const metadata = repository.listingsMetadata();
      expect(metadata.metadata).toMatchObject({ total: 3, sources: [{ source: "leboncoin", count: 3 }] });
      expect(repository.listingsMetadata(metadata.etag)).toEqual({ etag: metadata.etag });
      const first = repository.listMapListings({ limit: 2 });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(repository.listMapListings({ limit: 2 }, first.etag)).toEqual({ etag: first.etag });
      expect(prepare.mock.calls.flatMap(([sql]) => sql).join("\n")).not.toContain("FROM listings l");
      prepare.mockRestore();
      expect(first.page?.items[0]?.coverAsset?.sourceUrl).toBe("https://img.leboncoin.fr/1.jpg");
      expect(first.page?.items[0]).not.toHaveProperty("description");
      expect(first.page?.items[0]).not.toHaveProperty("features");
      evaluations(repository, [{ index: 3, score: 50 }]);
      const second = repository.listMapListings({ limit: 2, cursor: first.page!.nextCursor! }, first.etag);
      expect(second.page?.items[0]?.evaluation?.score).toBeNull();
      expect(second.etag).not.toBe(first.etag);
      expect(repository.listMapListings({ limit: 2 }, first.etag).page).toBeDefined();
      expect(repository.listingsMetadata(metadata.etag).metadata?.revision).not.toBe(metadata.metadata?.revision);
    } finally { repository.close(); }
  });
});
