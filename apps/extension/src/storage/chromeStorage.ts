import { createDefaultSearchFilters, normalizeSearchFilters } from "../lib/leboncoinSearch";
import type { ScrapeRun, ScrapedPropertyRecord, SearchFilters, StoredCrawlerState } from "../lib/types";

const FILTERS_KEY = "denicheur:crawler:filters";
const RUN_KEY = "denicheur:crawler:run";
const RECORDS_KEY = "denicheur:crawler:records";
const INTERRUPTIBLE_RUN_STATUSES = new Set<ScrapeRun["status"]>([
  "opening-search",
  "collecting-search",
  "collecting-details",
  "paused-captcha",
]);

export const IDLE_RUN: ScrapeRun = {
  id: "idle",
  status: "idle",
  target: 20,
  found: 0,
  collected: 0,
};

export async function loadCrawlerState(): Promise<StoredCrawlerState> {
  const values = await getStorage<{
    [FILTERS_KEY]?: SearchFilters;
    [RUN_KEY]?: ScrapeRun;
    [RECORDS_KEY]?: ScrapedPropertyRecord[];
  }>([FILTERS_KEY, RUN_KEY, RECORDS_KEY]);

  return {
    filters: normalizeSearchFilters(values[FILTERS_KEY] ?? createDefaultSearchFilters()),
    run: values[RUN_KEY] ?? IDLE_RUN,
    records: values[RECORDS_KEY] ?? [],
  };
}

export async function saveFilters(filters: SearchFilters): Promise<void> {
  await setStorage({ [FILTERS_KEY]: filters });
}

export async function saveRun(run: ScrapeRun): Promise<void> {
  await setStorage({ [RUN_KEY]: run });
}

export function reconcileInterruptedRun(run: ScrapeRun, finishedAt = new Date().toISOString()): ScrapeRun {
  if (!INTERRUPTIBLE_RUN_STATUSES.has(run.status)) return run;

  return {
    ...run,
    status: "failed",
    finishedAt,
    error: "The dashboard closed before the crawl finished.",
    message: "Previous crawl was interrupted. Start a new crawl to continue.",
  };
}

export async function saveCrawlerState(state: Partial<StoredCrawlerState>): Promise<void> {
  const patch: Record<string, unknown> = {};

  if (state.filters) {
    patch[FILTERS_KEY] = state.filters;
  }

  if (state.run) {
    patch[RUN_KEY] = state.run;
  }

  if (state.records) {
    patch[RECORDS_KEY] = state.records;
  }

  await setStorage(patch);
}

export async function clearRecords(): Promise<void> {
  await setStorage({ [RECORDS_KEY]: [], [RUN_KEY]: IDLE_RUN });
}

export function isCrawlerStorageKey(key: string): boolean {
  return key === FILTERS_KEY || key === RUN_KEY || key === RECORDS_KEY;
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
