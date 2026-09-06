import {
  ingestionRequestSchema,
  listingIngestionSchema,
  runIngestionSchema,
  type IngestionRequest,
  type ListingIngestion,
  type RunIngestion,
} from "@denicheur-breizh/contracts";
import type { LocaleCode } from "@denicheur-breizh/i18n";
import { errorMessageDescriptor, localizedTextDetail, message } from "../lib/localizedText";
import {
  normalizeVerifiedCoordinates,
  selectBestCoordinates,
} from "../lib/coordinates";
import type {
  EvaluationExecution,
  ScrapeRun,
  ScrapedPropertyRecord,
  StoredCrawlerState,
} from "../lib/types";
import { primaryPlanRecipe } from "../intelligence/plan";
import {
  clearEvaluationPlan,
  loadCrawlerState,
  loadEvaluationPlan,
  updateCrawlerData,
  saveEvaluationPlan,
  saveRecipe,
} from "../storage/chromeStorage";
import {
  createEvaluationExecution,
  ExtensionApiError,
  fetchActiveRecipe,
  fetchDefaultEvaluationPlan,
  fetchEvaluationExecution,
  fetchEvaluationExecutionResults,
  ingestRunBatch,
  type SyncFetcher,
} from "./api";
import {
  loadExtensionSyncState,
  updateExtensionSyncState,
} from "./storage";
import {
  INGESTION_BATCH_SIZE,
  type EvaluationQueueEntry,
  type ExtensionSyncState,
  type SyncQueueEntry,
} from "./types";

const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const MIN_RETRY_DELAY_MS = 60 * 1_000;
const MAX_SYNCED_FINGERPRINTS = 1_000;
export const EVALUATION_POLL_INTERVAL_MS = 2_000;
const MAX_EVALUATION_RETRY_DELAY_MS = 60_000;
const MAX_EVALUATION_HISTORY = 25;

interface SyncOptions {
  fetcher?: SyncFetcher;
  baseUrl?: string;
  now?: () => Date;
}

interface FlushOptions extends SyncOptions {
  force?: boolean;
}

export async function reconcileStoredCrawlerState(
  options: Pick<SyncOptions, "now"> = {},
): Promise<ExtensionSyncState> {
  const before = await loadExtensionSyncState();
  const crawler = await loadCrawlerState();
  return updateExtensionSyncState(
    (current) => reconcileCrawlerSnapshot(current, crawler, options.now?.() ?? new Date()),
    before.generation ?? 0,
  );
}

export async function flushQueuedIngestion(options: FlushOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());
  const state = await updateExtensionSyncState((current) => current.queue.length === 0
    ? { ...current, status: "idle", lastError: undefined }
    : {
        ...current,
        status: "syncing",
        lastAttemptAt: now().toISOString(),
        queue: options.force ? current.queue.map((entry) => ({ ...entry, nextAttemptAt: 0 })) : current.queue,
      });
  if (state.queue.length === 0) return state;
  const generation = state.generation ?? 0;

  for (;;) {
    const current = await loadExtensionSyncState();
    if (current.generation !== generation) return current;
    const entry = current.queue.find((candidate) => candidate.nextAttemptAt <= now().getTime());
    if (!entry) {
      return updateExtensionSyncState((latest) => ({
        ...latest,
        status: latest.lastError ? "error" : latest.queue.length > 0 ? "pending" : "idle",
      }), generation);
    }

    try {
      await ingestRunBatch(entry.runId, entry.payload, options);
      const succeeded = await updateExtensionSyncState((latest) => {
        const stillCurrent = latest.queue.find((candidate) => candidate.key === entry.key);
        if (!stillCurrent || stillCurrent.fingerprint !== entry.fingerprint || stillCurrent.attempts !== entry.attempts) return latest;
        const queue = latest.queue.filter((candidate) => candidate.key !== entry.key);
        return {
          ...latest,
          status: queue.length === 0 ? "idle" : "syncing",
          queue,
          syncedFingerprints: trimFingerprints({ ...latest.syncedFingerprints, [entry.key]: entry.fingerprint }),
          lastSuccessAt: now().toISOString(),
          lastError: undefined,
        };
      }, generation);
      if (succeeded.queue.length === 0 || succeeded.generation !== generation) return succeeded;
    } catch (error) {
      const failure = errorMessage(error);
      return updateExtensionSyncState((latest) => {
        const stillCurrent = latest.queue.find((candidate) => candidate.key === entry.key);
        if (!stillCurrent || stillCurrent.fingerprint !== entry.fingerprint || stillCurrent.attempts !== entry.attempts) return latest;
        return {
          ...latest,
          status: "error",
          queue: latest.queue.map((candidate) => candidate.key !== entry.key ? candidate : {
            ...candidate,
            attempts: candidate.attempts + 1,
            nextAttemptAt: now().getTime() + retryDelayMs(candidate.attempts + 1),
            updatedAt: now().toISOString(),
            lastError: failure,
          }),
          lastError: failure,
        };
      }, generation);
    }
  }
}

