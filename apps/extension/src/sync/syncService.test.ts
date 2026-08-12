import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultIntelligenceRecipe } from "../intelligence/recipe";
import { createDefaultSearchFilters } from "../lib/leboncoinSearch";
import type { ScrapedPropertyRecord, StoredCrawlerState } from "../lib/types";
import {
  CRAWLER_STORAGE_KEYS,
  IDLE_RUN,
  loadCrawlerState,
  loadEvaluationPlan,
} from "../storage/chromeStorage";
import { loadExtensionSyncState } from "./storage";
import {
  buildQueueEntries,
  enqueueDefaultPlanEvaluation,
  flushEvaluationQueue,
  flushQueuedIngestion,
  reconcileCrawlerSnapshot,
  reconcileStoredCrawlerState,
  refreshActiveRecipeCache,
  refreshDefaultPlanCache,
} from "./syncService";

const NOW = new Date("2026-07-18T10:00:00.000Z");
let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get(keys: string[], callback: (values: Record<string, unknown>) => void) {
            callback(Object.fromEntries(keys.map((key) => [key, storage[key]])));
          },
          set(patch: Record<string, unknown>, callback: () => void) {
            Object.assign(storage, patch);
            callback();
          },
          remove(keys: string[], callback: () => void) {
            for (const key of keys) delete storage[key];
            callback();
          },
        },
      },
    } as unknown as typeof chrome,
  });
});

