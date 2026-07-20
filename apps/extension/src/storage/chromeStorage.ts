import {
  createDefaultSearchFilters,
  migrateStoredSearchFilters,
  normalizeSearchFilters,
} from "../lib/leboncoinSearch";
import { createDefaultIntelligenceRecipe, normalizeIntelligenceRecipe } from "../intelligence/recipe";
import { parseResolvedEvaluationPlan } from "../intelligence/plan";
import {
  normalizeVerifiedCoordinates,
  selectBestCoordinates,
} from "../lib/coordinates";
import { listingIdFromUrl, normalizeListingUrl } from "../lib/leboncoinExtractors";
import { message } from "../lib/localizedText";
import {
  EMPTY_SYNC_STATE,
  loadExtensionSyncState,
  SYNC_STORAGE_KEY,
} from "../sync/storage";
import type {
  IntelligenceRecipe,
  EvaluationPlan,
  ListingEvaluationFailure,
  LocalizedText,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
  StoredCrawlerState,
} from "../lib/types";

export const CRAWLER_STORAGE_KEYS = {
  filters: "denicheur:crawler:filters",
  run: "denicheur:crawler:run",
  records: "denicheur:crawler:records",
  recipe: "denicheur:intelligence:recipe",
  plan: "denicheur:intelligence:plan",
} as const;

const FILTERS_KEY = CRAWLER_STORAGE_KEYS.filters;
const RUN_KEY = CRAWLER_STORAGE_KEYS.run;
const RECORDS_KEY = CRAWLER_STORAGE_KEYS.records;
const RECIPE_KEY = CRAWLER_STORAGE_KEYS.recipe;
const PLAN_KEY = CRAWLER_STORAGE_KEYS.plan;
const INTERRUPTIBLE_RUN_STATUSES = new Set<ScrapeRun["status"]>([
  "opening-search",
  "configuring-search",
  "collecting-search",
  "collecting-details",
  "evaluating",
  "paused-captcha",
]);

export const IDLE_RUN: ScrapeRun = {
  id: "idle",
  status: "idle",
  target: 20,
  found: 0,
  pagesVisited: 0,
  collected: 0,
  evaluated: 0,
  relevant: 0,
  notRelevant: 0,
  review: 0,
  filterWarnings: [],
  intelligenceStatus: "idle",
};

export async function loadCrawlerState(): Promise<StoredCrawlerState> {
  const values = await getStorage<{
    [FILTERS_KEY]?: unknown;
    [RUN_KEY]?: ScrapeRun;
    [RECORDS_KEY]?: ScrapedPropertyRecord[];
    [RECIPE_KEY]?: IntelligenceRecipe;
  }>([FILTERS_KEY, RUN_KEY, RECORDS_KEY, RECIPE_KEY]);

  const storedFilters = values[FILTERS_KEY];
  const filters = storedFilters === undefined
    ? createDefaultSearchFilters()
    : migrateStoredSearchFilters(storedFilters);

  const storedRecords = values[RECORDS_KEY] ?? [];
  const records = migrateStoredRecords(storedRecords);
  const migrationPatch: Record<string, unknown> = {};
  if (storedFilters !== undefined && needsStoredFilterMigration(storedFilters)) {
    migrationPatch[FILTERS_KEY] = filters;
  }
  if (JSON.stringify(storedRecords) !== JSON.stringify(records)) {
    migrationPatch[RECORDS_KEY] = records;
  }
  if (Object.keys(migrationPatch).length > 0) await setStorage(migrationPatch);

  return {
    filters,
    recipe: normalizeIntelligenceRecipe(values[RECIPE_KEY] ?? createDefaultIntelligenceRecipe()),
    run: normalizeRun(values[RUN_KEY]),
    records,
  };
}

export async function saveFilters(filters: SearchFilters): Promise<void> {
  await setStorage({ [FILTERS_KEY]: normalizeSearchFilters(filters) });
}

export async function saveRun(run: ScrapeRun): Promise<void> {
  await setStorage({ [RUN_KEY]: run });
}

