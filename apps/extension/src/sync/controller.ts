import {
  clearRecordsAndSyncQueue,
  loadCrawlerState,
  loadEvaluationPlan,
} from "../storage/chromeStorage";
import {
  enqueueDefaultPlanEvaluation,
  flushEvaluationQueue,
  flushQueuedIngestion,
  reconcileStoredCrawlerState,
  refreshDefaultPlanCache,
} from "./syncService";
import { clearApiCollectedData } from "./api";
import { loadExtensionSyncState } from "./storage";
import type { ExtensionRuntimeResponse } from "./types";
import type { LocaleCode } from "@denicheur-breizh/i18n";

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
let activePlanRefresh: Promise<ExtensionRuntimeResponse> | undefined;
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
  return refreshCachedDefaultPlan();
}

export function refreshCachedDefaultPlan(): Promise<ExtensionRuntimeResponse> {
  if (activeReset) {
    return activeReset.then(() => refreshCachedDefaultPlan());
  }
  if (activePlanRefresh) return activePlanRefresh;
  activePlanRefresh = runDefaultPlanRefresh().finally(() => {
    activePlanRefresh = undefined;
  });
  return activePlanRefresh;
}

export async function queueDefaultPlanEvaluation(request: {
  runId: string;
  locale: LocaleCode;
  listingIds?: string[];
  force?: boolean;
}): Promise<ExtensionRuntimeResponse> {
  if (activeReset) return activeReset.then(() => queueDefaultPlanEvaluation(request));
  // A crawl completion can already be reconciling ingestion state. Let that
  // synchronization persist its snapshot before appending the durable job so
  // a stale reconciliation write cannot drop the new evaluation entry.
  if (activeSynchronization) await activeSynchronization;
  await refreshDefaultPlanCache();
  const entry = await enqueueDefaultPlanEvaluation(request);
  const response = await scheduleExtensionSync(true);
  const current = response.state.evaluationQueue.find((candidate) => candidate.key === entry.key);
  return {
    ...response,
    ok: current?.status !== "failed" && current?.status !== "cancelled",
    ...(current?.lastError ? { error: current.lastError } : {}),
  };
}

async function runDefaultPlanRefresh(): Promise<ExtensionRuntimeResponse> {
  const state = await refreshDefaultPlanCache();
  const [crawler, plan] = await Promise.all([loadCrawlerState(), loadEvaluationPlan()]);
  return {
    ok: state.activePlan.status === "cached",
    state,
    ...(state.activePlan.status === "cached" && plan ? { plan, recipe: crawler.recipe } : {}),
    ...(state.activePlan.lastError ? { error: state.activePlan.lastError } : {}),
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
    await refreshDefaultPlanCache();
    await flushQueuedIngestion({ force });
    const state = await flushEvaluationQueue({ force });
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
    await waitForResetDependency(activePlanRefresh, abortController.signal, effectiveDeadlineAt);
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