describe("extension API synchronization", () => {
  it("imports existing records by run and marks missing run metadata as legacy", () => {
    const entries = buildQueueEntries(crawlerState({
      run: IDLE_RUN,
      records: [record("3007106066", "old-run")],
    }), NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0].payload.run).toMatchObject({
      id: "old-run",
      source: "leboncoin",
      status: "legacy-import",
      collected: 1,
    });
    expect(entries[0].payload.listings).toEqual([
      expect.objectContaining({
        externalId: "3007106066",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066?from=extension",
      }),
    ]);
  });

  it("creates idempotent ingestion batches of at most twenty listings", () => {
    const records = Array.from({ length: 41 }, (_, index) => record(String(3007106000 + index), "run-1"));
    const entries = buildQueueEntries(crawlerState({
      run: { ...IDLE_RUN, id: "run-1", status: "completed", collected: 41 },
      records,
    }), NOW);

    expect(entries.map((entry) => entry.payload.listings.length)).toEqual([20, 20, 1]);
    expect(entries.every((entry) => entry.runId === "run-1")).toBe(true);
  });

  it("deduplicates a repeated listing identity before batching", () => {
    const first = record("3007106066", "run-1");
    const entries = buildQueueEntries(crawlerState({
      run: { ...IDLE_RUN, id: "run-1", status: "completed", collected: 1 },
      records: [
        first,
        { ...first, title: "Detailed title", status: "detailed", scrapedAt: "2026-07-18T09:30:00.000Z" },
      ],
    }), NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0].payload.listings).toHaveLength(1);
    expect(entries[0].payload.listings[0]).toMatchObject({
      externalId: "3007106066",
      title: "Detailed title",
      status: "detailed",
    });
  });

  it("includes valid coordinate provenance in listing ingestion", () => {
    const listing = record("3007106066", "run-1");
    listing.coordinates = {
      latitude: 47.856373,
      longitude: -3.8512979,
      verifiedAt: "2026-07-18T09:15:00.000Z",
      provenance: JSON.stringify({
        site: "leboncoin",
        container: "#__NEXT_DATA__",
        path: "props.pageProps.ad.location",
        locationSource: "city",
      }),
      locationKind: "source-locality",
    };

    const [entry] = buildQueueEntries(crawlerState({
      run: { ...IDLE_RUN, id: "run-1", status: "completed", collected: 1 },
      records: [listing],
    }), NOW);

    expect(entry.payload.listings).toEqual([
      expect.objectContaining({
        externalId: "3007106066",
        coordinates: listing.coordinates,
      }),
    ]);
  });

  it("omits invalid coordinates without dropping the listing from ingestion", () => {
    const listing = record("3007106066", "run-1");
    listing.coordinates = {
      latitude: 147.8,
      longitude: -3.8,
      verifiedAt: "2026-07-18T09:15:00.000Z",
      provenance: "invalid coordinate fixture",
      locationKind: "source-locality",
    } as ScrapedPropertyRecord["coordinates"];

    const [entry] = buildQueueEntries(crawlerState({
      run: { ...IDLE_RUN, id: "run-1", status: "completed", collected: 1 },
      records: [listing],
    }), NOW);

    expect(entry.payload.listings).toHaveLength(1);
    expect(entry.payload.listings[0]).not.toHaveProperty("coordinates");
  });

  it("preserves the best stable coordinate while preferring detailed listing fields", () => {
    const summary = record("3007106066", "run-1");
    summary.coordinates = {
      latitude: 47.856373,
      longitude: -3.8512979,
      verifiedAt: "2026-07-18T09:15:00.000Z",
      provenance: "same source observation",
      locationKind: "source-locality",
    };
    const detailed: ScrapedPropertyRecord = {
      ...summary,
      title: "Detailed title",
      status: "detailed",
      scrapedAt: "2026-07-18T09:30:00.000Z",
      coordinates: {
        ...summary.coordinates,
        verifiedAt: "2026-07-18T09:30:00.000Z",
      },
    };

    const [entry] = buildQueueEntries(crawlerState({
      run: { ...IDLE_RUN, id: "run-1", status: "completed", collected: 1 },
      records: [summary, detailed],
    }), NOW);

    expect(entry.payload.listings[0]).toMatchObject({
      title: "Detailed title",
      status: "detailed",
      coordinates: summary.coordinates,
    });
  });

  it("keeps an unsynced older run queued when local records advance to another run", () => {
    const oldCrawler = crawlerState({
      run: { ...IDLE_RUN, id: "run-offline-1", status: "completed", collected: 1 },
      records: [record("3007106066", "run-offline-1")],
    });
    const [oldEntry] = buildQueueEntries(oldCrawler, NOW);
    const pending = reconcileCrawlerSnapshot({
      version: 2,
      status: "error",
      queue: [{ ...oldEntry, attempts: 1, nextAttemptAt: NOW.getTime() + 60_000 }],
      syncedFingerprints: {},
      lastError: "Local API unavailable",
      activePlan: { status: "unknown" },
      evaluationQueue: [],
      activeRecipe: { status: "unknown" },
    }, crawlerState({
      run: { ...IDLE_RUN, id: "run-offline-2", status: "completed", collected: 1 },
      records: [record("3007106066", "run-offline-2")],
    }), new Date("2026-07-18T10:01:00.000Z"));

    expect(pending.queue.map((entry) => entry.runId)).toEqual([
      "run-offline-1",
      "run-offline-2",
    ]);
    expect(pending.queue[0]).toMatchObject({ attempts: 1 });
  });

  it("keeps a failed batch queued and retries it successfully without recrawling", async () => {
    storage[CRAWLER_STORAGE_KEYS.run] = {
      ...IDLE_RUN,
      id: "run-1",
      status: "completed",
      startedAt: "2026-07-18T09:00:00.000Z",
      finishedAt: "2026-07-18T09:30:00.000Z",
      collected: 1,
    };
    storage[CRAWLER_STORAGE_KEYS.records] = [record("3007106066", "run-1")];

    await reconcileStoredCrawlerState({ now: () => NOW });
    const unavailable = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const failed = await flushQueuedIngestion({ fetcher: unavailable, now: () => NOW });

    expect(failed.status).toBe("error");
    expect(failed.queue).toHaveLength(1);
    expect(failed.queue[0]).toMatchObject({ attempts: 1, lastError: expect.stringContaining("Failed to fetch") });
    expect((storage[CRAWLER_STORAGE_KEYS.records] as unknown[])).toHaveLength(1);

    const recovered = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/ingestion/runs/run-1");
      const body = JSON.parse(String(init?.body)) as { listings: Array<{ externalId: string }> };
      expect(body.listings.map((listing) => listing.externalId)).toEqual(["3007106066"]);
      return new Response(JSON.stringify({
        runId: "run-1",
        accepted: 1,
        inserted: 1,
        updated: 0,
        unchanged: 0,
      }), { status: 200 });
    });
    const succeeded = await flushQueuedIngestion({
      force: true,
      fetcher: recovered,
      now: () => new Date("2026-07-18T10:01:00.000Z"),
    });

    expect(succeeded.status).toBe("idle");
    expect(succeeded.queue).toEqual([]);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledOnce();
    expect((await loadCrawlerState()).records).toHaveLength(1);
  });

  it("caches the active API recipe without making the extension its editor", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: "coastal-home",
      version: 4,
      name: "Coastal home",
      threshold: 72,
      criteria: [{
        id: "sea-view",
        name: "Sea view",
        description: "The listing explicitly describes a sea view.",
        weight: 40,
        required: true,
        evidenceRequired: true,
      }],
      active: true,
      createdAt: "2026-07-18T09:45:00.000Z",
    }), { status: 200 }));

    const state = await refreshActiveRecipeCache({ fetcher, now: () => NOW });
    const crawler = await loadCrawlerState();

    expect(state.activeRecipe).toMatchObject({
      status: "cached",
      recipeId: "coastal-home",
      recipeVersion: 4,
    });
    expect(crawler.recipe).toMatchObject({
      id: "coastal-home",
      version: 4,
      enabled: true,
    });
    expect((await loadExtensionSyncState()).activeRecipe.status).toBe("cached");
  });

  it("caches a resolved default plan with exact recipe versions and full criterion semantics", async () => {
    const state = await refreshDefaultPlanCache({
      fetcher: vi.fn(async () => new Response(JSON.stringify(resolvedPlan()), { status: 200 })),
      now: () => NOW,
    });

    expect(state.activePlan).toEqual({
      status: "cached",
      fetchedAt: NOW.toISOString(),
      planId: "default-evaluation",
      planVersion: 2,
    });
    expect(await loadEvaluationPlan()).toMatchObject({
      id: "default-evaluation",
      version: 2,
      recipes: [{
        recipeId: "coastal-home",
        recipeVersion: 4,
        recipe: {
          criteria: [{ weight: 800, evidenceRequired: false }],
        },
      }],
    });
  });

  it("migrates a crawl into one stable durable execution and restores aggregate results without replacing legacy evaluation", async () => {
    storage[CRAWLER_STORAGE_KEYS.run] = {
      ...IDLE_RUN,
      id: "run-plan-1",
      status: "completed",
      collected: 1,
    };
    const detailed = { ...record("3007106066", "run-plan-1"), status: "detailed" as const };
    detailed.evaluation = legacyEvaluation(detailed.id);
    storage[CRAWLER_STORAGE_KEYS.records] = [detailed];
    await refreshDefaultPlanCache({
      fetcher: vi.fn(async () => new Response(JSON.stringify(resolvedPlan()), { status: 200 })),
      now: () => NOW,
    });

    const first = await enqueueDefaultPlanEvaluation({ runId: "run-plan-1", locale: "fr", now: () => NOW });
    const duplicate = await enqueueDefaultPlanEvaluation({ runId: "run-plan-1", locale: "fr", now: () => NOW });
    expect(duplicate.key).toBe(first.key);
    expect((await loadExtensionSyncState()).evaluationQueue).toHaveLength(1);

    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs/run-plan-1/evaluation-executions")) {
        expect(init?.headers).toMatchObject({ "Idempotency-Key": first.idempotencyKey });
        return new Response(JSON.stringify(executionRecord("queued")), { status: 202 });
      }
      if (url.endsWith("/v1/evaluation-executions/execution-1/results")) {
        return new Response(JSON.stringify(executionResults()), { status: 200 });
      }
      if (url.endsWith("/v1/evaluation-executions/execution-1")) {
        return new Response(JSON.stringify(executionRecord("completed")), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const queued = await flushEvaluationQueue({ fetcher, now: () => NOW });
    expect(queued.evaluationQueue[0]).toMatchObject({
      status: "polling",
      executionId: "execution-1",
    });

    const completed = await flushEvaluationQueue({
      fetcher,
      now: () => new Date(NOW.getTime() + 2_100),
    });
    expect(completed.evaluationQueue[0].status).toBe("completed");
    const crawler = await loadCrawlerState();
    expect(crawler.records[0].evaluation).toEqual(detailed.evaluation);
    expect(crawler.records[0].planEvaluation).toMatchObject({
      executionId: "execution-1",
      listingId: "3007106066",
      decision: "relevant",
      steps: [{ evaluator: { provider: "openai", model: "gpt-test", version: "3.0.0" } }],
    });
    expect(crawler.run).toMatchObject({
      intelligenceStatus: "completed",
      evaluated: 1,
      relevant: 1,
    });
  });

  it("persists aggregate review results when every durable execution step fails", async () => {
    storage[CRAWLER_STORAGE_KEYS.run] = {
      ...IDLE_RUN,
      id: "run-plan-1",
      status: "completed",
      collected: 1,
    };
    const detailed = { ...record("3007106066", "run-plan-1"), status: "detailed" as const };
    detailed.evaluation = legacyEvaluation(detailed.id);
    storage[CRAWLER_STORAGE_KEYS.records] = [detailed];
    await refreshDefaultPlanCache({
      fetcher: vi.fn(async () => new Response(JSON.stringify(resolvedPlan()), { status: 200 })),
      now: () => NOW,
    });
    await enqueueDefaultPlanEvaluation({ runId: "run-plan-1", locale: "fr", now: () => NOW });

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs/run-plan-1/evaluation-executions") ||
        url.endsWith("/v1/evaluation-executions/execution-1")) {
        return new Response(JSON.stringify(executionRecord("failed")), { status: 200 });
      }
      if (url.endsWith("/v1/evaluation-executions/execution-1/results")) {
        return new Response(JSON.stringify(failedExecutionResults()), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const failed = await flushEvaluationQueue({ fetcher, now: () => NOW });
    expect(failed.evaluationQueue[0]).toMatchObject({
      status: "failed",
      executionId: "execution-1",
      lastError: "Every recipe step failed.",
    });
    const crawler = await loadCrawlerState();
    expect(crawler.records[0].evaluation).toEqual(detailed.evaluation);
    expect(crawler.records[0].planEvaluation).toMatchObject({
      executionId: "execution-1",
      decision: "review",
      score: null,
      steps: [{ status: "failed", error: { code: "OPENAI_UNAVAILABLE" } }],
    });
    expect(crawler.run).toMatchObject({
      intelligenceStatus: "partial",
      evaluated: 1,
      review: 1,
    });
  });
});

