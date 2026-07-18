import {
  ingestionRequestSchema,
  listingIngestionSchema,
  runIngestionSchema,
  type IngestionRequest,
  type ListingIngestion,
  type RunIngestion,
} from "@denicheur-breizh/contracts";
import { localizedTextDetail } from "../lib/localizedText";
import {
  normalizeVerifiedCoordinates,
  selectBestCoordinates,
} from "../lib/coordinates";
import type {
  ScrapeRun,
  ScrapedPropertyRecord,
  StoredCrawlerState,
} from "../lib/types";
import { loadCrawlerState, saveRecipe } from "../storage/chromeStorage";
import { fetchActiveRecipe, ingestRunBatch, type SyncFetcher } from "./api";
import {
  loadExtensionSyncState,
  saveExtensionSyncState,
} from "./storage";
import {
  INGESTION_BATCH_SIZE,
  type ExtensionSyncState,
  type SyncQueueEntry,
} from "./types";

const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const MIN_RETRY_DELAY_MS = 60 * 1_000;
const MAX_SYNCED_FINGERPRINTS = 1_000;

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
  const [crawler, state] = await Promise.all([
    loadCrawlerState(),
    loadExtensionSyncState(),
  ]);
  const next = reconcileCrawlerSnapshot(state, crawler, options.now?.() ?? new Date());
  await saveExtensionSyncState(next);
  return next;
}

export async function flushQueuedIngestion(options: FlushOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());
  let state = await loadExtensionSyncState();

  if (state.queue.length === 0) {
    const idle = { ...state, status: "idle" as const, lastError: undefined };
    await saveExtensionSyncState(idle);
    return idle;
  }

  state = {
    ...state,
    status: "syncing",
    lastAttemptAt: now().toISOString(),
    queue: options.force
      ? state.queue.map((entry) => ({ ...entry, nextAttemptAt: 0 }))
      : state.queue,
  };
  await saveExtensionSyncState(state);

  for (;;) {
    const current = await loadExtensionSyncState();
    const entry = current.queue.find((candidate) => candidate.nextAttemptAt <= now().getTime());
    if (!entry) {
      const pending = {
        ...current,
        status: current.lastError ? "error" as const : "pending" as const,
      };
      await saveExtensionSyncState(pending);
      return pending;
    }

    try {
      await ingestRunBatch(entry.runId, entry.payload, options);
      const latest = await loadExtensionSyncState();
      const stillCurrent = latest.queue.find((candidate) => candidate.key === entry.key);
      const queue = stillCurrent?.fingerprint === entry.fingerprint
        ? latest.queue.filter((candidate) => candidate.key !== entry.key)
        : latest.queue;
      const syncedFingerprints = trimFingerprints({
        ...latest.syncedFingerprints,
        [entry.key]: entry.fingerprint,
      });
      const succeeded: ExtensionSyncState = {
        ...latest,
        status: queue.length === 0 ? "idle" : "syncing",
        queue,
        syncedFingerprints,
        lastSuccessAt: now().toISOString(),
        lastError: undefined,
      };
      await saveExtensionSyncState(succeeded);
      if (queue.length === 0) return succeeded;
    } catch (error) {
      const latest = await loadExtensionSyncState();
      const failure = errorMessage(error);
      const queue = latest.queue.map((candidate) => {
        if (candidate.key !== entry.key || candidate.fingerprint !== entry.fingerprint) return candidate;
        const attempts = candidate.attempts + 1;
        return {
          ...candidate,
          attempts,
          nextAttemptAt: now().getTime() + retryDelayMs(attempts),
          updatedAt: now().toISOString(),
          lastError: failure,
        };
      });
      const failed: ExtensionSyncState = {
        ...latest,
        status: "error",
        queue,
        lastError: failure,
      };
      await saveExtensionSyncState(failed);
      return failed;
    }
  }
}

export async function refreshActiveRecipeCache(options: SyncOptions = {}): Promise<ExtensionSyncState> {
  const now = options.now ?? (() => new Date());

  try {
    const recipe = await fetchActiveRecipe(options);
    await saveRecipe(recipe);
    const state = await loadExtensionSyncState();
    const next: ExtensionSyncState = {
      ...state,
      activeRecipe: {
        status: "cached",
        fetchedAt: now().toISOString(),
        recipeId: recipe.id,
        recipeVersion: recipe.version,
      },
    };
    await saveExtensionSyncState(next);
    return next;
  } catch (error) {
    const failure = errorMessage(error);
    const state = await loadExtensionSyncState();
    const next: ExtensionSyncState = {
      ...state,
      activeRecipe: {
        ...state.activeRecipe,
        status: state.activeRecipe.recipeId ? "cached" : "unavailable",
        lastError: failure,
      },
    };
    await saveExtensionSyncState(next);
    return next;
  }
}

export async function synchronizeExtension(options: FlushOptions = {}): Promise<ExtensionSyncState> {
  await reconcileStoredCrawlerState(options);
  await refreshActiveRecipeCache(options);
  return flushQueuedIngestion(options);
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
    evaluated: records.filter((record) => record.evaluation).length,
    relevant: records.filter((record) => record.evaluation?.decision === "relevant").length,
    notRelevant: records.filter((record) => record.evaluation?.decision === "not-relevant").length,
    review: records.filter((record) => record.evaluation?.decision === "review").length,
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

function payloadFingerprint(payload: IngestionRequest): string {
  const serialized = JSON.stringify(payload);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