export async function refreshActiveRecipeCache(options: SyncOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());

  try {
    const recipe = await fetchActiveRecipe(options);
    await saveRecipe(recipe);
    return updateExtensionSyncState((state) => ({
      ...state,
      activeRecipe: {
        status: "cached",
        fetchedAt: now().toISOString(),
        recipeId: recipe.id,
        recipeVersion: recipe.version,
      },
    }));
  } catch (error) {
    const failure = errorMessage(error);
    return updateExtensionSyncState((state) => ({
      ...state,
      activeRecipe: {
        ...state.activeRecipe,
        status: state.activeRecipe.recipeId ? "cached" : "unavailable",
        lastError: failure,
      },
    }));
  }
}

export async function refreshDefaultPlanCache(options: SyncOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());

  try {
    const plan = await fetchDefaultEvaluationPlan(options);
    if (!plan) {
      await clearEvaluationPlan();
      return updateExtensionSyncState((state) => ({
        ...state,
        activePlan: {
          status: "none",
          fetchedAt: now().toISOString(),
        },
      }));
    }

    await saveEvaluationPlan(plan);
    const primaryRecipe = primaryPlanRecipe(plan);
    if (primaryRecipe) await saveRecipe(primaryRecipe);
    return updateExtensionSyncState((state) => ({
      ...state,
      activePlan: {
        status: "cached",
        fetchedAt: now().toISOString(),
        planId: plan.id,
        planVersion: plan.version,
      },
      ...(primaryRecipe
        ? {
            activeRecipe: {
              status: "cached" as const,
              fetchedAt: now().toISOString(),
              recipeId: primaryRecipe.id,
              recipeVersion: primaryRecipe.version,
            },
          }
        : {}),
    }));
  } catch (error) {
    const failure = errorMessage(error);
    return updateExtensionSyncState((state) => ({
      ...state,
      activePlan: {
        ...state.activePlan,
        status: state.activePlan.planId ? "cached" : "unavailable",
        lastError: failure,
      },
    }));
  }
}

interface EnqueueEvaluationOptions extends Pick<SyncOptions, "now"> {
  runId: string;
  locale: LocaleCode;
  listingIds?: string[];
  force?: boolean;
}

