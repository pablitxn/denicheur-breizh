import { DEFAULT_LOCALE, type LocaleCode } from "@denicheur-breizh/i18n";
import {
  isLeboncoinSearchUrl,
  MAX_LISTINGS_PER_PAGE,
  normalizeSearchFilters,
  validateSearchFilters,
} from "../lib/leboncoinSearch";
import {
  createEvaluationFailureOutcome,
  evaluateDetailedRecordsInBatches,
  evaluationFailureDescriptor,
  filterApiErrorDescriptor,
  FilterApiError,
  mergeRecordEvaluationOutcome,
} from "../intelligence/filterApi";
import { recipeValidationError } from "../intelligence/recipe";
import {
  ensureMessageDescriptor,
  errorMessageDescriptor,
  localizedTextDetail,
  message,
} from "../lib/localizedText";
import {
  coordinateEvidenceToVerifiedCoordinates,
  selectBestCoordinates,
} from "../lib/coordinates";
import type {
  ContentRequest,
  ContentResponse,
  NativeSearchFilters,
  NativeSearchPhase,
  NativeSearchResponse,
} from "../lib/messages";
import type {
  FilterApplicationWarning,
  ListingDetail,
  ListingSummary,
  IntelligenceRecipe,
  ListingEvaluation,
  ListingEvaluationOutcome,
  LocalizedText,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
  SiteChallenge,
} from "../lib/types";
import { loadCrawlerState, saveCrawlerState } from "../storage/chromeStorage";
import { RunnerSnapshotCache, type RunnerSnapshot } from "./runnerSnapshot";
import { requestImmediateSync } from "../sync/runtime";

type RunnerObserver = (snapshot: RunnerSnapshot) => void;
export type ListingEvaluator = (
  runId: string,
  recipe: IntelligenceRecipe,
  records: ScrapedPropertyRecord[],
  locale: LocaleCode,
  signal: AbortSignal,
  onBatchComplete?: (
    batch: ListingEvaluationOutcome,
    accumulated: ListingEvaluationOutcome,
  ) => void | Promise<void>,
) => Promise<ListingEvaluationOutcome>;

const SEARCH_SETTLE_MS = 1600;
const DETAIL_SETTLE_MS = 1200;
const DOM_MIN_OBSERVATION_MS = 4_000;
const SEARCH_DOM_STABILITY_TIMEOUT_MS = 20_000;
const DETAIL_DOM_STABILITY_TIMEOUT_MS = 8_000;
const PAGE_LOAD_OBSERVATION_TIMEOUT_MS = 10_000;
const MAX_STORED_RECORDS = 500;
const HOME_URL = "https://www.leboncoin.fr/";
const PAGE_OBSERVATION_MIN_MS = 2_000;
const PAGE_OBSERVATION_MAX_MS = 5_000;
const SEARCH_NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_VISIBLE_CHALLENGE_EVIDENCE_LENGTH = 160;
const MAX_SEARCH_PAGES = 100;

type CaptchaEvidenceSource =
  | "native-action-response"
  | "queued-native-action"
  | "direct-page-inspection";

type CaptchaDetectedPhase =
  | NativeSearchPhase
  | "results-navigation"
  | "pagination-navigation"
  | "search-results"
  | "detail";

interface CaptchaPauseDiagnostics {
  source: CaptchaEvidenceSource;
  detectedPhase: CaptchaDetectedPhase;
  actionExecuted?: boolean;
}

interface ChallengeInspection extends CaptchaPauseDiagnostics {
  challenge?: SiteChallenge;
  retryPhase?: "home-submitted" | "results-applied" | "pagination-advanced";
}

interface SearchCollection {
  listings: ListingSummary[];
  records: ScrapedPropertyRecord[];
  pagesVisited: number;
}

interface RunTiming {
  minDelayMs: number;
  maxDelayMs: number;
  pauseAfterDetails: number;
  cooldownMs: number;
}

class SiteChallengeStopError extends Error {
  constructor() {
    super("Site challenge detected; automation stopped.");
  }
}

