import { describe, expect, it, vi } from "vitest";
import { IDLE_RUN } from "../storage/chromeStorage";
import { createDefaultIntelligenceRecipe } from "../intelligence/recipe";
import type { ScrapeRun, ScrapedPropertyRecord } from "../lib/types";
import {
  getRecordImageUrls,
  hasLiveDashboardRunner,
  parseRecordsPageSize,
  parseResultsViewState,
  recipeFromDrafts,
  reconcileDashboardRun,
  recordMatchesQuery,
  resolveResultsPage,
  withDashboardRunnerLease,
} from "./DashboardApp";

const FINISHED_AT = "2026-07-15T18:30:00.000Z";

function pausedRun(): ScrapeRun {
  return {
    ...IDLE_RUN,
    id: "paused-run",
    status: "paused-captcha",
    startedAt: "2026-07-15T18:00:00.000Z",
  };
}

describe("dashboard runner ownership recovery", () => {
  it("cancels a restored pause in every dashboard when no runner owner exists", () => {
    const persisted = pausedRun();

    const firstDashboard = reconcileDashboardRun(persisted, false, FINISHED_AT);
    const secondDashboard = reconcileDashboardRun(persisted, false, FINISHED_AT);

    expect(firstDashboard).toMatchObject({
      status: "cancelled",
      finishedAt: FINISHED_AT,
      message: { id: "run.interrupted" },
    });
    expect(secondDashboard).toEqual(firstDashboard);
  });

  it("preserves a pause when this dashboard still owns its runner", async () => {
    const persisted = pausedRun();
    const query = vi.fn();

    const hasLiveRunner = await hasLiveDashboardRunner(true, { query });
    const recovered = reconcileDashboardRun(persisted, hasLiveRunner, FINISHED_AT);

    expect(query).not.toHaveBeenCalled();
    expect(recovered).toBe(persisted);
  });

  it("preserves a pause observed from another dashboard while its runner lease is held", async () => {
    const persisted = pausedRun();
    const query = vi.fn(async () => ({
      held: [{ name: "denicheur:crawler:dashboard-runner", mode: "exclusive" as const }],
      pending: [],
    }));

    const hasLiveRunner = await hasLiveDashboardRunner(false, { query });
    const recovered = reconcileDashboardRun(persisted, hasLiveRunner, FINISHED_AT);

    expect(hasLiveRunner).toBe(true);
    expect(recovered).toBe(persisted);
  });

  it("treats an unavailable ownership snapshot as no live runner", async () => {
    const query = vi.fn(async () => {
      throw new Error("Lock query unavailable");
    });

    await expect(hasLiveDashboardRunner(false, { query })).resolves.toBe(false);
  });

  it("holds an exclusive lease for the operation and rejects a competing start", async () => {
    const operation = vi.fn(async () => "completed");
    const observedOptions: LockOptions[] = [];
    const grantedLockManager = {
      async request<T>(
        _name: string,
        options: LockOptions,
        callback: LockGrantedCallback<T>,
      ): Promise<T> {
        observedOptions.push(options);
        return callback({ name: "denicheur:crawler:dashboard-runner", mode: "exclusive" } as Lock);
      },
    };

    await expect(withDashboardRunnerLease(operation, grantedLockManager)).resolves.toBe("completed");
    expect(observedOptions).toEqual([{ ifAvailable: true }]);
    expect(operation).toHaveBeenCalledOnce();

    const deniedOperation = vi.fn(async () => "should-not-run");
    const deniedLockManager = {
      async request<T>(
        _name: string,
        _options: LockOptions,
        callback: LockGrantedCallback<T>,
      ): Promise<T> {
        return callback(null);
      },
    };

    await expect(withDashboardRunnerLease(deniedOperation, deniedLockManager))
      .rejects.toThrow("Another dashboard already owns the crawler run.");
    expect(deniedOperation).not.toHaveBeenCalled();
  });
});

describe("dashboard result and recipe drafts", () => {
  const record: ScrapedPropertyRecord = {
    id: "listing-1",
    source: "leboncoin",
    listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
    title: "Maison avec jardin",
    location: "Quimper",
    priceText: "320 000 €",
    propertyType: "Maison",
    sellerName: "Agence du port",
    features: ["Garage", "Vue mer"],
    scrapedAt: FINISHED_AT,
    searchRunId: "run-1",
    status: "detailed",
    rawTextSample: "Maison avec jardin",
  };

  it("parses shareable result filters and rejects invalid page values", () => {
    expect(parseResultsViewState("?decision=review&q=jardin&page=3&pageSize=48")).toEqual({
      decision: "review",
      query: "jardin",
      page: 3,
      pageSize: 48,
    });
    expect(parseResultsViewState("?decision=unknown&page=-2&pageSize=13")).toEqual({
      decision: "all",
      query: "",
      page: 1,
      pageSize: 24,
    });
  });

  it("accepts only supported records-per-page values", () => {
    expect(parseRecordsPageSize("12")).toBe(12);
    expect(parseRecordsPageSize(48)).toBe(48);
    expect(parseRecordsPageSize("96")).toBe(24);
  });

  it("normalizes, resolves and deduplicates safe image URLs", () => {
    expect(getRecordImageUrls({
      ...record,
      imageUrl: "https://img.leboncoin.fr/primary.jpg",
      imageUrls: [
        "https://img.leboncoin.fr/primary.jpg",
        "/secondary.jpg",
        "javascript:alert(1)",
        "http://[",
      ],
    })).toEqual([
      "https://img.leboncoin.fr/primary.jpg",
      "https://www.leboncoin.fr/secondary.jpg",
    ]);
  });

  it("preserves the requested page through hydration, then clamps against loaded records", () => {
    expect(resolveResultsPage(3, 1, false)).toBe(3);
    expect(resolveResultsPage(3, 5, true)).toBe(3);
    expect(resolveResultsPage(8, 5, true)).toBe(5);
  });

  it("searches across visible listing metadata without case sensitivity", () => {
    expect(recordMatchesQuery(record, "JARDIN", "fr")).toBe(true);
    expect(recordMatchesQuery(record, "vue mer", "fr")).toBe(true);
    expect(recordMatchesQuery(record, "agence du port", "fr")).toBe(true);
    expect(recordMatchesQuery(record, "Brest", "fr")).toBe(false);
  });

  it("preserves empty numeric drafts as invalid values until validation", () => {
    const recipe = {
      ...createDefaultIntelligenceRecipe(),
      enabled: true,
      criteria: [{
        id: "garden",
        name: "Garden",
        description: "A private garden is explicitly described.",
        weight: 20,
        required: false,
      }],
    };

    const draft = recipeFromDrafts(recipe, "", { garden: "" });
    expect(Number.isNaN(draft.threshold)).toBe(true);
    expect(Number.isNaN(draft.criteria[0].weight)).toBe(true);
  });
});