export async function enqueueDefaultPlanEvaluation(
  options: EnqueueEvaluationOptions,
): Promise<EvaluationQueueEntry> {
  const now = options.now ?? (() => new Date());
  const before = await loadExtensionSyncState();
  const [plan, crawler] = await Promise.all([
    loadEvaluationPlan(),
    loadCrawlerState(),
  ]);
  if (!plan) {
    throw new ExtensionApiError("No default evaluation plan is available.", 404, "NO_DEFAULT_PLAN");
  }
  const detailedRecords = crawler.records.filter(
    (record) => record.searchRunId === options.runId && record.status === "detailed",
  );
  if (detailedRecords.length === 0) {
    throw new ExtensionApiError("No detailed listings are available for evaluation.", 400, "NO_DETAILED_LISTINGS");
  }

  const listingIds = options.listingIds && options.listingIds.length > 0
    ? [...new Set(options.listingIds)].sort()
    : undefined;
  const scope = evaluationScope({
    runId: options.runId,
    planId: plan.id,
    planVersion: plan.version,
    locale: options.locale,
    listingIds,
  });
  let entry: EvaluationQueueEntry | undefined;
  let appended = false;
  await updateExtensionSyncState((state) => {
    if (state.activePlan.status !== "cached" ||
      plan.id !== state.activePlan.planId || plan.version !== state.activePlan.planVersion) {
      throw new ExtensionApiError("No default evaluation plan is available.", 404, "NO_DEFAULT_PLAN");
    }
    if (!options.force) {
      entry = state.evaluationQueue.find((candidate) => !candidate.force && evaluationEntryScope(candidate) === scope);
      if (entry) return state;
    }
    const generation = options.force
      ? state.evaluationQueue.filter((candidate) => evaluationEntryScope(candidate) === scope).length + 1
      : 1;
    const idempotencyKey = `extension-${payloadFingerprint({ scope, force: Boolean(options.force), generation })}`;
    const createdAt = now().toISOString();
    entry = {
      key: idempotencyKey,
      idempotencyKey,
      runId: options.runId,
      planId: plan.id,
      planVersion: plan.version,
      locale: options.locale,
      ...(listingIds ? { listingIds } : {}),
      ...(options.force ? { force: true } : {}),
      status: "queued",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt,
      updatedAt: createdAt,
    };
    appended = true;
    return { ...state, status: "pending", evaluationQueue: trimEvaluationHistory([...state.evaluationQueue, entry]) };
  }, before.generation ?? 0);
  if (!entry) throw new ExtensionApiError("The local collection was cleared before evaluation could be queued.", 409, "COLLECTION_CLEARED");
  if (!appended) return entry;
  await updateCrawlerData((current) => current.run.id === options.runId ? {
    run: {
      ...current.run,
      intelligenceStatus: "evaluating",
      intelligenceError: undefined,
      message: message("run.evaluating", { count: detailedRecords.length }),
    },
  } : {});
  return entry;
}

export async function flushEvaluationQueue(options: FlushOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());
  let state = await loadExtensionSyncState();
  const generation = state.generation ?? 0;
  const activeStatuses = new Set<EvaluationQueueEntry["status"]>(["queued", "creating", "polling"]);

  for (const entry of state.evaluationQueue) {
    if (state.generation !== generation) return state;
    if (!activeStatuses.has(entry.status) || entry.nextAttemptAt > now().getTime()) continue;
    if (state.queue.some((batch) => batch.runId === entry.runId)) continue;
    state = await processEvaluationEntry(entry, { ...options, now, generation });
  }

  return updateExtensionSyncState((current) => ({
    ...current,
    status: current.queue.length > 0 || current.evaluationQueue.some((entry) => activeStatuses.has(entry.status))
      ? "pending"
      : current.status === "error"
        ? "error"
        : "idle",
  }), generation);
}

