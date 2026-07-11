import { buildLeboncoinSearchUrl, normalizeSearchFilters } from "../lib/leboncoinSearch";
import type { ContentRequest, ContentResponse } from "../lib/messages";
import type {
  ListingDetail,
  ListingSummary,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
} from "../lib/types";
import { loadCrawlerState, saveCrawlerState } from "../storage/chromeStorage";

type RunnerObserver = (snapshot: { run: ScrapeRun; records: ScrapedPropertyRecord[] }) => void;

const SEARCH_SETTLE_MS = 1600;
const DETAIL_SETTLE_MS = 1200;
const MAX_STORED_RECORDS = 500;

interface RunTiming {
  minDelayMs: number;
  maxDelayMs: number;
  pauseAfterDetails: number;
  cooldownMs: number;
}

class ActivityBlockError extends Error {
  constructor() {
    super("Unusual activity block detected.");
  }
}

export class ScrapeRunner {
  private cancelled = false;
  private abortController = new AbortController();
  private lastPersistedFilters: SearchFilters | undefined;
  private lastPersistedRecords: ScrapedPropertyRecord[] | undefined;
  private resumeWaiter: (() => void) | undefined;

  constructor(private readonly observer: RunnerObserver) {}

  get paused(): boolean {
    return Boolean(this.resumeWaiter);
  }

