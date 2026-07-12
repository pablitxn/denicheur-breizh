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
  it("marks a persisted active run as interrupted", () => {
    const run = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "run-1", status: "collecting-details", startedAt: "2026-07-11T10:00:00.000Z" },
      "2026-07-11T10:10:00.000Z",
    );

    expect(run).toMatchObject({
      id: "run-1",
      status: "failed",
      finishedAt: "2026-07-11T10:10:00.000Z",
      error: "The dashboard closed before the crawl finished.",
    });
  });

  it("keeps terminal runs unchanged", () => {
    const completed = { ...IDLE_RUN, status: "completed" as const };
    expect(reconcileInterruptedRun(completed)).toBe(completed);
  });

  it("marks an interrupted intelligence phase as failed instead of leaving it evaluating", () => {
    const recovered = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "run-2", status: "evaluating", intelligenceStatus: "evaluating" },
      "2026-07-12T10:10:00.000Z",
    );

    expect(recovered).toMatchObject({
      status: "failed",
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
      intelligenceStatus: "idle",
    });
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
});