async function processEvaluationEntry(
  entry: EvaluationQueueEntry,
  options: FlushOptions & { now: () => Date; generation: number },
): Promise<ExtensionSyncState> {
  try {
    const before = await loadExtensionSyncState();
    if (!currentEvaluationAttempt(before, entry, options.generation)) return before;
    let execution: EvaluationExecution;
    if (!entry.executionId) {
      const creating = await updateEvaluationEntry(entry, (current) => ({
        ...current,
        status: "creating",
        updatedAt: options.now().toISOString(),
      }), options.generation);
      if (!currentEvaluationAttempt(creating, entry, options.generation)) return creating;
      execution = await createEvaluationExecution(
        entry.runId,
        {
          planId: entry.planId,
          planVersion: entry.planVersion,
          locale: entry.locale,
          ...(entry.listingIds ? { listingIds: entry.listingIds } : {}),
          ...(entry.force ? { force: true } : {}),
        },
        entry.idempotencyKey,
        options,
      );
    } else {
      execution = (await fetchEvaluationExecution(entry.executionId, options)).execution;
    }
    const latest = await loadExtensionSyncState();
    if (!currentEvaluationAttempt(latest, entry, options.generation)) return latest;

    if (execution.status === "queued" || execution.status === "running") {
      return updateEvaluationEntry(entry, (current) => ({
        ...current,
        status: "polling",
        executionId: execution.id,
        nextAttemptAt: options.now().getTime() + EVALUATION_POLL_INTERVAL_MS,
        updatedAt: options.now().toISOString(),
        lastError: undefined,
      }), options.generation);
    }
    if (execution.status === "completed" || execution.status === "partial" || execution.status === "failed") {
      const detail = await fetchEvaluationExecutionResults(execution.id, options);
      const current = await loadExtensionSyncState();
      if (!currentEvaluationAttempt(current, entry, options.generation)) return current;
      if (detail.items.length > 0) {
        await applyPlanEvaluationResults(entry, detail.execution, detail.items);
      } else if (execution.status === "failed") {
        await markPlanEvaluationFailure(entry, execution.error ?? "Evaluation execution failed.");
      }
      return updateEvaluationEntry(entry, (current) => ({
        ...current,
        status: execution.status === "failed" ? "failed" : "completed",
        executionId: execution.id,
        nextAttemptAt: 0,
        updatedAt: options.now().toISOString(),
        lastError: execution.status === "completed" ? undefined : execution.error,
      }), options.generation);
    }

    await markPlanEvaluationFailure(entry, execution.error ?? `Execution ${execution.status}.`);
    return updateEvaluationEntry(entry, (current) => ({
      ...current,
      status: execution.status === "cancelled" ? "cancelled" : "failed",
      executionId: execution.id,
      nextAttemptAt: 0,
      updatedAt: options.now().toISOString(),
      lastError: execution.error ?? `Execution ${execution.status}.`,
    }), options.generation);
  } catch (error) {
    const retryable = isRetryableEvaluationError(error);
    const failure = errorMessage(error);
    let recordedFailure = false;
    const state = await updateEvaluationEntry(entry, (current) => {
      recordedFailure = true;
      const attempts = current.attempts + 1;
      return {
        ...current,
        status: retryable ? (current.executionId ? "polling" : "queued") : "failed",
        attempts,
        nextAttemptAt: retryable
          ? options.now().getTime() + evaluationRetryDelayMs(attempts)
          : 0,
        updatedAt: options.now().toISOString(),
        lastError: failure,
      };
    }, options.generation);
    if (!retryable && recordedFailure) await markPlanEvaluationFailure(entry, failure);
    return state;
  }
}

async function applyPlanEvaluationResults(
  entry: EvaluationQueueEntry,
  execution: EvaluationExecution,
  items: Awaited<ReturnType<typeof fetchEvaluationExecutionResults>>["items"],
): Promise<void> {
  const byListingId = new Map(items.map((item) => [item.listingId, item]));
  await updateCrawlerData((crawler) => {
    const records = crawler.records.map((record) => {
      if (record.searchRunId !== entry.runId) return record;
      const planEvaluation = byListingId.get(record.id);
      return planEvaluation ? { ...record, planEvaluation } : record;
    });
    if (crawler.run.id !== entry.runId) return { records };

    const evaluated = records.flatMap((record) =>
      record.searchRunId === entry.runId && record.planEvaluation?.executionId === execution.id
        ? [record.planEvaluation]
        : []);
    const scopedDetailed = records.filter(
      (record) => record.searchRunId === entry.runId && record.status === "detailed",
    );
    const intelligenceStatus = execution.status !== "completed" || evaluated.length < scopedDetailed.length
      ? "partial" as const
      : "completed" as const;
    return {
      records,
      run: {
        ...crawler.run,
        intelligenceStatus,
        intelligenceError: execution.error
          ? errorMessageDescriptor("error.intelligenceFailed", execution.error)
          : undefined,
        evaluated: evaluated.length,
        relevant: evaluated.filter((item) => item.decision === "relevant").length,
        notRelevant: evaluated.filter((item) => item.decision === "not-relevant").length,
        review: evaluated.filter((item) => item.decision === "review").length,
        message: intelligenceStatus === "completed"
          ? message("run.evaluated", { count: evaluated.length })
          : message("run.intelligencePartial", {
              evaluated: evaluated.length,
              pending: Math.max(0, scopedDetailed.length - evaluated.length),
              total: scopedDetailed.length,
            }),
      },
    };
  });
}