function resolvedPlan() {
  return {
    id: "default-evaluation",
    version: 2,
    name: "Default evaluation",
    operator: "all",
    combinerVersion: "tri-state-v1",
    recipes: [{
      recipeId: "coastal-home",
      recipeVersion: 4,
      recipe: {
        id: "coastal-home",
        version: 4,
        name: "Coastal home",
        threshold: 72,
        criteria: [{
          id: "sea-view",
          name: "Sea view",
          description: "The listing explicitly describes a sea view.",
          weight: 800,
          required: true,
          evidenceRequired: false,
        }],
        active: true,
        createdAt: NOW.toISOString(),
      },
    }],
    isDefault: true,
    createdAt: NOW.toISOString(),
  };
}

function executionRecord(status: "queued" | "completed" | "failed") {
  const terminal = status === "completed" || status === "failed";
  return {
    id: "execution-1",
    runId: "run-plan-1",
    planId: "default-evaluation",
    planVersion: 2,
    locale: "fr",
    status,
    listingIds: ["leboncoin:3007106066"],
    force: false,
    createdAt: NOW.toISOString(),
    ...(terminal ? { completedAt: new Date(NOW.getTime() + 2_000).toISOString() } : {}),
    ...(status === "failed" ? { error: "Every recipe step failed." } : {}),
    budget: {
      limit: { providerCalls: 10, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: 1_000_000 },
      estimate: { providerCalls: 2, inputTokens: 2_000, outputTokens: 1_000, costMicroUsd: 10_000 },
      consumed: terminal
        ? { providerCalls: 1, inputTokens: 1_000, outputTokens: 500, costMicroUsd: 5_000 }
        : { providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    },
    counters: {
      total: 1,
      processed: terminal ? 1 : 0,
      relevant: status === "completed" ? 1 : 0,
      notRelevant: 0,
      review: status === "failed" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
    },
  };
}

function executionResults() {
  const evaluatedAt = new Date(NOW.getTime() + 2_000).toISOString();
  return {
    executionId: "execution-1",
    items: [{
      executionId: "execution-1",
      listingId: "leboncoin:3007106066",
      planId: "default-evaluation",
      planVersion: 2,
      decision: "relevant",
      score: 91,
      summary: "Relevant under every recipe.",
      evaluatedAt,
      steps: [{
        recipeId: "coastal-home",
        recipeVersion: 4,
        status: "succeeded",
        evaluator: { provider: "openai", model: "gpt-test", version: "3.0.0" },
        evaluation: {
          listingId: "leboncoin:3007106066",
          decision: "relevant",
          score: 91,
          summary: "Sea view is explicit.",
          criteria: [{ criterionId: "sea-view", verdict: "pass", reason: "Explicit.", evidence: ["vue mer"] }],
          missingData: [],
          evaluatedAt,
        },
      }],
    }],
  };
}

function failedExecutionResults() {
  const evaluatedAt = new Date(NOW.getTime() + 2_000).toISOString();
  return {
    executionId: "execution-1",
    items: [{
      executionId: "execution-1",
      listingId: "leboncoin:3007106066",
      planId: "default-evaluation",
      planVersion: 2,
      decision: "review",
      score: null,
      summary: "Every recipe step failed.",
      evaluatedAt,
      steps: [{
        recipeId: "coastal-home",
        recipeVersion: 4,
        status: "failed",
        error: {
          code: "OPENAI_UNAVAILABLE",
          stage: "provider",
          retryable: false,
          requestId: "request-failed",
        },
      }],
    }],
  };
}

function legacyEvaluation(listingId: string) {
  return {
    listingId,
    decision: "review" as const,
    score: 50,
    summary: "Legacy result",
    criteria: [{ criterionId: "legacy", verdict: "unknown" as const, reason: "Legacy", evidence: [] }],
    missingData: [],
    evaluatedAt: NOW.toISOString(),
    evaluator: { provider: "openai" as const, model: "legacy", version: "2.0.0" },
    recipeId: "legacy",
    recipeVersion: 1,
    locale: "fr" as const,
  };
}

function crawlerState(overrides: Partial<StoredCrawlerState> = {}): StoredCrawlerState {
  return {
    filters: createDefaultSearchFilters(),
    recipe: createDefaultIntelligenceRecipe(),
    run: IDLE_RUN,
    records: [],
    ...overrides,
  };
}

function record(id: string, searchRunId: string): ScrapedPropertyRecord {
  return {
    id,
    source: "leboncoin",
    listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}?from=extension`,
    title: `Maison ${id}`,
    features: ["Jardin"],
    scrapedAt: "2026-07-18T09:15:00.000Z",
    searchRunId,
    status: "listing",
    rawTextSample: `Maison ${id}`,
  };
}