export interface RunnerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RunnerTabGateway {
  getCurrent(): Promise<chrome.tabs.Tab | undefined>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  create(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  update(tabId: number, options: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
  remove(tabId: number): Promise<void>;
  waitForComplete(tabId: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  waitForUrl(
    tabId: number,
    predicate: (url: URL) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<chrome.tabs.Tab>;
  sendMessage(
    tabId: number,
    message: ContentRequest,
    attempts: number,
    signal?: AbortSignal,
  ): Promise<ContentResponse>;
}

export interface ScrapeRunnerDependencies {
  tabs?: RunnerTabGateway;
  clock?: RunnerClock;
  random?: () => number;
}

const browserClock: RunnerClock = {
  now: () => Date.now(),
  sleep: delay,
};

export class ScrapeRunner {
  private cancelled = false;
  private abortController = new AbortController();
  private lastPersistedFilters: SearchFilters | undefined;
  private lastPersistedRecords: ScrapedPropertyRecord[] | undefined;
  private snapshots = new RunnerSnapshotCache();
  private storageGeneration = 0;
  private terminalReviewTabId: number | undefined;
  private dashboardTabId: number | undefined;
  private currentOwnedTabId: number | undefined;
  private ownedTabIds = new Set<number>();
  private resumeResolver: (() => void) | undefined;
  private readonly tabs: RunnerTabGateway;
  private readonly clock: RunnerClock;
  private readonly random: () => number;

  constructor(
    private readonly observer: RunnerObserver,
    private readonly evaluator: ListingEvaluator = defaultEvaluator,
    dependencies: ScrapeRunnerDependencies = {},
  ) {
    this.tabs = dependencies.tabs ?? browserTabGateway;
    this.clock = dependencies.clock ?? browserClock;
    this.random = dependencies.random ?? Math.random;
  }

  cancel(): void {
    this.cancelled = true;
    this.abortController.abort();
    this.resumeResolver?.();
    this.resumeResolver = undefined;
  }

  resume(): void {
    const resolver = this.resumeResolver;
    if (!resolver) return;
    this.resumeResolver = undefined;
    resolver();
  }

  async run(
    filters: SearchFilters,
    recipe?: IntelligenceRecipe,
    locale: LocaleCode = DEFAULT_LOCALE,
  ): Promise<void> {
    this.cancelled = false;
    this.abortController = new AbortController();
    this.lastPersistedFilters = undefined;
    this.lastPersistedRecords = undefined;
    this.snapshots = new RunnerSnapshotCache();
    this.terminalReviewTabId = undefined;
    this.dashboardTabId = undefined;
    this.currentOwnedTabId = undefined;
    this.ownedTabIds = new Set<number>();
    this.resumeResolver = undefined;
    const intelligenceError = recipe ? recipeValidationError(recipe) : undefined;
    if (intelligenceError) throw new Error(intelligenceError);

    const validationIssues = validateSearchFilters(filters);
    if (validationIssues.length > 0) {
      throw new Error(validationIssues.map((issue) => issue.message).join(" "));
    }

    const normalizedFilters = normalizeSearchFilters(filters);
    const safeFilters = recipe?.enabled
      ? { ...normalizedFilters, collectDetailPages: true }
      : normalizedFilters;
    const timing = getRunTiming(safeFilters);
    const target = safeFilters.maxListings;
    const startedAt = new Date().toISOString();
    const initialState = await loadCrawlerState();
    this.storageGeneration = initialState.generation ?? 0;
    let records = initialState.records;
    const run: ScrapeRun = {
      id: `run-${Date.now()}`,
      status: "opening-search",
      startedAt,
      target,
      found: 0,
      pagesVisited: 0,
      collected: 0,
      evaluated: 0,
      relevant: 0,
      notRelevant: 0,
      review: 0,
      filterWarnings: [],
      intelligenceStatus: recipe?.enabled ? "idle" : undefined,
      message: message("run.openingHome"),
    };

    await this.persist(run, records, safeFilters);

    let searchTabId: number | undefined;

    try {
      this.ensureActive();
      const dashboardTab = await this.tabs.getCurrent();
      this.ensureActive();
      if (dashboardTab?.id === undefined || dashboardTab.windowId === undefined) {
        throw new Error("Chrome did not expose the dashboard tab to the crawler.");
      }
      this.dashboardTabId = dashboardTab.id;
      run.dashboardTabId = dashboardTab.id;

      const homeTab = await this.tabs.create({
        url: "about:blank",
        active: true,
        windowId: dashboardTab.windowId,
        openerTabId: dashboardTab.id,
      });
      if (homeTab.id === undefined) throw new Error("Chrome did not return a tab id for the Leboncoin home page.");
      searchTabId = homeTab.id;
      this.ownedTabIds.add(searchTabId);
      this.currentOwnedTabId = searchTabId;

      this.ensureActive();
      await this.tabs.update(searchTabId, { url: HOME_URL, active: true });
      await this.waitForPageLoadObservation(searchTabId);
      await this.observeLoadedPage();

      run.status = "configuring-search";
      run.currentUrl = HOME_URL;
      run.message = message("run.applyingHomeFilters");
      await this.persist(run, records, safeFilters);

      const nativeFilters = toNativeSearchFilters(safeFilters);
      await this.performNativePhase(
        searchTabId,
        { type: "LBC_PREPARE_HOME_SEARCH", filters: nativeFilters },
        "home-prepared",
        run,
        records,
        safeFilters,
        "configuring-search",
      );
      await this.performNativePhase(
        searchTabId,
        { type: "LBC_SUBMIT_HOME_SEARCH" },
        "home-submitted",
        run,
        records,
        safeFilters,
        "configuring-search",
      );

      const routedTab = await this.waitForSearchNavigation(
        searchTabId,
        run,
        records,
        safeFilters,
      );
      await this.waitForPageLoadObservation(searchTabId);
      await this.observeLoadedPage();
      run.currentUrl = routedTab.url;
      run.message = message("run.applyingResultsFilters");
      await this.persist(run, records, safeFilters);

      await this.configureNativeResults(
        searchTabId,
        nativeFilters,
        run,
        records,
        safeFilters,
      );
      const observedSearchTab = await this.tabs.get(searchTabId);
      if (!observedSearchTab.url || !isSafeSearchUrl(observedSearchTab.url)) {
        throw new Error("Leboncoin did not reach a valid /recherche page after applying filters.");
      }
      run.searchUrl = observedSearchTab.url;

      run.status = "collecting-search";
      run.currentUrl = observedSearchTab.url;
      run.message = message("run.collectingSearch");
      await this.persist(run, records, safeFilters);

      const searchCollection = await this.collectSearchPages(
        searchTabId,
        run,
        records,
        safeFilters,
        (checkpointRecords) => {
          records = checkpointRecords;
        },
      );
      const listings = searchCollection.listings;
      records = searchCollection.records;

      if (!safeFilters.collectDetailPages) {
        run.status = "completed";
        run.finishedAt = new Date().toISOString();
        run.currentUrl = undefined;
        run.message = searchCollection.pagesVisited === 1
          ? message("run.summaryCollectionCompleteOnePage", { count: listings.length })
          : message("run.summaryCollectionCompleteManyPages", {
              count: listings.length,
              pages: searchCollection.pagesVisited,
            });
        await this.persist(run, records, safeFilters);
        return;
      }

      for (const [index, listing] of listings.entries()) {
        this.ensureActive();
        run.status = "collecting-details";
        run.currentUrl = listing.url;
        run.message = message("run.waitingListing", { current: index + 1, total: listings.length });
        await this.persist(run, records, safeFilters);
        await this.clock.sleep(this.randomDelay(timing.minDelayMs, timing.maxDelayMs), this.abortController.signal);

        this.ensureActive();
        run.message = message("run.openingListing", { current: index + 1, total: listings.length });
        await this.persist(run, records, safeFilters);

        let detailTabId: number | undefined;

        try {
          const searchTab = await this.tabs.get(searchTabId);
          this.ensureActive();
          const detailTab = await this.tabs.create({
            url: "about:blank",
            active: true,
            windowId: searchTab.windowId,
            openerTabId: searchTabId,
          });
          detailTabId = detailTab.id;

          if (detailTabId === undefined) {
            throw new Error("Chrome did not return a tab id for the detail page.");
          }
          this.ownedTabIds.add(detailTabId);
          this.currentOwnedTabId = detailTabId;
          this.ensureActive();
          await this.tabs.update(detailTabId, { url: listing.url, active: true });
          await this.waitForPageLoadObservation(detailTabId);
          await this.observeLoadedPage();

          const detail = await this.collectListingDetail(detailTabId, run, records, safeFilters);
          records = mergeRecords(records, [recordFromDetail(listing, detail, run.id)]);
          run.collected = records.filter((record) => record.searchRunId === run.id && record.status === "detailed").length;
          run.message = message("run.collectedDetailsProgress", {
            count: run.collected,
            total: listings.length,
          });
          await this.persist(run, records, safeFilters);
          await this.closeOwnedSuccessfulDetail(detailTabId, run);
          await this.persist(run, records, safeFilters);
          this.currentOwnedTabId = searchTabId;
        } catch (error) {
          if (this.cancelled) {
            throw error;
          }

          if (error instanceof SiteChallengeStopError) {
            throw error;
          }

          records = mergeRecords(records, [
            recordFromFailure(listing, run.id, errorMessageDescriptor("error.listingFailed", error)),
          ]);
          this.appendFilterWarnings(run, [{
            field: `detail:${listing.id}`,
            message: errorMessageDescriptor("warning.detailFailurePreserved", error),
          }]);
          run.message = message("run.listingFailedContinuing", {
            current: index + 1,
            total: listings.length,
          });
          await this.persist(run, records, safeFilters);
          this.currentOwnedTabId = searchTabId;
        }

        if ((index + 1) % timing.pauseAfterDetails === 0 && index + 1 < listings.length) {
          run.message = message("run.cooldown", {
            seconds: Math.round(timing.cooldownMs / 1000),
          });
          await this.persist(run, records, safeFilters);
          await this.clock.sleep(timing.cooldownMs, this.abortController.signal);
        }
      }

      this.ensureActive();
      if (recipe?.enabled) {
        records = await runIntelligencePhase({
          run,
          records,
          recipe,
          locale,
          evaluator: this.evaluator,
          signal: this.abortController.signal,
          persist: (nextRun, nextRecords) => this.persist(nextRun, nextRecords, safeFilters),
        });
      }

      this.ensureActive();
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      run.currentUrl = undefined;
      if (run.intelligenceStatus !== "failed") {
        const failedDetails = records.filter(
          (record) => record.searchRunId === run.id && record.status === "failed",
        ).length;
        run.message = recipe?.enabled
          ? message("run.collectedAndEvaluated", {
              count: run.collected,
              evaluated: run.evaluated,
            })
          : failedDetails > 0
            ? message("run.collectedWithFailedDetails", {
                count: run.collected,
                failed: failedDetails,
              })
            : message("run.collectedDetailed", { count: run.collected });
      }
      await this.persist(run, records, safeFilters);
    } catch (error) {
      if (error instanceof SiteChallengeStopError) {
        return;
      }

      if (!this.cancelled && this.terminalReviewTabId === undefined) {
        this.terminalReviewTabId = this.currentOwnedTabId;
      }

      run.finishedAt = new Date().toISOString();
      run.status = this.cancelled ? "cancelled" : "failed";
      run.error = this.cancelled ? undefined : errorMessageDescriptor("error.crawlFailed", error);
      if (run.intelligenceStatus === "evaluating") {
        run.intelligenceStatus = "failed";
        run.intelligenceError = this.cancelled
          ? message("error.intelligenceCancelled")
          : errorMessageDescriptor("error.intelligenceFailed", error);
      }
      run.message = this.cancelled ? message("run.cancelled") : message("run.failed");
      await this.persist(run, records, safeFilters);
    } finally {
      const finalTabId = this.terminalReviewTabId;
      if (finalTabId !== undefined) {
        await this.tabs.update(finalTabId, { active: true }).catch(() => undefined);
      } else if (run.status === "completed" && this.dashboardTabId !== undefined) {
        await this.tabs.update(this.dashboardTabId, { active: true }).catch(() => undefined);
      }
    }
  }

  private async performNativePhase(
    tabId: number,
    request: ContentRequest,
    expectedPhase: NativeSearchPhase,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    resumeStatus: ScrapeRun["status"],
  ): Promise<NativeSearchResponse> {
    for (;;) {
      this.ensureActive();
      const response = await this.tabs.sendMessage(
        tabId,
        request,
        12,
        this.abortController.signal,
      );
      this.ensureActive();
      if (response.type !== "LBC_NATIVE_SEARCH_RESULT" || response.phase !== expectedPhase) {
        throw new Error(`Unexpected content-script response during ${expectedPhase}.`);
      }

      this.appendFilterWarnings(run, response.warnings);
      if (response.challenge?.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
      }
      if (response.challenge?.type === "captcha") {
        await this.pauseForCaptcha(
          tabId,
          run,
          records,
          filters,
          resumeStatus,
          expectedPhase,
          response.challenge,
          {
            source: "native-action-response",
            detectedPhase: response.phase,
            actionExecuted: response.actionExecuted,
          },
        );
        if (response.actionExecuted === true) {
          // The native click may already have reached the site. Continue with
          // observation/navigation, but never risk submitting it twice.
          await this.persist(run, records, filters);
          return response;
        }
        continue;
      }
      if (!response.ok) {
        throw new Error(
          response.error
            ? localizedTextDetail(response.error)
            : `Leboncoin could not complete ${expectedPhase}.`,
        );
      }
      await this.persist(run, records, filters);
      return response;
    }
  }

  private async configureNativeResults(
    tabId: number,
    nativeFilters: NativeSearchFilters,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<void> {
    // A clean run needs at most nine observations. Extra iterations let the
    // native driver remove stale range boundaries one navigation at a time
    // and then re-open the panel to verify the final applied state.
    const maximumSteps = 24;

    for (let index = 0; index < maximumSteps; index += 1) {
      this.ensureActive();
      const prepared = await this.performNativePhase(
        tabId,
        { type: "LBC_PREPARE_RESULTS_FILTERS", filters: nativeFilters },
        "results-prepared",
        run,
        records,
        filters,
        "configuring-search",
      );
      const step = prepared.step ?? "filters";
      if (step === "complete") return;

      const beforeCommit = await this.tabs.get(tabId);
      const beforeUrl = beforeCommit.url;
      const committed = await this.performNativePhase(
        tabId,
        { type: "LBC_APPLY_RESULTS_FILTERS" },
        "results-applied",
        run,
        records,
        filters,
        "configuring-search",
      );

      if (prepared.navigationExpected || committed.navigationExpected) {
        await this.waitForResultsNavigation(
          tabId,
          beforeUrl,
          run,
          records,
          filters,
        );
      }
      await this.waitForPageLoadObservation(tabId);
      await this.observeLoadedPage();

      const observed = await this.tabs.get(tabId);
      if (observed.url && isSafeSearchUrl(observed.url)) {
        run.currentUrl = observed.url;
        await this.persist(run, records, filters);
      }
    }

    throw new Error("Leboncoin did not finish the staged native results configuration.");
  }

  private async waitForResultsNavigation(
    tabId: number,
    previousUrl: string | undefined,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    retryPhase: "results-applied" | "pagination-advanced" = "results-applied",
    resumeStatus: ScrapeRun["status"] = "configuring-search",
  ): Promise<void> {
    let inspectBeforeWaiting = false;
    const navigationPhase = retryPhase === "pagination-advanced"
      ? "pagination-navigation"
      : "results-navigation";

    for (;;) {
      this.ensureActive();
      if (!inspectBeforeWaiting) {
        try {
          await this.tabs.waitForUrl(
            tabId,
            (url) => isLeboncoinSearchUrl(url) && url.href !== previousUrl,
            SEARCH_NAVIGATION_TIMEOUT_MS,
            this.abortController.signal,
          );
          return;
        } catch (error) {
          this.ensureActive();
          const inspection = await this.inspectChallenge(tabId);
          if (!inspection.challenge) throw error;
          if (inspection.challenge.type === "unusual-activity") {
            await this.stopForActivityBlock(tabId, run, records, filters, inspection.challenge.message);
          }
          await this.pauseForCaptcha(
            tabId,
            run,
            records,
            filters,
            resumeStatus,
            navigationPhase,
            inspection.challenge,
            inspection,
          );
          if (inspection.retryPhase === retryPhase) {
            await this.performNativePhase(
              tabId,
              nativeRetryRequest(retryPhase),
              retryPhase,
              run,
              records,
              filters,
              resumeStatus,
            );
            inspectBeforeWaiting = false;
            continue;
          }
          inspectBeforeWaiting = true;
          continue;
        }
      }

      const inspection = await this.inspectChallenge(tabId);
      if (!inspection.challenge) {
        inspectBeforeWaiting = false;
        continue;
      }
      if (inspection.challenge.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, inspection.challenge.message);
      }
      await this.pauseForCaptcha(
        tabId,
        run,
        records,
        filters,
        resumeStatus,
        navigationPhase,
        inspection.challenge,
        inspection,
      );
      if (inspection.retryPhase === retryPhase) {
        await this.performNativePhase(
          tabId,
          nativeRetryRequest(retryPhase),
          retryPhase,
          run,
          records,
          filters,
          resumeStatus,
        );
        inspectBeforeWaiting = false;
      }
    }
  }

  private async waitForSearchNavigation(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<chrome.tabs.Tab> {
    let inspectBeforeWaiting = false;

    for (;;) {
      this.ensureActive();
      if (!inspectBeforeWaiting) {
        try {
          return await this.tabs.waitForUrl(
            tabId,
            isLeboncoinSearchUrl,
            SEARCH_NAVIGATION_TIMEOUT_MS,
            this.abortController.signal,
          );
        } catch (error) {
          this.ensureActive();
          const inspection = await this.inspectChallenge(tabId);
          if (!inspection.challenge) throw error;
          if (inspection.challenge.type === "unusual-activity") {
            await this.stopForActivityBlock(tabId, run, records, filters, inspection.challenge.message);
          }
          await this.pauseForCaptcha(
            tabId,
            run,
            records,
            filters,
            "configuring-search",
            "search-navigation",
            inspection.challenge,
            inspection,
          );
          if (inspection.retryPhase === "home-submitted") {
            await this.performNativePhase(
              tabId,
              { type: "LBC_SUBMIT_HOME_SEARCH" },
              "home-submitted",
              run,
              records,
              filters,
              "configuring-search",
            );
            inspectBeforeWaiting = false;
            continue;
          }
          inspectBeforeWaiting = true;
          continue;
        }
      }

      const inspection = await this.inspectChallenge(tabId);
      if (!inspection.challenge) {
        inspectBeforeWaiting = false;
        continue;
      }
      if (inspection.challenge.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, inspection.challenge.message);
      }
      await this.pauseForCaptcha(
        tabId,
        run,
        records,
        filters,
        "configuring-search",
        "search-navigation",
        inspection.challenge,
        inspection,
      );
      if (inspection.retryPhase === "home-submitted") {
        await this.performNativePhase(
          tabId,
          { type: "LBC_SUBMIT_HOME_SEARCH" },
          "home-submitted",
          run,
          records,
          filters,
          "configuring-search",
        );
        inspectBeforeWaiting = false;
      }
    }
  }

  private async inspectChallenge(tabId: number): Promise<ChallengeInspection> {
    const response = await this.tabs.sendMessage(
      tabId,
      { type: "LBC_COLLECT_SEARCH_RESULTS", limit: 1 },
      2,
      this.abortController.signal,
    );
    this.ensureActive();
    if (response.type === "LBC_NATIVE_SEARCH_RESULT") {
      if (!response.ok && !response.challenge) {
        throw new Error(
          response.error
            ? localizedTextDetail(response.error)
            : "A queued native action failed before navigation.",
        );
      }
      return {
        challenge: response.challenge,
        source: "queued-native-action",
        detectedPhase: response.phase,
        actionExecuted: response.actionExecuted,
        retryPhase: response.actionExecuted === false &&
          (response.phase === "home-submitted" ||
            response.phase === "results-applied" ||
            response.phase === "pagination-advanced")
          ? response.phase
          : undefined,
      };
    }
    return {
      challenge: response.challenge,
      source: "direct-page-inspection",
      detectedPhase: response.type === "LBC_DETAIL" ? "detail" : "search-results",
    };
  }

  private appendFilterWarnings(run: ScrapeRun, warnings: FilterApplicationWarning[]): void {
    for (const warning of warnings) {
      if (run.filterWarnings.some(
        (existing) => existing.field === warning.field &&
          localizedTextDetail(existing.message) === localizedTextDetail(warning.message),
      )) continue;
      run.filterWarnings.push({
        field: warning.field,
        message: ensureMessageDescriptor(warning.message),
      });
    }
  }

  private async observeLoadedPage(): Promise<void> {
    await this.clock.sleep(
      this.randomDelay(PAGE_OBSERVATION_MIN_MS, PAGE_OBSERVATION_MAX_MS),
      this.abortController.signal,
    );
  }

  private async waitForPageLoadObservation(tabId: number): Promise<void> {
    try {
      await this.tabs.waitForComplete(
        tabId,
        PAGE_LOAD_OBSERVATION_TIMEOUT_MS,
        this.abortController.signal,
      );
    } catch (error) {
      // Leboncoin can keep secondary resources loading after the document and the
      // extension content script are ready. The following content-script handshake
      // is the authoritative availability check; all other tab errors remain fatal.
      if (this.cancelled || !isTabLoadTimeout(error)) throw error;
    }
  }

  private randomDelay(minMs: number, maxMs: number): number {
    return minMs + Math.round(this.random() * Math.max(0, maxMs - minMs));
  }

  private async closeOwnedSuccessfulDetail(tabId: number, run: ScrapeRun): Promise<void> {
    if (!this.ownedTabIds.has(tabId)) return;
    try {
      await this.tabs.remove(tabId);
      this.ownedTabIds.delete(tabId);
    } catch (error) {
      this.appendFilterWarnings(run, [{
        field: "detailTabs",
        message: errorMessageDescriptor("warning.detailTabCloseFailed", error),
      }]);
    }
  }

  private async collectSearchPages(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    onRecordsCheckpoint: (records: ScrapedPropertyRecord[]) => void,
  ): Promise<SearchCollection> {
    let listings: ListingSummary[] = [];
    let nextRecords = records;
    const visitedUrls = new Set<string>();

    for (let pageNumber = 1; pageNumber <= MAX_SEARCH_PAGES; pageNumber += 1) {
      this.ensureActive();
      const observed = await this.tabs.get(tabId);
      if (!observed.url || !isSafeSearchUrl(observed.url)) {
        throw new Error("Leboncoin left the search results route while paginating.");
      }
      if (visitedUrls.has(observed.url)) {
        throw new Error("Leboncoin pagination returned to an already visited results page.");
      }
      visitedUrls.add(observed.url);

      run.status = "collecting-search";
      run.currentUrl = observed.url;
      run.pagesVisited = pageNumber;
      run.message = message("run.collectingSearchPage", {
        page: pageNumber,
        count: listings.length,
        target: run.target,
      });
      await this.persist(run, nextRecords, filters);

      const pageListings = await this.collectSearchResults(
        tabId,
        run,
        nextRecords,
        filters,
        MAX_LISTINGS_PER_PAGE,
      );
      listings = mergeListingPages(listings, pageListings, run.target);
      nextRecords = mergeRecords(
        nextRecords,
        listings.map((listing) => recordFromSummary(listing, run.id)),
      );
      run.found = listings.length;
      run.collected = filters.collectDetailPages ? 0 : listings.length;
      run.message = message("run.collectedSearchPage", {
        page: pageNumber,
        count: listings.length,
        target: run.target,
      });
      await this.persist(run, nextRecords, filters);
      onRecordsCheckpoint(nextRecords);

      if (listings.length >= run.target) {
        return { listings, records: nextRecords, pagesVisited: pageNumber };
      }

      const pagination = await this.performNativePhase(
        tabId,
        { type: "LBC_PREPARE_NEXT_RESULTS_PAGE" },
        "pagination-prepared",
        run,
        nextRecords,
        filters,
        "collecting-search",
      );
      if (!pagination.hasNextPage) {
        return { listings, records: nextRecords, pagesVisited: pageNumber };
      }

      const beforeUrl = observed.url;
      run.message = message("run.advancingSearchPage", { page: pageNumber + 1 });
      await this.persist(run, nextRecords, filters);
      await this.performNativePhase(
        tabId,
        { type: "LBC_GO_NEXT_RESULTS_PAGE" },
        "pagination-advanced",
        run,
        nextRecords,
        filters,
        "collecting-search",
      );
      await this.waitForResultsNavigation(
        tabId,
        beforeUrl,
        run,
        nextRecords,
        filters,
        "pagination-advanced",
        "collecting-search",
      );
      await this.waitForPageLoadObservation(tabId);
      await this.observeLoadedPage();
    }

    throw new Error(`Leboncoin pagination exceeded the ${MAX_SEARCH_PAGES}-page safety limit.`);
  }

  private async collectSearchResults(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    limit: number,
  ): Promise<ListingSummary[]> {
    let deadline = this.clock.now() + SEARCH_DOM_STABILITY_TIMEOUT_MS;
    let previousFingerprint: string | undefined;
    let stableSince = this.clock.now();
    await this.waitForPageLoadObservation(tabId);

    for (;;) {
      this.ensureActive();
      await this.clock.sleep(SEARCH_SETTLE_MS, this.abortController.signal);
      const response = await this.tabs.sendMessage(tabId, {
        type: "LBC_COLLECT_SEARCH_RESULTS",
        limit,
      }, 8, this.abortController.signal);
      this.ensureActive();

      if (response.type === "LBC_NATIVE_SEARCH_RESULT") {
        if (response.challenge?.type === "unusual-activity") {
          await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
        }
        if (response.challenge?.type === "captcha") {
          const retryResultsApply = response.phase === "results-applied" && response.actionExecuted === false;
          await this.pauseForCaptcha(
            tabId,
            run,
            records,
            filters,
            "collecting-search",
            response.phase,
            response.challenge,
            {
              source: "queued-native-action",
              detectedPhase: response.phase,
              actionExecuted: response.actionExecuted,
            },
          );
          if (retryResultsApply) {
            await this.performNativePhase(
              tabId,
              { type: "LBC_APPLY_RESULTS_FILTERS" },
              "results-applied",
              run,
              records,
              filters,
              "collecting-search",
            );
          }
          deadline = this.clock.now() + SEARCH_DOM_STABILITY_TIMEOUT_MS;
          previousFingerprint = undefined;
          stableSince = this.clock.now();
          continue;
        }
        throw new Error(
          response.error
            ? localizedTextDetail(response.error)
            : "A queued native results action failed.",
        );
      }

      if (response.type !== "LBC_SEARCH_RESULTS") {
        throw new Error("Unexpected content-script response while collecting search results.");
      }

      if (!response.captcha) {
        if (response.challenge?.type === "unusual-activity") {
          await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
        }

        if (!response.ready) {
          if (this.clock.now() >= deadline) {
            throw new Error("The search page DOM did not become ready; no listings were stored.");
          }
          continue;
        }

        const fingerprint = searchFingerprint(response.listings);
        if (
          fingerprint === previousFingerprint &&
          this.clock.now() - stableSince >= DOM_MIN_OBSERVATION_MS
        ) {
          const observed = await this.tabs.get(tabId);
          if (observed.url && isSafeSearchUrl(observed.url)) {
            run.searchUrl ??= observed.url;
            run.currentUrl = observed.url;
          }
          return response.listings;
        }
        if (fingerprint !== previousFingerprint) stableSince = this.clock.now();
        previousFingerprint = fingerprint;
        if (this.clock.now() >= deadline) {
          throw new Error("The search page DOM did not stabilize; no listings were stored.");
        }
        continue;
      }

      if (response.challenge?.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
      }
      if (response.captcha || response.challenge?.type === "captcha") {
        await this.pauseForCaptcha(
          tabId,
          run,
          records,
          filters,
          "collecting-search",
          "search-results",
          response.challenge,
          {
            source: "direct-page-inspection",
            detectedPhase: "search-results",
          },
        );
      } else {
        throw new Error("Search extraction returned neither results nor a recognized challenge.");
      }
      deadline = this.clock.now() + SEARCH_DOM_STABILITY_TIMEOUT_MS;
      previousFingerprint = undefined;
      stableSince = this.clock.now();
    }
  }

  private async collectListingDetail(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
  ): Promise<ListingDetail> {
    let deadline = this.clock.now() + DETAIL_DOM_STABILITY_TIMEOUT_MS;
    let previousFingerprint: string | undefined;
    let stableSince = this.clock.now();

    for (;;) {
      this.ensureActive();
      await this.clock.sleep(DETAIL_SETTLE_MS, this.abortController.signal);
      const response = await this.tabs.sendMessage(tabId, {
        type: "LBC_COLLECT_DETAIL",
      }, 8, this.abortController.signal);
      this.ensureActive();

      if (response.type !== "LBC_DETAIL") {
        throw new Error("Unexpected content-script response while collecting a listing detail.");
      }

      if (!response.captcha && response.detail) {
        if (response.challenge?.type === "unusual-activity") {
          await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
        }

        if (!response.ready) {
          if (this.clock.now() >= deadline) {
            throw new Error("The listing detail DOM did not become ready; the record was not marked detailed.");
          }
          continue;
        }

        const fingerprint = detailFingerprint(response.detail);
        if (
          fingerprint === previousFingerprint &&
          this.clock.now() - stableSince >= DOM_MIN_OBSERVATION_MS
        ) return response.detail;
        if (fingerprint !== previousFingerprint) stableSince = this.clock.now();
        previousFingerprint = fingerprint;
        if (this.clock.now() >= deadline) {
          throw new Error("The listing detail DOM did not stabilize; the record was not marked detailed.");
        }
        continue;
      }

      if (response.challenge?.type === "unusual-activity") {
        await this.stopForActivityBlock(tabId, run, records, filters, response.challenge.message);
      }

      if (response.captcha || response.challenge?.type === "captcha") {
        await this.pauseForCaptcha(
          tabId,
          run,
          records,
          filters,
          "collecting-details",
          "detail",
          response.challenge,
          {
            source: "direct-page-inspection",
            detectedPhase: "detail",
          },
        );
      } else {
        throw new Error("Detail extraction returned neither a detail nor a recognized challenge.");
      }
      deadline = this.clock.now() + DETAIL_DOM_STABILITY_TIMEOUT_MS;
      previousFingerprint = undefined;
      stableSince = this.clock.now();
    }
  }

  private async pauseForCaptcha(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    resumeStatus: ScrapeRun["status"],
    checkpoint: string,
    challenge?: SiteChallenge,
    diagnostics?: CaptchaPauseDiagnostics,
  ): Promise<void> {
    this.ensureActive();
    run.status = "paused-captcha";
    run.finishedAt = undefined;
    const facts = formatCaptchaPauseFacts(diagnostics, challenge);
    run.message = message("run.captchaPaused", {
      checkpoint: sanitizeVisibleDiagnostic(checkpoint),
      facts,
    });
    run.error = undefined;
    this.terminalReviewTabId = tabId;
    const resumePromise = new Promise<void>((resolve) => {
      this.resumeResolver = resolve;
    });
    await this.tabs.update(tabId, { active: true }).catch(() => undefined);
    await this.persist(run, records, filters).catch(() => undefined);
    await resumePromise;
    this.ensureActive();
    this.terminalReviewTabId = undefined;
    run.status = resumeStatus;
    run.message = message("run.captchaRechecking");
    await this.persist(run, records, filters);
  }

  private async stopForActivityBlock(
    tabId: number,
    run: ScrapeRun,
    records: ScrapedPropertyRecord[],
    filters: SearchFilters,
    challengeMessage: LocalizedText,
  ): Promise<never> {
    this.ensureActive();
    run.status = "blocked-activity";
    run.finishedAt = new Date().toISOString();
    run.message = ensureMessageDescriptor(challengeMessage, "challenge.unusualMessage");
    run.error = message("error.activityBlocked");
    this.terminalReviewTabId = tabId;
    await this.tabs.update(tabId, { active: true }).catch(() => undefined);
    await this.persist(run, records, filters).catch(() => undefined);
    throw new SiteChallengeStopError();
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
    const snapshot = this.snapshots.create(run, records);
    this.observer(snapshot);
    const state: Parameters<typeof saveCrawlerState>[0] = { run: snapshot.run };
    const shouldPersistRecords = this.lastPersistedRecords !== records;
    const shouldPersistFilters = this.lastPersistedFilters !== filters;

    if (shouldPersistRecords) {
      state.records = records;
    }

    if (shouldPersistFilters) {
      state.filters = filters;
    }

    await saveCrawlerState(state, {
      expectedGeneration: this.storageGeneration,
      ...(shouldPersistRecords ? { previousRecords: this.lastPersistedRecords ?? records } : {}),
    });
    if (shouldPersistRecords) this.lastPersistedRecords = records;
    if (shouldPersistFilters) this.lastPersistedFilters = filters;
  }
}

function formatCaptchaPauseFacts(
  diagnostics: CaptchaPauseDiagnostics | undefined,
  challenge: SiteChallenge | undefined,
): string {
  const facts: string[] = [];
  if (diagnostics) {
    facts.push(`source=${sanitizeVisibleDiagnostic(diagnostics.source)}`);
    facts.push(`phase=${sanitizeVisibleDiagnostic(diagnostics.detectedPhase)}`);
    facts.push(`actionExecuted=${diagnostics.actionExecuted === undefined
      ? "unknown"
      : String(diagnostics.actionExecuted)}`);
  }

  const evidence = sanitizeVisibleDiagnostic(
    challenge?.evidence ?? (challenge?.title ? localizedTextDetail(challenge.title) : ""),
  );
  if (evidence) facts.push(`evidence=${evidence}`);
  return facts.length > 0 ? ` [${facts.join("; ")}]` : "";
}

function sanitizeVisibleDiagnostic(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f[\];=]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VISIBLE_CHALLENGE_EVIDENCE_LENGTH);
}

function searchFingerprint(listings: ListingSummary[]): string {
  return JSON.stringify(listings.map((listing) => ({
    ...listing,
    features: [...listing.features].sort(),
    imageUrl: stableImageUrl(listing.imageUrl),
    imageUrls: stableImageUrls(listing.imageUrls),
    rawTextSample: undefined,
  })));
}

function detailFingerprint(detail: ListingDetail): string {
  return JSON.stringify({
    ...detail,
    features: [...detail.features].sort(),
    imageUrl: stableImageUrl(detail.imageUrl),
    imageUrls: stableImageUrls(detail.imageUrls),
    rawTextSample: undefined,
  });
}

function stableImageUrls(urls: string[] | undefined): string[] | undefined {
  if (!urls) return undefined;
  return Array.from(new Set(
    urls.map(stableImageUrl).filter((url): url is string => url !== undefined),
  )).sort();
}

function stableImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function recordFromSummary(summary: ListingSummary, runId: string): ScrapedPropertyRecord {
  const imageUrls = mergeImageUrls(
    summary.imageUrls,
    summary.imageUrl ? [summary.imageUrl] : undefined,
  );
  const scrapedAt = new Date().toISOString();

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
    bedrooms: summary.bedrooms,
    surfaceM2: summary.surfaceM2,
    landSurfaceM2: summary.landSurfaceM2,
    location: summary.location,
    coordinates: coordinateEvidenceToVerifiedCoordinates(
      summary.coordinateEvidence,
      scrapedAt,
    ),
    sellerName: summary.sellerName,
    sellerType: summary.sellerType,
    postedAt: summary.postedAt,
    energyClass: summary.energyClass,
    gesClass: summary.gesClass,
    imageUrl: imageUrls?.[0],
    imageUrls,
    features: summary.features,
    scrapedAt,
    searchRunId: runId,
    status: "listing",
    rawTextSample: summary.rawTextSample,
    evaluation: undefined,
  };
}

function recordFromDetail(
  summary: ListingSummary,
  detail: ListingDetail,
  runId: string,
): ScrapedPropertyRecord {
  if (detail.id && detail.id !== summary.id) {
    throw new Error("The detail page listing id did not match the search result.");
  }

  const imageUrls = mergeImageUrls(
    detail.imageUrls,
    detail.imageUrl ? [detail.imageUrl] : undefined,
  );
  const summaryRecord = recordFromSummary(summary, runId);

  return {
    ...summaryRecord,
    listingUrl: detail.url ?? summary.url,
    title: detail.title,
    priceText: detail.priceText,
    priceEuros: detail.priceEuros,
    pricePerSquareMeterText: detail.pricePerSquareMeterText,
    propertyType: detail.propertyType,
    rooms: detail.rooms,
    bedrooms: detail.bedrooms,
    surfaceM2: detail.surfaceM2,
    landSurfaceM2: detail.landSurfaceM2,
    location: detail.location,
    coordinates: coordinateEvidenceToVerifiedCoordinates(
      detail.coordinateEvidence,
      summaryRecord.scrapedAt,
    ) ?? summaryRecord.coordinates,
    sellerName: detail.sellerName,
    sellerType: detail.sellerType,
    postedAt: detail.postedAt,
    description: detail.description,
    energyClass: detail.energyClass,
    gesClass: detail.gesClass,
    imageUrls,
    imageUrl: imageUrls?.[0],
    features: [...detail.features],
    status: "detailed",
    rawTextSample: detail.rawTextSample,
  };
}

function mergeImageUrls(...groups: Array<string[] | undefined>): string[] | undefined {
  const urls = Array.from(new Set(groups.flatMap((group) => group ?? [])));
  return urls.length > 0 ? urls : undefined;
}

function recordFromFailure(
  summary: ListingSummary,
  runId: string,
  error: LocalizedText,
): ScrapedPropertyRecord {
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
  const byListingId = new Map(existing.map((record) => [recordKey(record), record]));

  for (const record of incoming) {
    const key = recordKey(record);
    const previous = byListingId.get(key);
    byListingId.set(key, {
      ...record,
      coordinates: selectBestCoordinates(previous?.coordinates, record.coordinates),
    });
  }

  return Array.from(byListingId.values())
    .sort((a, b) => b.scrapedAt.localeCompare(a.scrapedAt))
    .slice(0, MAX_STORED_RECORDS);
}

function recordKey(record: ScrapedPropertyRecord): string {
  return `${record.source}:${record.id}`;
}

const browserTabGateway: RunnerTabGateway = {
  getCurrent: getCurrentTab,
  get: getTab,
  create: createTab,
  update: updateTab,
  remove: removeTab,
  waitForComplete: waitForTabComplete,
  waitForUrl: waitForTabUrl,
  sendMessage: sendContentMessage,
};

function getCurrentTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.getCurrent((tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function createTab(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
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
      if (error) reject(new Error(error.message));
      else resolve();
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

function waitForTabUrl(
  tabId: number,
  predicate: (url: URL) => boolean,
  timeoutMs = 45_000,
  signal?: AbortSignal,
): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Scrape cancelled."));
      return;
    }

    let finished = false;
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (tab: chrome.tabs.Tab) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(tab);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };
    const inspect = async () => {
      try {
        const tab = await getTab(tabId);
        if (tab.url && isMatchingUrl(tab.url, predicate)) finish(tab);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.url && isMatchingUrl(changeInfo.url, predicate)) {
        finish({ ...tab, url: changeInfo.url });
        return;
      }
      void inspect();
    };
    const handleAbort = () => fail(new Error("Scrape cancelled."));
    const timeout = globalThis.setTimeout(
      () => fail(new Error("Timed out waiting for Leboncoin search navigation.")),
      timeoutMs,
    );

    chrome.tabs.onUpdated.addListener(listener);
    signal?.addEventListener("abort", handleAbort, { once: true });
    void inspect();
  });
}