async function markPlanEvaluationFailure(entry: EvaluationQueueEntry, failure: string): Promise<void> {
  await updateCrawlerData((crawler) => crawler.run.id !== entry.runId ? {} : {
    run: {
      ...crawler.run,
      intelligenceStatus: "failed",
      intelligenceError: errorMessageDescriptor("error.intelligenceFailed", failure),
      message: message("run.intelligenceFailedPreserved"),
    },
  });
}

async function updateEvaluationEntry(
  expected: EvaluationQueueEntry,
  update: (entry: EvaluationQueueEntry) => EvaluationQueueEntry,
  generation: number,
): Promise<ExtensionSyncState> {
  return updateExtensionSyncState((state) => {
    const current = currentEvaluationAttempt(state, expected, generation);
    if (!current) return state;
    return {
      ...state,
      evaluationQueue: state.evaluationQueue.map((entry) => entry === current ? update(entry) : entry),
    };
  }, generation);
}

function currentEvaluationAttempt(
  state: ExtensionSyncState,
  expected: EvaluationQueueEntry,
  generation: number,
): EvaluationQueueEntry | undefined {
  if (state.generation !== generation) return undefined;
  return state.evaluationQueue.find((entry) => entry.key === expected.key &&
    entry.attempts === expected.attempts && entry.executionId === expected.executionId &&
    (entry.status === "queued" || entry.status === "creating" || entry.status === "polling"));
}

export async function synchronizeExtension(options: FlushOptions = {}): Promise<ExtensionSyncState> {
  await reconcileStoredCrawlerState(options);
  await refreshDefaultPlanCache(options);
  await flushQueuedIngestion(options);
  return flushEvaluationQueue(options);
}

export function reconcileCrawlerSnapshot(
  state: ExtensionSyncState,
  crawler: StoredCrawlerState,
  now: Date,
): ExtensionSyncState {
  const desired = buildQueueEntries(crawler, now);
  const desiredKeys = new Set(desired.map((entry) => entry.key));
  const existingByKey = new Map(state.queue.map((entry) => [entry.key, entry]));
  const queuedSnapshotsNoLongerInLocalRecords = state.queue.filter(
    (entry) => !desiredKeys.has(entry.key),
  );
  const queue = [...queuedSnapshotsNoLongerInLocalRecords, ...desired.flatMap((candidate) => {
    if (state.syncedFingerprints[candidate.key] === candidate.fingerprint) return [];
    const existing = existingByKey.get(candidate.key);
    return [existing?.fingerprint === candidate.fingerprint ? existing : candidate];
  })];
  const syncedFingerprints = Object.fromEntries(
    Object.entries(state.syncedFingerprints).filter(([key]) => desiredKeys.has(key)),
  );

  return {
    ...state,
    status: queue.length === 0 ? "idle" : state.status === "syncing" ? "syncing" : "pending",
    queue,
    syncedFingerprints,
    ...(queue.length === 0 ? { lastError: undefined } : {}),
  };
}

