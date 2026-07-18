import type { ActiveRecipeCacheState, ExtensionSyncState } from "./types";

export const SYNC_STORAGE_KEY = "denicheur:sync:state";

export const EMPTY_SYNC_STATE: ExtensionSyncState = {
  version: 1,
  status: "idle",
  queue: [],
  syncedFingerprints: {},
  activeRecipe: { status: "unknown" },
};

export async function loadExtensionSyncState(): Promise<ExtensionSyncState> {
  const values = await getStorage<{ [SYNC_STORAGE_KEY]?: unknown }>([SYNC_STORAGE_KEY]);
  return normalizeSyncState(values[SYNC_STORAGE_KEY]);
}

export async function saveExtensionSyncState(state: ExtensionSyncState): Promise<void> {
  await setStorage({ [SYNC_STORAGE_KEY]: state });
}

function normalizeSyncState(value: unknown): ExtensionSyncState {
  if (!isRecord(value) || value.version !== 1) return structuredClone(EMPTY_SYNC_STATE);

  const queue = Array.isArray(value.queue)
    ? value.queue.filter(isQueueEntry)
    : [];
  const syncedFingerprints = isRecord(value.syncedFingerprints)
    ? Object.fromEntries(Object.entries(value.syncedFingerprints).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ))
    : {};
  const activeRecipe: ActiveRecipeCacheState = isRecord(value.activeRecipe) &&
    (value.activeRecipe.status === "unknown" ||
      value.activeRecipe.status === "cached" ||
      value.activeRecipe.status === "unavailable")
    ? {
        status: value.activeRecipe.status,
        fetchedAt: optionalString(value.activeRecipe.fetchedAt),
        recipeId: optionalString(value.activeRecipe.recipeId),
        recipeVersion: optionalNumber(value.activeRecipe.recipeVersion),
        lastError: optionalString(value.activeRecipe.lastError),
      }
    : { status: "unknown" as const };

  return {
    version: 1,
    status: value.status === "pending" || value.status === "syncing" || value.status === "error"
      ? value.status
      : "idle",
    queue,
    syncedFingerprints,
    lastAttemptAt: optionalString(value.lastAttemptAt),
    lastSuccessAt: optionalString(value.lastSuccessAt),
    lastError: optionalString(value.lastError),
    activeRecipe,
  };
}

function isQueueEntry(value: unknown): value is ExtensionSyncState["queue"][number] {
  if (!isRecord(value) || !isRecord(value.payload) || !isRecord(value.payload.run)) return false;
  return typeof value.key === "string" &&
    typeof value.runId === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.attempts === "number" &&
    typeof value.nextAttemptAt === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.payload.listings);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStorage<T extends Record<string, unknown>>(keys: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (values) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(values as T);
    });
  });
}

function setStorage(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