async function sendContentMessage(
  tabId: number,
  message: ContentRequest,
  attempts = 8,
  signal?: AbortSignal,
): Promise<ContentResponse> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new Error("Scrape cancelled.");
    try {
      return await new Promise<ContentResponse>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener("abort", handleAbort);
        const handleAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Scrape cancelled."));
        };
        signal?.addEventListener("abort", handleAbort, { once: true });
        chrome.tabs.sendMessage(tabId, message, (response: ContentResponse | undefined) => {
          const error = chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          cleanup();

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
      if (signal?.aborted) throw new Error("Scrape cancelled.");
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(400 + attempt * 200, signal);
    }
  }

  throw lastError ?? new Error("Unable to talk to content script.");
}

function toNativeSearchFilters(filters: SearchFilters): NativeSearchFilters {
  return {
    category: filters.category,
    text: filters.text,
    locationQuery: filters.locationQuery,
    propertyTypes: [...filters.propertyTypes],
    ownerType: filters.ownerType,
    priceMin: filters.priceMin,
    priceMax: filters.priceMax,
    roomsMin: filters.roomsMin,
    roomsMax: filters.roomsMax,
    bedroomsMin: filters.bedroomsMin,
    bedroomsMax: filters.bedroomsMax,
    squareMin: filters.squareMin,
    squareMax: filters.squareMax,
    sort: filters.sort,
    order: filters.order,
  };
}

