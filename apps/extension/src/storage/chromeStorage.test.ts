import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultIntelligenceRecipe } from "../intelligence/recipe";
import {
  IDLE_RUN,
  isCrawlerStorageKey,
  loadCrawlerState,
  migrateStoredRecords,
  reconcileInterruptedRun,
  saveRecipe,
} from "./chromeStorage";

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
        },
      },
    } as unknown as typeof chrome,
  });
});

describe("crawler run recovery", () => {
  it("cancels a persisted active run when the dashboard closed", () => {
    const run = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "run-1", status: "collecting-details", startedAt: "2026-07-11T10:00:00.000Z" },
      "2026-07-11T10:10:00.000Z",
    );

    expect(run).toMatchObject({
      id: "run-1",
      status: "cancelled",
      finishedAt: "2026-07-11T10:10:00.000Z",
      message: "Previous crawl was cancelled because the dashboard closed.",
    });
    expect(run.error).toBeUndefined();
  });

  it("keeps terminal runs unchanged", () => {
    const completed = { ...IDLE_RUN, status: "completed" as const };
    expect(reconcileInterruptedRun(completed)).toBe(completed);
  });

  it("does not preserve a paused captcha after the dashboard closes", () => {
    const recovered = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "legacy-captcha", status: "paused-captcha" },
      "2026-07-12T10:10:00.000Z",
    );

    expect(recovered).toMatchObject({
      status: "cancelled",
      finishedAt: "2026-07-12T10:10:00.000Z",
      message: "Previous crawl was cancelled because the dashboard closed.",
    });
  });

  it("treats native search configuration as an interruptible phase", () => {
    const recovered = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "native-search", status: "configuring-search" },
      "2026-07-12T10:10:00.000Z",
    );

    expect(recovered.status).toBe("cancelled");
  });

  it("marks interrupted intelligence as failed while cancelling the crawl", () => {
    const recovered = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "run-2", status: "evaluating", intelligenceStatus: "evaluating" },
      "2026-07-12T10:10:00.000Z",
    );

    expect(recovered).toMatchObject({
      status: "cancelled",
      intelligenceStatus: "failed",
      intelligenceError: "The dashboard closed before intelligence evaluation finished.",
    });
  });

  it("loads legacy crawler state with intelligence defaults", async () => {
    storage["denicheur:crawler:run"] = {
      id: "legacy-run",
      status: "completed",
      target: 20,
      found: 2,
      collected: 2,
    };

    const state = await loadCrawlerState();

    expect(state.recipe).toEqual(createDefaultIntelligenceRecipe());
    expect(state.run).toMatchObject({
      id: "legacy-run",
      evaluated: 0,
      relevant: 0,
      notRelevant: 0,
      review: 0,
      filterWarnings: [],
      intelligenceStatus: "idle",
    });
  });

  it("migrates legacy filters in storage and discards URL-only fields", async () => {
    storage["denicheur:crawler:filters"] = {
      source: "leboncoin",
      rawSearchUrl: "https://www.leboncoin.fr/recherche?category=9",
      category: "9",
      text: "maison",
      locationToken: "Finistère__48.2_-4.0_50000",
      propertyTypes: ["1"],
      ownerType: "private",
      sort: "time",
      order: "desc",
      maxListings: 1,
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
      pauseAfterDetails: 5,
      cooldownSeconds: 180,
      closeDetailTabs: true,
    };

    const state = await loadCrawlerState();
    const persisted = storage["denicheur:crawler:filters"] as Record<string, unknown>;

    expect(state.filters.locationQuery).toBe("Finistère");
    expect(persisted.locationQuery).toBe("Finistère");
    expect(persisted).not.toHaveProperty("rawSearchUrl");
    expect(persisted).not.toHaveProperty("locationToken");
    expect(persisted).not.toHaveProperty("closeDetailTabs");
  });

  it("persists the normalized recipe under an observed crawler key", async () => {
    await saveRecipe({
      ...createDefaultIntelligenceRecipe(),
      enabled: true,
      threshold: 150,
      criteria: [
        {
          id: "garden",
          name: "Garden",
          description: "A private garden is explicitly described.",
          weight: 20,
          required: true,
        },
      ],
    });

    const state = await loadCrawlerState();
    expect(state.recipe.threshold).toBe(100);
    expect(state.recipe.criteria[0].id).toBe("garden");
    expect(isCrawlerStorageKey("denicheur:intelligence:recipe")).toBe(true);
  });

  it("migrates legacy category ids and deduplicates tracking URL variants", () => {
    const legacy = (listingUrl: string, title: string) => ({
      id: "ventes_immobilieres",
      source: "leboncoin" as const,
      listingUrl,
      title,
      features: [],
      scrapedAt: "2026-07-11T10:00:00.000Z",
      searchRunId: "legacy-run",
      status: "detailed" as const,
      rawTextSample: title,
    });

    const migrated = migrateStoredRecords([
      legacy("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066?utm_source=one", "First"),
      legacy("https://leboncoin.fr/ad/ventes_immobilieres/3007106066?utm_source=two", "Duplicate"),
      legacy("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106077", "Second"),
    ]);

    expect(migrated).toHaveLength(2);
    expect(migrated.map((record) => record.id)).toEqual(["3007106066", "3007106077"]);
    expect(migrated[0].listingUrl).toBe("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066");
  });

  it("prefers a detailed duplicate without importing fields from its summary", () => {
    const base = {
      id: "3007106066",
      source: "leboncoin" as const,
      listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
      scrapedAt: "2026-07-11T10:00:00.000Z",
      searchRunId: "legacy-run",
      rawTextSample: "Maison",
    };

    const migrated = migrateStoredRecords([
      {
        ...base,
        title: "Maison",
        priceEuros: 300000,
        features: ["Jardin"],
        status: "listing",
      },
      {
        ...base,
        title: undefined,
        description: "Description détaillée",
        imageUrls: ["https://img.leboncoin.fr/detail.jpg"],
        features: ["Garage"],
        scrapedAt: "2026-07-11T10:05:00.000Z",
        status: "detailed",
      },
    ]);

    expect(migrated).toEqual([
      expect.objectContaining({
        id: "3007106066",
        status: "detailed",
        title: undefined,
        description: "Description détaillée",
        imageUrl: "https://img.leboncoin.fr/detail.jpg",
        imageUrls: ["https://img.leboncoin.fr/detail.jpg"],
        features: ["Garage"],
      }),
    ]);
    expect(migrated[0].priceEuros).toBeUndefined();
  });
});
