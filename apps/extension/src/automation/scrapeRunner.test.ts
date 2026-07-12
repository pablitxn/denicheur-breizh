import { describe, expect, it, vi } from "vitest";
import type {
  IntelligenceRecipe,
  ListingEvaluation,
  ScrapeRun,
  ScrapedPropertyRecord,
} from "../lib/types";
import { runIntelligencePhase } from "./scrapeRunner";

const recipe: IntelligenceRecipe = {
  id: "personal-fit",
  version: 3,
  name: "Personal fit",
  threshold: 70,
  enabled: true,
  criteria: [
    {
      id: "garden",
      name: "Garden",
      description: "The listing explicitly describes a private garden.",
      weight: 30,
      required: true,
    },
  ],
};

function run(): ScrapeRun {
  return {
    id: "run-1",
    status: "collecting-details",
    target: 2,
    found: 2,
    collected: 1,
    evaluated: 0,
    relevant: 0,
    notRelevant: 0,
    review: 0,
    intelligenceStatus: "idle",
  };
}

function record(id: string, status: ScrapedPropertyRecord["status"]): ScrapedPropertyRecord {
  return {
    id,
    source: "leboncoin",
    listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`,
    title: `Listing ${id}`,
    description: "Maison avec jardin privatif.",
    features: ["Jardin"],
    scrapedAt: "2026-07-12T10:00:00.000Z",
    searchRunId: "run-1",
    status,
    rawTextSample: "Maison avec jardin",
  };
}

function evaluation(listingId: string): ListingEvaluation {
  return {
    listingId,
    decision: "relevant",
    score: 100,
    summary: "The required garden is present.",
    criteria: [
      {
        criterionId: "garden",
        verdict: "pass",
        reason: "The description explicitly mentions the garden.",
        evidence: ["jardin privatif"],
      },
    ],
    missingData: [],
    evaluatedAt: "2026-07-12T10:01:00.000Z",
    evaluator: { provider: "openai", model: "gpt-5-mini-2025-08-07", version: "1.0.0" },
    recipeId: recipe.id,
    recipeVersion: recipe.version,
  };
}

describe("scrape runner intelligence phase", () => {
  it("evaluates only detailed run records and persists the merged result", async () => {
    const activeRun = run();
    const detailed = record("listing-1", "detailed");
    const failed = record("listing-2", "failed");
    const evaluator = vi.fn(async () => [evaluation(detailed.id)]);
    const snapshots: Array<{ status: ScrapeRun["status"]; intelligenceStatus: ScrapeRun["intelligenceStatus"] }> = [];

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [detailed, failed],
      recipe,
      evaluator,
      signal: new AbortController().signal,
      persist: async (nextRun) => {
        snapshots.push({ status: nextRun.status, intelligenceStatus: nextRun.intelligenceStatus });
      },
    });

    expect(evaluator).toHaveBeenCalledWith(
      "run-1",
      recipe,
      [detailed],
      expect.any(AbortSignal),
    );
    expect(snapshots).toEqual([
      { status: "evaluating", intelligenceStatus: "evaluating" },
      { status: "completed", intelligenceStatus: "completed" },
    ]);
    expect(records[0].evaluation?.decision).toBe("relevant");
    expect(records[1]).toBe(failed);
    expect(activeRun).toMatchObject({ evaluated: 1, relevant: 1, status: "completed" });
  });

  it("preserves detailed records and completes the crawl when evaluation fails", async () => {
    const activeRun = run();
    const detailed = record("listing-1", "detailed");
    const persist = vi.fn(async () => undefined);

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [detailed],
      recipe,
      evaluator: vi.fn(async () => {
        throw new Error("API unavailable");
      }),
      signal: new AbortController().signal,
      persist,
    });

    expect(records[0]).toBe(detailed);
    expect(activeRun).toMatchObject({
      status: "completed",
      intelligenceStatus: "failed",
      intelligenceError: "API unavailable",
      collected: 1,
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation instead of persisting a fabricated evaluation result", async () => {
    const activeRun = run();
    const abortController = new AbortController();

    await expect(runIntelligencePhase({
      run: activeRun,
      records: [record("listing-1", "detailed")],
      recipe,
      evaluator: vi.fn(async () => {
        abortController.abort();
        throw new DOMException("cancelled", "AbortError");
      }),
      signal: abortController.signal,
      persist: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
