import { beforeEach, describe, expect, it } from "vitest";
import { loadExtensionSyncState, SYNC_STORAGE_KEY } from "./storage";

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

describe("extension sync state migration", () => {
  it("persists v1 ingestion state as v2 while preserving the legacy recipe cache", async () => {
    storage[SYNC_STORAGE_KEY] = {
      version: 1,
      status: "pending",
      queue: [],
      syncedFingerprints: { "run-1:batch:1": "fingerprint" },
      activeRecipe: {
        status: "cached",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        recipeId: "legacy-recipe",
        recipeVersion: 3,
      },
    };

    const state = await loadExtensionSyncState();

    expect(state).toMatchObject({
      version: 2,
      status: "pending",
      syncedFingerprints: { "run-1:batch:1": "fingerprint" },
      activePlan: { status: "unknown" },
      evaluationQueue: [],
      activeRecipe: {
        status: "cached",
        recipeId: "legacy-recipe",
        recipeVersion: 3,
      },
    });
    expect(storage[SYNC_STORAGE_KEY]).toEqual(state);
  });
});
