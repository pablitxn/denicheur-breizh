import type {
  ActivePlanCacheState,
  ActiveRecipeCacheState,
  EvaluationQueueEntry,
  ExtensionSyncState,
} from "./types";

export const SYNC_STORAGE_KEY = "denicheur:sync:state";
const SYNC_STATE_LOCK = "denicheur:sync:state";

export const EMPTY_SYNC_STATE: ExtensionSyncState = {
  version: 2,
  generation: 0,
  status: "idle",
  queue: [],
  syncedFingerprints: {},
  activePlan: { status: "unknown" },
  evaluationQueue: [],
  activeRecipe: { status: "unknown" },
};

export async function loadExtensionSyncState(): Promise<ExtensionSyncState> {
  return withSyncStateLock(loadExtensionSyncStateUnlocked);
}

async function loadExtensionSyncStateUnlocked(): Promise<ExtensionSyncState> {
  const values = await getStorage<{ [SYNC_STORAGE_KEY]?: unknown }>([SYNC_STORAGE_KEY]);
  const stored = values[SYNC_STORAGE_KEY];
  const normalized = normalizeSyncState(stored);
  if (isRecord(stored) && stored.version === 1) {
    await setStorage({ [SYNC_STORAGE_KEY]: normalized });
  }
  return normalized;
}

/** Transform current storage synchronously; network and crawler reads stay outside this lock. */
export async function updateExtensionSyncState(
  update: (current: ExtensionSyncState) => ExtensionSyncState,
  expectedGeneration?: number,
): Promise<ExtensionSyncState> {
  return withSyncStateLock(async () => {
    const current = await loadExtensionSyncStateUnlocked();
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return current;
    const next = update(current);
    if (next !== current) await setStorage({ [SYNC_STORAGE_KEY]: next });
    return next;
  });
}

/** Called with the crawler lock held, so records and outbox clear in one storage write. */
export async function clearExtensionSyncQueue(crawlerPatch: Record<string, unknown>): Promise<void> {
  await withSyncStateLock(async () => {
    const current = await loadExtensionSyncStateUnlocked();
    await setStorage({
      ...crawlerPatch,
      [SYNC_STORAGE_KEY]: {
        ...structuredClone(EMPTY_SYNC_STATE),
        generation: (current.generation ?? 0) + 1,
        activePlan: current.activePlan,
        activeRecipe: current.activeRecipe,
      },
    });
  });
}

async function withSyncStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request) throw new Error("This browser cannot safely coordinate the local sync queue. Use a Chrome version with Web Locks support.");
  return await locks.request(SYNC_STATE_LOCK, { mode: "exclusive" }, operation);
}

function normalizeSyncState(value: unknown): ExtensionSyncState {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return structuredClone(EMPTY_SYNC_STATE);
  }

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
  const activePlan: ActivePlanCacheState = value.version === 2 && isRecord(value.activePlan) &&
    (value.activePlan.status === "unknown" ||
      value.activePlan.status === "cached" ||
      value.activePlan.status === "none" ||
      value.activePlan.status === "unavailable")
    ? {
        status: value.activePlan.status,
        fetchedAt: optionalString(value.activePlan.fetchedAt),
        planId: optionalString(value.activePlan.planId),
        planVersion: optionalNumber(value.activePlan.planVersion),
        lastError: optionalString(value.activePlan.lastError),
      }
    : { status: "unknown" as const };
  const evaluationQueue = value.version === 2 && Array.isArray(value.evaluationQueue)
    ? value.evaluationQueue.filter(isEvaluationQueueEntry)
    : [];

  return {
    version: 2,
    generation: typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0
      ? value.generation
      : 0,
    status: value.status === "pending" || value.status === "syncing" || value.status === "error"
      ? value.status
      : "idle",
    queue,
    syncedFingerprints,
    lastAttemptAt: optionalString(value.lastAttemptAt),
    lastSuccessAt: optionalString(value.lastSuccessAt),
    lastError: optionalString(value.lastError),
    activePlan,
    evaluationQueue,
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

function isEvaluationQueueEntry(value: unknown): value is EvaluationQueueEntry {
  if (!isRecord(value)) return false;
  const statuses = new Set(["queued", "creating", "polling", "completed", "failed", "cancelled"]);
  return typeof value.key === "string" &&
    typeof value.idempotencyKey === "string" &&
    typeof value.runId === "string" &&
    typeof value.planId === "string" &&
    typeof value.planVersion === "number" && Number.isInteger(value.planVersion) &&
    (value.locale === "fr" || value.locale === "es" || value.locale === "en") &&
    typeof value.status === "string" && statuses.has(value.status) &&
    (value.listingIds === undefined ||
      (Array.isArray(value.listingIds) && value.listingIds.every((id) => typeof id === "string"))) &&
    (value.force === undefined || typeof value.force === "boolean") &&
    (value.executionId === undefined || typeof value.executionId === "string") &&
    typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0 &&
    typeof value.nextAttemptAt === "number" && Number.isFinite(value.nextAttemptAt) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.lastError === undefined || typeof value.lastError === "string");
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