function nativeRetryRequest(
  phase: "results-applied" | "pagination-advanced",
): ContentRequest {
  return phase === "results-applied"
    ? { type: "LBC_APPLY_RESULTS_FILTERS" }
    : { type: "LBC_GO_NEXT_RESULTS_PAGE" };
}

function mergeListingPages(
  existing: ListingSummary[],
  incoming: ListingSummary[],
  limit: number,
): ListingSummary[] {
  const byListingId = new Map(existing.map((listing) => [listingKey(listing), listing]));
  for (const listing of incoming) {
    if (!byListingId.has(listingKey(listing))) {
      byListingId.set(listingKey(listing), listing);
    }
  }
  return Array.from(byListingId.values()).slice(0, limit);
}

function listingKey(listing: ListingSummary): string {
  return `${listing.source}:${listing.id}`;
}

function isSafeSearchUrl(value: string): boolean {
  try {
    return isLeboncoinSearchUrl(new URL(value));
  } catch {
    return false;
  }
}

function isMatchingUrl(value: string, predicate: (url: URL) => boolean): boolean {
  try {
    return predicate(new URL(value));
  } catch {
    return false;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTabLoadTimeout(error: unknown): boolean {
  return errorMessage(error) === "Timed out waiting for tab load.";
}

function defaultEvaluator(
  runId: string,
  recipe: IntelligenceRecipe,
  records: ScrapedPropertyRecord[],
  locale: LocaleCode,
  signal: AbortSignal,
  onBatchComplete?: (
    batch: ListingEvaluationOutcome,
    accumulated: ListingEvaluationOutcome,
  ) => void | Promise<void>,
): Promise<ListingEvaluationOutcome> {
  return requestImmediateSync().then((response) => {
    if (!response.ok) {
      return createEvaluationFailureOutcome(records, new FilterApiError(
        "Listings could not be synchronized before evaluation.",
        undefined,
        "SYNC_FAILED",
      ));
    }
    return evaluateDetailedRecordsInBatches(runId, recipe, records, {
      locale,
      signal,
      onBatchComplete,
    });
  });
}

interface IntelligencePhaseOptions {
  run: ScrapeRun;
  records: ScrapedPropertyRecord[];
  recipe: IntelligenceRecipe;
  locale?: LocaleCode;
  evaluator: ListingEvaluator;
  signal: AbortSignal;
  persist: (run: ScrapeRun, records: ScrapedPropertyRecord[]) => Promise<void>;
}

export async function runIntelligencePhase({
  run,
  records,
  recipe,
  locale = DEFAULT_LOCALE,
  evaluator,
  signal,
  persist,
}: IntelligencePhaseOptions): Promise<ScrapedPropertyRecord[]> {
  const detailedRecords = records.filter(
    (record) => record.searchRunId === run.id && record.status === "detailed",
  );
  run.status = "evaluating";
  run.currentUrl = undefined;
  run.intelligenceStatus = "evaluating";
  run.intelligenceError = undefined;
  run.message = message("run.evaluating", { count: detailedRecords.length });
  await persist(run, records);

  let latestRecords = records;
  const resolvedListingIds = new Set<string>();
  try {
    const outcome = await evaluator(
      run.id,
      recipe,
      detailedRecords,
      locale,
      signal,
      async (batch, accumulated) => {
        latestRecords = mergeRecordEvaluationOutcome(latestRecords, batch);
        applyEvaluationCounts(run, accumulated.evaluations);
        await persist(run, latestRecords);
        for (const listingId of [
          ...batch.evaluations.map((item) => item.listingId),
          ...batch.failures.map((item) => item.listingId),
        ]) {
          resolvedListingIds.add(listingId);
        }
      },
    );
    const evaluatedRecords = mergeRecordEvaluationOutcome(latestRecords, outcome);
    applyEvaluationCounts(run, outcome.evaluations);
    run.status = "completed";
    run.intelligenceStatus = outcome.failures.length === 0
      ? "completed"
      : outcome.evaluations.length > 0
        ? "partial"
        : "failed";
    run.intelligenceError = outcome.failures[0]
      ? evaluationFailureDescriptor(outcome.failures[0])
      : undefined;
    run.message = outcome.failures.length === 0
      ? message("run.evaluated", { count: outcome.evaluations.length })
      : outcome.evaluations.length > 0
        ? message("run.intelligencePartial", {
            evaluated: outcome.evaluations.length,
            pending: outcome.failures.length,
            total: outcome.evaluations.length + outcome.failures.length,
          })
        : message("run.intelligenceFailedPreserved");
    await persist(run, evaluatedRecords);
    return evaluatedRecords;
  } catch (error) {
    if (signal.aborted) throw error;
    const unresolvedRecords = detailedRecords.filter((record) => !resolvedListingIds.has(record.id));
    const failureOutcome = createEvaluationFailureOutcome(unresolvedRecords, error);
    latestRecords = mergeRecordEvaluationOutcome(latestRecords, failureOutcome);
    const detailedIds = new Set(detailedRecords.map((record) => record.id));
    const currentRecords = latestRecords.filter((record) => detailedIds.has(record.id));
    const failures = currentRecords.flatMap((record) => (
      record.evaluationFailure ? [record.evaluationFailure] : []
    ));
    const evaluations = currentRecords.flatMap((record) => (
      record.evaluation && !record.evaluationFailure ? [record.evaluation] : []
    ));
    applyEvaluationCounts(run, evaluations);
    run.status = "completed";
    run.intelligenceStatus = evaluations.length > 0 ? "partial" : "failed";
    run.intelligenceError = filterApiErrorDescriptor(error);
    run.message = evaluations.length > 0
      ? message("run.intelligencePartial", {
          evaluated: evaluations.length,
          pending: failures.length,
          total: evaluations.length + failures.length,
        })
      : message("run.intelligenceFailedPreserved");
    await persist(run, latestRecords);
    return latestRecords;
  }
}

function applyEvaluationCounts(run: ScrapeRun, evaluations: ListingEvaluation[]): void {
  run.evaluated = evaluations.length;
  run.relevant = evaluations.filter((evaluation) => evaluation.decision === "relevant").length;
  run.notRelevant = evaluations.filter((evaluation) => evaluation.decision === "not-relevant").length;
  run.review = evaluations.filter((evaluation) => evaluation.decision === "review").length;
}