export function buildQueueEntries(crawler: StoredCrawlerState, now: Date): SyncQueueEntry[] {
  const recordsByRun = new Map<string, ScrapedPropertyRecord[]>();
  for (const record of crawler.records) {
    const records = recordsByRun.get(record.searchRunId) ?? [];
    records.push(record);
    recordsByRun.set(record.searchRunId, records);
  }

  const runIds = new Set(recordsByRun.keys());
  if (crawler.run.id !== "idle") runIds.add(crawler.run.id);
  const createdAt = now.toISOString();
  const entries: SyncQueueEntry[] = [];

  for (const runId of [...runIds].sort()) {
    const records = deduplicateRunRecords(recordsByRun.get(runId) ?? [])
      .sort((left, right) => left.id.localeCompare(right.id));
    const run = runId === crawler.run.id
      ? toRunIngestion(crawler.run)
      : legacyRun(runId, records);
    const batches = records.length === 0
      ? [[]]
      : chunk(records, INGESTION_BATCH_SIZE);

    batches.forEach((batch, index) => {
      const request = ingestionRequestSchema.parse({
        run,
        listings: batch.flatMap((record) => {
          const listing = toListingIngestion(record);
          return listing ? [listing] : [];
        }),
      } satisfies IngestionRequest);
      const key = `${runId}:batch:${index + 1}`;
      const fingerprint = payloadFingerprint(request);
      entries.push({
        key,
        runId,
        fingerprint,
        payload: request,
        attempts: 0,
        nextAttemptAt: 0,
        createdAt,
        updatedAt: createdAt,
      });
    });
  }

  return entries;
}