export async function saveRecipe(recipe: IntelligenceRecipe): Promise<void> {
  await setStorage({ [RECIPE_KEY]: normalizeIntelligenceRecipe(recipe) });
}

export async function loadEvaluationPlan(): Promise<EvaluationPlan | undefined> {
  const values = await getStorage<{ [PLAN_KEY]?: unknown }>([PLAN_KEY]);
  return parseResolvedEvaluationPlan(values[PLAN_KEY]);
}

export async function saveEvaluationPlan(plan: EvaluationPlan): Promise<void> {
  await setStorage({ [PLAN_KEY]: plan });
}

export async function clearEvaluationPlan(): Promise<void> {
  await removeStorage([PLAN_KEY]);
}

export function reconcileInterruptedRun(run: ScrapeRun, finishedAt = new Date().toISOString()): ScrapeRun {
  if (!INTERRUPTIBLE_RUN_STATUSES.has(run.status)) return run;

  return {
    ...run,
    status: "cancelled",
    finishedAt,
    error: undefined,
    message: message("run.interrupted"),
    ...(run.intelligenceStatus === "evaluating"
      ? {
          intelligenceStatus: "failed" as const,
          intelligenceError: message("error.interruptedEvaluation"),
        }
      : {}),
  };
}

export async function saveCrawlerState(state: Partial<StoredCrawlerState>): Promise<void> {
  const patch: Record<string, unknown> = {};

  if (state.filters) {
    patch[FILTERS_KEY] = normalizeSearchFilters(state.filters);
  }

  if (state.recipe) {
    patch[RECIPE_KEY] = normalizeIntelligenceRecipe(state.recipe);
  }

  if (state.run) {
    patch[RUN_KEY] = state.run;
  }

  if (state.records) {
    patch[RECORDS_KEY] = migrateStoredRecords(state.records);
  }

  await setStorage(patch);
}

export async function clearRecords(): Promise<void> {
  await setStorage({ [RECORDS_KEY]: [], [RUN_KEY]: IDLE_RUN });
}

export async function clearRecordsAndSyncQueue(): Promise<void> {
  const syncState = await loadExtensionSyncState();
  await setStorage({
    [RECORDS_KEY]: [],
    [RUN_KEY]: IDLE_RUN,
    [SYNC_STORAGE_KEY]: {
      ...structuredClone(EMPTY_SYNC_STATE),
      activePlan: syncState.activePlan,
      activeRecipe: syncState.activeRecipe,
    },
  });
}

export function isCrawlerStorageKey(key: string): boolean {
  return key === FILTERS_KEY || key === RUN_KEY || key === RECORDS_KEY || key === RECIPE_KEY;
}

function normalizeRun(run: ScrapeRun | undefined): ScrapeRun {
  return {
    ...IDLE_RUN,
    ...run,
    pagesVisited: run?.pagesVisited ?? 0,
    evaluated: run?.evaluated ?? 0,
    relevant: run?.relevant ?? 0,
    notRelevant: run?.notRelevant ?? 0,
    review: run?.review ?? 0,
    filterWarnings: normalizeFilterWarnings(run?.filterWarnings),
    intelligenceStatus: run?.intelligenceStatus ?? "idle",
    message: normalizeLocalizedText(run?.message),
    error: normalizeLocalizedText(run?.error),
    intelligenceError: normalizeLocalizedText(run?.intelligenceError),
  };
}

function needsStoredFilterMigration(value: unknown): boolean {
  return (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("locationQuery" in value) ||
    "rawSearchUrl" in value ||
    "locationToken" in value ||
    "closeDetailTabs" in value
  );
}

function normalizeFilterWarnings(value: unknown): ScrapeRun["filterWarnings"] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((warning) => {
    if (
      typeof warning !== "object" ||
      warning === null ||
      !("field" in warning) ||
      !("message" in warning) ||
      typeof warning.field !== "string"
    ) {
      return [];
    }

    const message = normalizeLocalizedText(warning.message);
    return message ? [{ field: warning.field, message }] : [];
  });
}

