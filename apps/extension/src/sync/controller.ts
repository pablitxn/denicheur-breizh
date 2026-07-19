import {
  clearRecordsAndSyncQueue,
  loadCrawlerState,
} from "../storage/chromeStorage";
import {
  flushQueuedIngestion,
  reconcileStoredCrawlerState,
  refreshActiveRecipeCache,
} from "./syncService";
import { clearApiCollectedData } from "./api";
import { loadExtensionSyncState } from "./storage";
import type { ExtensionRuntimeResponse } from "./types";

export const ITERATION_RESET_TIMEOUT_MS = 15_000;
const ITERATION_RESET_CALLBACK_MARGIN_MS = 1_000;

class IterationResetTimeoutError extends Error {
  readonly code = "RESET_TIMEOUT";

  constructor() {
    super("The coordinated iteration reset exceeded its deadline.");
    this.name = "IterationResetTimeoutError";
  }
}

let activeSynchronization: Promise<ExtensionRuntimeResponse> | undefined;
let activeReset: Promise<ExtensionRuntimeResponse> | undefined;
let activeRecipeRefresh: Promise<ExtensionRuntimeResponse> | undefined;
let rerunRequested = false;
let forceRequested = false;

export function scheduleExtensionSync(force = false): Promise<ExtensionRuntimeResponse> {
  if (activeReset) return activeReset;
  rerunRequested = true;
  forceRequested ||= force;
  if (activeSynchronization) return activeSynchronization;

  activeSynchronization = runSynchronizationLoop().finally(() => {
    activeSynchronization = undefined;
  });
  return activeSynchronization;
}

export function resetExtensionIteration(deadlineAt?: number): Promise<ExtensionRuntimeResponse> {
  if (activeReset) return activeReset;
  activeReset = runIterationReset(deadlineAt).finally(() => {
    activeReset = undefined;
  });
  return activeReset;
}

export function refreshCachedActiveRecipe(): Promise<ExtensionRuntimeResponse> {
  if (activeReset) {
    return activeReset.then(() => refreshCachedActiveRecipe());
  }
  if (activeRecipeRefresh) return activeRecipeRefresh;
  activeRecipeRefresh = runActiveRecipeRefresh().finally(() => {
    activeRecipeRefresh = undefined;
  });
  return activeRecipeRefresh;
}

async function runActiveRecipeRefresh(): Promise<ExtensionRuntimeResponse> {
  const state = await refreshActiveRecipeCache();
  const recipe = (await loadCrawlerState()).recipe;
  return {
    ok: state.activeRecipe.status === "cached",
    state,
    ...(state.activeRecipe.status === "cached" ? { recipe } : {}),
    ...(state.activeRecipe.lastError ? { error: state.activeRecipe.lastError } : {}),
  };
}

export async function readSyncResponse(): Promise<ExtensionRuntimeResponse> {
  const state = await loadExtensionSyncState();
  return {
    ok: state.status !== "error",
    state,
    ...(state.lastError ? { error: state.lastError } : {}),
  };
}

async function runSynchronizationLoop(): Promise<ExtensionRuntimeResponse> {
  let response = await readSyncResponse();

  do {
    rerunRequested = false;
    const force = forceRequested;
    forceRequested = false;
    await reconcileStoredCrawlerState();
    await refreshActiveRecipeCache();
    const state = await flushQueuedIngestion({ force });
    response = {
      ok: state.status !== "error",
      state,
      ...(state.lastError ? { error: state.lastError } : {}),
    };
  } while (rerunRequested);

  return response;
}

async function runIterationReset(deadlineAt?: number): Promise<ExtensionRuntimeResponse> {
  const effectiveDeadlineAt = resetDeadlineAt(deadlineAt);
  if (effectiveDeadlineAt <= Date.now()) throw new IterationResetTimeoutError();
  const abortController = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => abortController.abort(),
    effectiveDeadlineAt - Date.now(),
  );

  try {
    await waitForResetDependency(activeSynchronization, abortController.signal, effectiveDeadlineAt);
    await waitForResetDependency(activeRecipeRefresh, abortController.signal, effectiveDeadlineAt);
    await runResetPhase(clearRecordsAndSyncQueue, abortController.signal, effectiveDeadlineAt);
    await runResetPhase(
      () => clearApiCollectedData({ signal: abortController.signal }),
      abortController.signal,
      effectiveDeadlineAt,
    );
    return await runResetPhase(readSyncResponse, abortController.signal, effectiveDeadlineAt);
  } catch (error) {
    if (resetExpired(abortController.signal, effectiveDeadlineAt)) {
      throw new IterationResetTimeoutError();
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function resetDeadlineAt(deadlineAt?: number): number {
  const internalDeadlineAt = Date.now() + ITERATION_RESET_TIMEOUT_MS;
  if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return internalDeadlineAt;
  return Math.min(internalDeadlineAt, deadlineAt - ITERATION_RESET_CALLBACK_MARGIN_MS);
}

function runResetPhase<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  if (resetExpired(signal, deadlineAt)) return Promise.reject(new IterationResetTimeoutError());
  return waitForResetDependency(operation(), signal, deadlineAt);
}

function waitForResetDependency<T>(
  operation: Promise<T> | undefined,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<T> {
  if (!operation) return Promise.resolve(undefined as T);
  if (resetExpired(signal, deadlineAt)) return Promise.reject(new IterationResetTimeoutError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new IterationResetTimeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (resetExpired(signal, deadlineAt)) reject(new IterationResetTimeoutError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function resetExpired(signal: AbortSignal, deadlineAt: number): boolean {
  return signal.aborted || Date.now() >= deadlineAt;
}