function deduplicateRunRecords(records: ScrapedPropertyRecord[]): ScrapedPropertyRecord[] {
  const statusRank: Record<ScrapedPropertyRecord["status"], number> = {
    failed: 0,
    listing: 1,
    detailed: 2,
  };
  const byIdentity = new Map<string, ScrapedPropertyRecord>();
  for (const record of records) {
    const key = `${record.source}:${record.id}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, record);
      continue;
    }

    const preferred = statusRank[record.status] > statusRank[existing.status] ||
      (statusRank[record.status] === statusRank[existing.status] && record.scrapedAt > existing.scrapedAt)
      ? record
      : existing;
    const coordinates = selectBestCoordinates(existing.coordinates, record.coordinates);
    byIdentity.set(key, {
      ...preferred,
      ...(coordinates ? { coordinates } : { coordinates: undefined }),
    });
  }
  return [...byIdentity.values()];
}

function toRunIngestion(run: ScrapeRun): RunIngestion {
  return runIngestionSchema.parse({
    id: run.id,
    source: "leboncoin",
    status: run.status,
    startedAt: validDate(run.startedAt),
    finishedAt: validDate(run.finishedAt),
    searchUrl: validHttpsUrl(run.searchUrl),
    target: nonNegativeInteger(run.target),
    found: nonNegativeInteger(run.found),
    pagesVisited: nonNegativeInteger(run.pagesVisited),
    collected: nonNegativeInteger(run.collected),
    currentUrl: validHttpsUrl(run.currentUrl),
    message: optionalText(run.message ? localizedTextDetail(run.message) : undefined, 2_000),
    error: optionalText(run.error ? localizedTextDetail(run.error) : undefined, 2_000),
    intelligenceStatus: run.intelligenceStatus,
    intelligenceError: optionalText(
      run.intelligenceError ? localizedTextDetail(run.intelligenceError) : undefined,
      2_000,
    ),
    evaluated: nonNegativeInteger(run.evaluated),
    relevant: nonNegativeInteger(run.relevant),
    notRelevant: nonNegativeInteger(run.notRelevant),
    review: nonNegativeInteger(run.review),
  });
}

function legacyRun(runId: string, records: ScrapedPropertyRecord[]): RunIngestion {
  const timestamps = records.map((record) => record.scrapedAt).filter(isValidDate).sort();
  return runIngestionSchema.parse({
    id: runId,
    source: "leboncoin",
    status: "legacy-import",
    startedAt: timestamps[0],
    finishedAt: timestamps.at(-1),
    target: records.length,
    found: records.length,
    pagesVisited: 0,
    collected: records.length,
    evaluated: records.filter((record) => record.planEvaluation ?? record.evaluation).length,
    relevant: records.filter((record) => (record.planEvaluation ?? record.evaluation)?.decision === "relevant").length,
    notRelevant: records.filter((record) => (record.planEvaluation ?? record.evaluation)?.decision === "not-relevant").length,
    review: records.filter((record) => (record.planEvaluation ?? record.evaluation)?.decision === "review").length,
  });
}

function toListingIngestion(record: ScrapedPropertyRecord): ListingIngestion | undefined {
  const coordinates = normalizeVerifiedCoordinates(record.coordinates);
  const candidate = {
    source: record.source,
    externalId: optionalText(record.id, 128),
    url: validHttpsUrl(record.listingUrl),
    title: optionalText(record.title, 300),
    priceText: optionalText(record.priceText, 120),
    priceEuros: nonNegativeNumber(record.priceEuros, 1_000_000_000),
    pricePerSquareMeterText: optionalText(record.pricePerSquareMeterText, 120),
    propertyType: optionalText(record.propertyType, 120),
    rooms: boundedCount(record.rooms),
    bedrooms: boundedCount(record.bedrooms),
    surfaceM2: nonNegativeNumber(record.surfaceM2, 10_000_000),
    landSurfaceM2: nonNegativeNumber(record.landSurfaceM2, 100_000_000),
    location: optionalText(record.location, 300),
    ...(coordinates ? { coordinates } : {}),
    sellerName: optionalText(record.sellerName, 300),
    sellerType: optionalText(record.sellerType, 120),
    postedAt: optionalText(record.postedAt, 160),
    description: optionalText(record.description, 20_000),
    energyClass: optionalText(record.energyClass, 20),
    gesClass: optionalText(record.gesClass, 20),
    imageUrl: validHttpsUrl(record.imageUrl),
    imageUrls: normalizedUrls(record.imageUrls),
    features: normalizedFeatures(record.features),
    status: record.status,
    scrapedAt: validDate(record.scrapedAt),
    error: optionalText(record.error ? localizedTextDetail(record.error) : undefined, 2_000),
    rawTextSample: optionalText(record.rawTextSample, 10_000),
  };
  const parsed = listingIngestionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function normalizedUrls(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const urls = [...new Set(values.map(validHttpsUrl).filter((value): value is string => Boolean(value)))].slice(0, 50);
  return urls.length > 0 ? urls : undefined;
}

function normalizedFeatures(values: string[]): string[] | undefined {
  const features = [...new Set(values.map((value) => optionalText(value, 160)).filter(
    (value): value is string => Boolean(value),
  ))].slice(0, 100);
  return features.length > 0 ? features : undefined;
}

function payloadFingerprint(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function evaluationScope(value: {
  runId: string;
  planId: string;
  planVersion: number;
  locale: LocaleCode;
  listingIds?: string[];
}): string {
  return JSON.stringify({
    runId: value.runId,
    planId: value.planId,
    planVersion: value.planVersion,
    locale: value.locale,
    listingIds: value.listingIds ?? null,
  });
}

function evaluationEntryScope(entry: EvaluationQueueEntry): string {
  return evaluationScope(entry);
}

function trimEvaluationHistory(entries: EvaluationQueueEntry[]): EvaluationQueueEntry[] {
  const active = entries.filter((entry) =>
    entry.status === "queued" || entry.status === "creating" || entry.status === "polling");
  const terminal = entries.filter((entry) =>
    entry.status !== "queued" && entry.status !== "creating" && entry.status !== "polling");
  return [...terminal.slice(-MAX_EVALUATION_HISTORY), ...active];
}

function evaluationRetryDelayMs(attempts: number): number {
  return Math.min(MAX_EVALUATION_RETRY_DELAY_MS, EVALUATION_POLL_INTERVAL_MS * 2 ** Math.max(0, attempts - 1));
}

function isRetryableEvaluationError(error: unknown): boolean {
  return !(error instanceof ExtensionApiError) ||
    error.status === undefined ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500;
}

function chunk<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size));
}

function trimFingerprints(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).slice(-MAX_SYNCED_FINGERPRINTS));
}

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maximum);
  return normalized || undefined;
}

function validHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const normalized = value.trim();
    const url = new URL(normalized);
    return url.protocol === "https:" && normalized.length <= 2_048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function validDate(value: unknown): string | undefined {
  return typeof value === "string" && isValidDate(value) ? value : undefined;
}

function isValidDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  const parsed = nonNegativeInteger(value);
  return parsed !== undefined && parsed <= 100 ? parsed : undefined;
}

function nonNegativeNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