  resume(): void {
    this.resumeWaiter?.();
    this.resumeWaiter = undefined;
  }

  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
    this.resume();
  }

  async run(filters: SearchFilters): Promise<void> {
    this.cancelled = false;
    this.abortController = new AbortController();
    this.lastPersistedFilters = undefined;
    this.lastPersistedRecords = undefined;
    const safeFilters = normalizeSearchFilters(filters);
    const timing = getRunTiming(safeFilters);
    const target = safeFilters.maxListings;
    const startedAt = new Date().toISOString();
    let records = (await loadCrawlerState()).records;
    const run: ScrapeRun = {
      id: `run-${Date.now()}`,
      status: "opening-search",
      startedAt,
      searchUrl: buildLeboncoinSearchUrl(safeFilters),
      target,
      found: 0,
      collected: 0,
      message: "Opening leboncoin search.",
    };

    await this.persist(run, records, safeFilters);

    let searchTabId: number | undefined;

    try {
      const searchTab = await createTab({ url: run.searchUrl, active: true });
      searchTabId = searchTab.id;

      if (searchTabId === undefined) {
        throw new Error("Chrome did not return a tab id for the search page.");
      }

      run.status = "collecting-search";
      run.currentUrl = run.searchUrl;
      run.message = "Collecting search results.";
      await this.persist(run, records, safeFilters);

      const listings = (await this.collectSearchResults(searchTabId, run, records, safeFilters)).slice(0, target);
      run.found = listings.length;
      records = mergeRecords(records, listings.map((listing) => recordFromSummary(listing, run.id)));
      run.collected = safeFilters.collectDetailPages ? 0 : listings.length;
      await this.persist(run, records, safeFilters);

      if (!safeFilters.collectDetailPages) {
        run.status = "completed";
        run.finishedAt = new Date().toISOString();
        run.currentUrl = undefined;
        run.message = `Collected ${listings.length} listing summaries. Detail tabs were skipped.`;
        await this.persist(run, records, safeFilters);
        return;
      }

      for (const [index, listing] of listings.entries()) {
        this.ensureActive();
        run.status = "collecting-details";
        run.currentUrl = listing.url;
        run.message = `Waiting before listing ${index + 1} of ${listings.length}.`;
        await this.persist(run, records, safeFilters);
        await delay(randomDelay(timing.minDelayMs, timing.maxDelayMs), this.abortController.signal);

        this.ensureActive();
        run.message = `Opening listing ${index + 1} of ${listings.length}.`;
        await this.persist(run, records, safeFilters);

        let detailTabId: number | undefined;

        try {
          const detailTab = await createTab({ url: listing.url, active: false });
          detailTabId = detailTab.id;

          if (detailTabId === undefined) {
            throw new Error("Chrome did not return a tab id for the detail page.");
          }

          const detail = await this.collectListingDetail(detailTabId, run, records, safeFilters);
          records = mergeRecords(records, [recordFromDetail(listing, detail, run.id)]);
          run.collected = records.filter((record) => record.searchRunId === run.id && record.status === "detailed").length;
          run.message = `Collected ${run.collected} of ${listings.length}.`;
          await this.persist(run, records, safeFilters);
        } catch (error) {
          if (this.cancelled) {
            throw error;
          }

          if (error instanceof ActivityBlockError) {
            throw error;
          }

          records = mergeRecords(records, [recordFromFailure(listing, run.id, errorMessage(error))]);
          await this.persist(run, records, safeFilters);
        } finally {
          if (detailTabId !== undefined && safeFilters.closeDetailTabs) {
            await removeTab(detailTabId).catch(() => undefined);
          }
        }

        if ((index + 1) % timing.pauseAfterDetails === 0 && index + 1 < listings.length) {
          run.message = `Cooling down for ${Math.round(timing.cooldownMs / 1000)} seconds.`;
          await this.persist(run, records, safeFilters);
          await delay(timing.cooldownMs, this.abortController.signal);
        }
      }

      this.ensureActive();
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.currentUrl = undefined;
      run.message = `Collected ${run.collected} detailed listings.`;
      await this.persist(run, records, safeFilters);
    } catch (error) {
      if (error instanceof ActivityBlockError) {
        return;
      }

      run.finishedAt = new Date().toISOString();
      run.status = this.cancelled ? "cancelled" : "failed";
      run.error = this.cancelled ? undefined : errorMessage(error);
      run.message = this.cancelled ? "Scrape cancelled." : "Scrape failed.";
      await this.persist(run, records, safeFilters);
    } finally {
      if (searchTabId !== undefined) {
        await updateTab(searchTabId, { active: true }).catch(() => undefined);
      }
    }
  }

  private async collectSearchResults(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<ListingSummary[]> {
    for (;;) {
      this.ensureActive();
      await waitForTabComplete(tabId, 45_000, this.abortController.signal);
      await delay(SEARCH_SETTLE_MS, this.abortController.signal);
      const response = await sendContentMessage<ContentResponse>(tabId, {
        type: "LBC_COLLECT_SEARCH_RESULTS",
        limit: run.target,
      }, 8, this.abortController.signal);

      if (response.type === "LBC_SEARCH_RESULTS" && !response.captcha) {
        if (response.challenge?.type === "unusual-activity") {
          await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
        }

        return response.listings;
      }

      if (response.challenge?.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
      }

      await this.pauseForCaptcha(tabId, run, records, filters);
    }
  }

  private async collectListingDetail(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<ListingDetail> {
    for (;;) {
      this.ensureActive();
      await waitForTabComplete(tabId, 45_000, this.abortController.signal);
      await delay(DETAIL_SETTLE_MS, this.abortController.signal);
      const response = await sendContentMessage<ContentResponse>(tabId, {
        type: "LBC_COLLECT_DETAIL",
      }, 8, this.abortController.signal);

      if (response.type === "LBC_DETAIL" && !response.captcha && response.detail) {
        if (response.challenge?.type === "unusual-activity") {
          await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
        }

        return response.detail;
      }

      if (response.challenge?.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
      }

      await this.pauseForCaptcha(tabId, run, records, filters);
    }
  }

  private async pauseForCaptcha(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<void> {
    run.status = "paused-captcha";
    run.message = "Captcha detected. Solve it in the active tab, then resume.";
    await updateTab(tabId, { active: true });
    await this.persist(run, records, filters);

    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve;
    });

    this.ensureActive();
    run.message = "Resuming after captcha.";
    await this.persist(run, records, filters);
  }

  private async stopForActivityBlock(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    message: string,
  ): Promise<never> {
    run.status = "blocked-activity";
    run.finishedAt = new Date().toISOString();
    run.message = message;
    run.error = "LeBonCoin unusual activity block detected. Automation stopped.";
    await updateTab(tabId, { active: true });
    await this.persist(run, records, filters);
    throw new ActivityBlockError();
  }

  private ensureActive(): void {
    if (this.cancelled) {
      throw new Error("Scrape cancelled.");
    }
  }

  private async persist(
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<void> {
    const snapshot = { run: { ...run }, records: [...records] };
    this.observer(snapshot);
    const state: Parameters<typeof saveCrawlerState>[0] = { run: snapshot.run };
    const shouldPersistRecords = this.lastPersistedRecords !== records;
    const shouldPersistFilters = this.lastPersistedFilters !== filters;

    if (shouldPersistRecords) {
      state.records = snapshot.records;
    }

    if (shouldPersistFilters) {
      state.filters = filters;
    }

    await saveCrawlerState(state);
    if (shouldPersistRecords) this.lastPersistedRecords = records;
    if (shouldPersistFilters) this.lastPersistedFilters = filters;
  }
}

function recordFromSummary(summary: ListingSummary, runId: string): ScrapedPropertyRecord {
  return {
    id: summary.id,
    source: summary.source,
    listingUrl: summary.url,
    title: summary.title,
    priceText: summary.priceText,
    priceEuros: summary.priceEuros,
    pricePerSquareMeterText: summary.pricePerSquareMeterText,
    propertyType: summary.propertyType,
    rooms: summary.rooms,
    surfaceM2: summary.surfaceM2,
    landSurfaceM2: summary.landSurfaceM2,
    location: summary.location,
    sellerName: summary.sellerName,
    sellerType: summary.sellerType,
    postedAt: summary.postedAt,
    imageUrl: summary.imageUrl,
    features: summary.features,
    scrapedAt: new Date().toISOString(),
    searchRunId: runId,
    status: "listing",
    rawTextSample: summary.rawTextSample,
  };
}

function recordFromDetail(
  summary: ListingSummary,
  detail: ListingDetail,
  runId: string,
): ScrapedPropertyRecord {
  return {
    ...recordFromSummary(summary, runId),
    title: detail.title ?? summary.title,
    priceText: detail.priceText ?? summary.priceText,
    priceEuros: detail.priceEuros ?? summary.priceEuros,
    pricePerSquareMeterText: detail.pricePerSquareMeterText ?? summary.pricePerSquareMeterText,
    propertyType: detail.propertyType ?? summary.propertyType,
    rooms: detail.rooms ?? summary.rooms,
    bedrooms: detail.bedrooms,
    surfaceM2: detail.surfaceM2 ?? summary.surfaceM2,
    landSurfaceM2: detail.landSurfaceM2 ?? summary.landSurfaceM2,
    location: detail.location ?? summary.location,
    sellerName: detail.sellerName ?? summary.sellerName,
    sellerType: detail.sellerType ?? summary.sellerType,
    postedAt: detail.postedAt ?? summary.postedAt,
    description: detail.description,
    energyClass: detail.energyClass,
    gesClass: detail.gesClass,
    imageUrl: detail.imageUrl ?? summary.imageUrl,
    features: Array.from(new Set([...summary.features, ...detail.features])),
    status: "detailed",
    rawTextSample: detail.rawTextSample || summary.rawTextSample,
  };
}

function recordFromFailure(summary: ListingSummary, runId: string, error: string): ScrapedPropertyRecord {
  return {
    ...recordFromSummary(summary, runId),
    status: "failed",
    error,
  };
}

function mergeRecords(
  existing: ScrapedPropertyRecord[],
  incoming: ScrapedPropertyRecord[],
): ScrapedPropertyRecord[] {
  const byUrl = new Map(existing.map((record) => [record.listingUrl, record]));

  for (const record of incoming) {
    byUrl.set(record.listingUrl, {
      ...byUrl.get(record.listingUrl),
      ...record,
    });
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt))
    .slice(0, MAX_STORED_RECORDS);
}

