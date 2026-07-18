import { loadCrawlerState } from "../storage/chromeStorage";
import {
  flushQueuedIngestion,
  reconcileStoredCrawlerState,
  refreshActiveRecipeCache,
} from "./syncService";
import { loadExtensionSyncState } from "./storage";
import type { ExtensionRuntimeResponse } from "./types";

let activeSynchronization: Promise<ExtensionRuntimeResponse> | undefined;
let rerunRequested = false;
let forceRequested = false;

export function scheduleExtensionSync(force = false): Promise<ExtensionRuntimeResponse> {
  rerunRequested = true;
  forceRequested ||= force;
  if (activeSynchronization) return activeSynchronization;

  activeSynchronization = runSynchronizationLoop().finally(() => {
    activeSynchronization = undefined;
  });
  return activeSynchronization;
}

export async function refreshCachedActiveRecipe(): Promise<ExtensionRuntimeResponse> {
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