function normalizeLocalizedText(value: unknown): LocalizedText | undefined {
  if (typeof value === "string" && value.trim()) {
    return { id: "legacy.message", technicalDetail: value };
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.trim()
  ) {
    const values = "values" in value && isMessageValues(value.values) ? value.values : undefined;
    const technicalDetail =
      "technicalDetail" in value && typeof value.technicalDetail === "string"
        ? value.technicalDetail
        : undefined;
    return {
      id: value.id,
      ...(values ? { values } : {}),
      ...(technicalDetail ? { technicalDetail } : {}),
    };
  }

  return undefined;
}

function isMessageValues(value: unknown): value is Record<string, string | number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string" || typeof item === "number")
  );
}

export function migrateStoredRecords(records: ScrapedPropertyRecord[]): ScrapedPropertyRecord[] {
  const byListingId = new Map<string, ScrapedPropertyRecord>();

  for (const record of records) {
    const canonicalUrl = normalizeListingUrl(record.listingUrl) ?? record.listingUrl;
    const id = listingIdFromUrl(canonicalUrl) ?? record.id.trim();
    if (!id) continue;

    const evaluation = record.evaluation?.listingId === id ? record.evaluation : undefined;
    const planEvaluation = record.planEvaluation?.listingId === id ? record.planEvaluation : undefined;
    const evaluationFailure = normalizeEvaluationFailure(record.evaluationFailure, id);
    const {
      coordinates: storedCoordinates,
      evaluationFailure: _storedEvaluationFailure,
      planEvaluation: _storedPlanEvaluation,
      ...recordWithoutCoordinates
    } = record;
    const coordinates = normalizeVerifiedCoordinates(storedCoordinates);
    const candidate: ScrapedPropertyRecord = {
      ...recordWithoutCoordinates,
      id,
      listingUrl: canonicalUrl,
      evaluation,
      ...(planEvaluation ? { planEvaluation } : {}),
      ...(evaluationFailure ? { evaluationFailure } : {}),
      error: normalizeLocalizedText(record.error),
      ...(coordinates ? { coordinates } : {}),
    };
    const existing = byListingId.get(id);
    const preferred = existing ? preferMigratedRecord(existing, candidate) : candidate;
    const preferredCoordinates = selectBestCoordinates(existing?.coordinates, candidate.coordinates);
    const imageUrls = Array.from(new Set([
      ...(preferred.imageUrls ?? []),
      ...(preferred.imageUrl ? [preferred.imageUrl] : []),
    ]));
    byListingId.set(id, {
      ...preferred,
      imageUrl: imageUrls[0],
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      ...(preferredCoordinates ? { coordinates: preferredCoordinates } : {}),
    });
  }

  return [...byListingId.values()];
}

function normalizeEvaluationFailure(
  value: unknown,
  listingId: string,
): ListingEvaluationFailure | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("listingId" in value) ||
    value.listingId !== listingId ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !value.code.trim() ||
    !("stage" in value) ||
    typeof value.stage !== "string" ||
    !value.stage.trim() ||
    !("retryable" in value) ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined;
  }

  const requestId = "requestId" in value && typeof value.requestId === "string" && value.requestId.trim()
    ? value.requestId
    : undefined;
  const attemptId = "attemptId" in value && typeof value.attemptId === "string" && value.attemptId.trim()
    ? value.attemptId
    : undefined;
  const criterionId = "criterionId" in value && typeof value.criterionId === "string" && value.criterionId.trim()
    ? value.criterionId
    : undefined;
  return {
    listingId,
    code: value.code,
    stage: value.stage,
    retryable: value.retryable,
    ...(requestId ? { requestId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(criterionId ? { criterionId } : {}),
  };
}

function preferMigratedRecord(
  existing: ScrapedPropertyRecord,
  incoming: ScrapedPropertyRecord,
): ScrapedPropertyRecord {
  const rank = { failed: 0, listing: 1, detailed: 2 } as const;
  const existingRank = rank[existing.status];
  const incomingRank = rank[incoming.status];

  if (incomingRank !== existingRank) {
    return incomingRank > existingRank ? incoming : existing;
  }

  return incoming.scrapedAt > existing.scrapedAt ? incoming : existing;
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

function removeStorage(keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}