function createTab(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, (tab) => {
      const error = chrome.runtime.lastError;

      if (error) {
        reject(new Error(error.message));
        return;
      }

      resolve(tab);
    });
  });
}

function updateTab(tabId: number, options: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, options, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function removeTab(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function waitForTabComplete(tabId: number, timeoutMs = 45_000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Scrape cancelled."));
      return;
    }

    let finished = false;
    const timeout = window.setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", handleAbort);
      reject(new Error("Timed out waiting for tab load."));
    }, timeoutMs);

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", handleAbort);
      reject(error);
    };

    const handleAbort = () => fail(new Error("Scrape cancelled."));

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", handleAbort, { once: true });
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        fail(new Error(error.message));
        return;
      }
      if (tab?.status === "complete") {
        finish();
      }
    });
  });
}

async function sendContentMessage<T extends ContentResponse>(
  tabId: number,
  message: ContentRequest,
  attempts = 8,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new Error("Scrape cancelled.");
    try {
      return await new Promise<T>((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response: T | undefined) => {
          const error = chrome.runtime.lastError;

          if (error) {
            reject(new Error(error.message));
            return;
          }

          if (!response) {
            reject(new Error("Content script did not return a response."));
            return;
          }

          resolve(response);
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(400 + attempt * 200, signal);
    }
  }

  throw lastError ?? new Error("Unable to talk to content script.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Scrape cancelled."));
      return;
    }

    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new Error("Scrape cancelled."));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function getRunTiming(filters: SearchFilters): RunTiming {
  return {
    minDelayMs: filters.minDelaySeconds * 1000,
    maxDelayMs: filters.maxDelaySeconds * 1000,
    pauseAfterDetails: filters.pauseAfterDetails,
    cooldownMs: filters.cooldownSeconds * 1000,
  };
}

function randomDelay(minMs: number, maxMs: number): number {
  return minMs + Math.round(Math.random() * Math.max(0, maxMs - minMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
