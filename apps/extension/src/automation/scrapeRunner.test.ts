import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSearchFilters } from "../lib/leboncoinSearch";
import type {
  ContentRequest,
  ContentResponse,
  NativeResultsStep,
  NativeSearchPhase,
  NativeSearchResponse,
} from "../lib/messages";
import type {
  IntelligenceRecipe,
  ListingDetail,
  ListingEvaluation,
  ListingSummary,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
} from "../lib/types";
import {
  ScrapeRunner,
  runIntelligencePhase,
  type RunnerClock,
  type RunnerTabGateway,
} from "./scrapeRunner";
import type { RunnerSnapshot } from "./runnerSnapshot";

const storageMocks = vi.hoisted(() => ({
  loadCrawlerState: vi.fn(),
  saveCrawlerState: vi.fn(),
}));

vi.mock("../storage/chromeStorage", () => storageMocks);

const DASHBOARD_TAB_ID = 10;
const HOME_TAB_ID = 20;
const WINDOW_ID = 7;
const FOREIGN_TAB_IDS = [90, 91];
const HOME_URL = "https://www.leboncoin.fr/";
const OBSERVED_SEARCH_URL =
  "https://www.leboncoin.fr/recherche?category=9&locations=Finist%C3%A8re&real_estate_type=1";
const STAGED_SEARCH_URLS = [
  "https://www.leboncoin.fr/recherche?kst=k",
  "https://www.leboncoin.fr/recherche?locations=d_29&kst=k",
  "https://www.leboncoin.fr/recherche?category=9&locations=d_29&kst=k",
  "https://www.leboncoin.fr/recherche?category=9&locations=d_29&real_estate_type=1&kst=k",
  "https://www.leboncoin.fr/recherche?category=9&locations=d_29&real_estate_type=1&rooms=2-2&kst=k",
  "https://www.leboncoin.fr/recherche?category=9&locations=d_29&real_estate_type=1&rooms=2-3&kst=k",
  "https://www.leboncoin.fr/recherche?category=9&locations=d_29&real_estate_type=1&price=0-120000&rooms=2-3&kst=k",
] as const;

const SOURCE_LOCALITY_EVIDENCE = {
  latitude: 47.856373,
  longitude: -3.8512979,
  locationKind: "source-locality" as const,
  provenance:
    'leboncoin:__NEXT_DATA__.props.pageProps.ad.location:{"source":"city","provider":"here","type":"city","origin_type":"city","is_shape":true}',
};

beforeEach(() => {
  storageMocks.loadCrawlerState.mockReset().mockResolvedValue({ records: [] });
  storageMocks.saveCrawlerState.mockReset().mockResolvedValue(undefined);
});

function searchFilters(patch: Partial<SearchFilters> = {}): SearchFilters {
  return {
    ...createDefaultSearchFilters(),
    locationQuery: "Finistère",
    propertyTypes: ["1"],
    maxListings: 1,
    ...patch,
  };
}

function listing(id: string): ListingSummary {
  return {
    source: "leboncoin",
    id,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`,
    title: `Maison ${id}`,
    priceEuros: 120_000,
    features: ["Jardin"],
    rawTextSample: `Maison ${id} avec jardin`,
  };
}

function detail(summary: ListingSummary, patch: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: summary.id,
    url: summary.url,
    title: summary.title,
    priceEuros: summary.priceEuros,
    description: "Maison avec jardin privatif.",
    features: ["Jardin"],
    rawTextSample: `Détail ${summary.id}`,
    ...patch,
  };
}

function nativeResponse(
  phase: NativeSearchPhase,
  patch: Partial<NativeSearchResponse> = {},
): NativeSearchResponse {
  return {
    type: "LBC_NATIVE_SEARCH_RESULT",
    phase,
    ok: true,
    applied: [],
    omitted: [],
    warnings: [],
    ...patch,
  };
}

type ResponseFactory = (
  tabId: number,
  message: ContentRequest,
  gateway: FakeTabGateway,
) => ContentResponse | Promise<ContentResponse>;

class FakeTabGateway implements RunnerTabGateway {
  readonly created: Array<{ id: number; options: chrome.tabs.CreateProperties }> = [];
  readonly updates: Array<{ tabId: number; options: chrome.tabs.UpdateProperties }> = [];
  readonly removed: number[] = [];
  readonly messages: Array<{ tabId: number; message: ContentRequest }> = [];
  readonly touchedTabIds: number[] = [];
  readonly events: string[] = [];
  readonly navigations: string[] = [];
  readonly tabs = new Map<number, chrome.tabs.Tab>();
  private nextTabId = HOME_TAB_ID;
  private nextNavigationIndex = 0;
  private readonly observedSearchUrls: readonly string[];

  constructor(
    private readonly responseFactory: ResponseFactory,
    observedSearchUrls: string | readonly string[] = OBSERVED_SEARCH_URL,
  ) {
    this.observedSearchUrls = typeof observedSearchUrls === "string"
      ? [observedSearchUrls]
      : observedSearchUrls;
    this.tabs.set(DASHBOARD_TAB_ID, tab({
      id: DASHBOARD_TAB_ID,
      windowId: WINDOW_ID,
      url: "chrome-extension://extension-id/dashboard.html",
      active: true,
    }));
    for (const id of FOREIGN_TAB_IDS) {
      this.tabs.set(id, tab({
        id,
        windowId: WINDOW_ID,
        url: `https://www.leboncoin.fr/recherche?foreign=${id}`,
        active: false,
      }));
    }
  }

  async getCurrent(): Promise<chrome.tabs.Tab | undefined> {
    this.events.push("get-current");
    return this.copyTab(DASHBOARD_TAB_ID);
  }

  async get(tabId: number): Promise<chrome.tabs.Tab> {
    this.touch(tabId, `get:${tabId}`);
    return this.copyTab(tabId);
  }

  async create(options: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    const id = this.nextTabId;
    this.nextTabId += 1;
    const created = tab({
      id,
      windowId: options.windowId ?? WINDOW_ID,
      openerTabId: options.openerTabId,
      url: typeof options.url === "string" ? options.url : undefined,
      active: options.active ?? false,
    });
    this.tabs.set(id, created);
    this.created.push({ id, options: { ...options } });
    this.events.push(`create:${id}:${created.url ?? ""}`);
    return { ...created };
  }

  async update(
    tabId: number,
    options: chrome.tabs.UpdateProperties,
  ): Promise<chrome.tabs.Tab | undefined> {
    this.touch(tabId, `update:${tabId}`);
    const current = this.requireTab(tabId);
    const next = { ...current };
    if (options.active !== undefined) next.active = options.active;
    if (typeof options.url === "string") next.url = options.url;
    this.tabs.set(tabId, next);
    this.updates.push({ tabId, options: { ...options } });
    return { ...next };
  }

  async remove(tabId: number): Promise<void> {
    this.touch(tabId, `remove:${tabId}`);
    this.requireTab(tabId);
    this.removed.push(tabId);
    this.tabs.delete(tabId);
  }

  async waitForComplete(
    tabId: number,
    _timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertActive(signal);
    this.touch(tabId, `complete:${tabId}`);
    this.requireTab(tabId);
  }

  async waitForUrl(
    tabId: number,
    predicate: (url: URL) => boolean,
    _timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<chrome.tabs.Tab> {
    this.assertActive(signal);
    this.touch(tabId, `wait-url:${tabId}`);
    const current = this.requireTab(tabId);
    const observedSearchUrl = this.observedSearchUrls[this.nextNavigationIndex];
    if (!observedSearchUrl) {
      throw new Error("No test search navigation was queued.");
    }
    const next = { ...current, url: observedSearchUrl };
    if (!predicate(new URL(observedSearchUrl))) {
      throw new Error("Test search URL did not satisfy the runner predicate.");
    }
    this.nextNavigationIndex += 1;
    this.navigations.push(observedSearchUrl);
    this.tabs.set(tabId, next);
    return { ...next };
  }

  async sendMessage(
    tabId: number,
    message: ContentRequest,
    _attempts: number,
    signal?: AbortSignal,
  ): Promise<ContentResponse> {
    this.assertActive(signal);
    this.touch(tabId, `message:${tabId}:${message.type}`);
    this.requireTab(tabId);
    this.messages.push({ tabId, message });
    return this.responseFactory(tabId, message, this);
  }

  tabUrl(tabId: number): string | undefined {
    return this.requireTab(tabId).url;
  }

  private touch(tabId: number, event: string): void {
    this.touchedTabIds.push(tabId);
    this.events.push(event);
  }

  private requireTab(tabId: number): chrome.tabs.Tab {
    const current = this.tabs.get(tabId);
    if (!current) throw new Error(`Unknown test tab ${tabId}.`);
    return current;
  }

  private copyTab(tabId: number): chrome.tabs.Tab {
    return { ...this.requireTab(tabId) };
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Scrape cancelled.");
  }
}

class DetailLoadTimeoutGateway extends FakeTabGateway {
  detailLoadTimeouts = 0;

  override async waitForComplete(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.tabUrl(tabId)?.includes("/ad/")) {
      this.detailLoadTimeouts += 1;
      throw new Error("Timed out waiting for tab load.");
    }
    await super.waitForComplete(tabId, timeoutMs, signal);
  }
}

class LeboncoinLoadTimeoutGateway extends FakeTabGateway {
  loadTimeouts = 0;

  override async waitForComplete(
    tabId: number,
    _timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.tabUrl(tabId)?.startsWith("https://www.leboncoin.fr/")) {
      this.loadTimeouts += 1;
      throw new Error("Timed out waiting for tab load.");
    }
    await super.waitForComplete(tabId, _timeoutMs, signal);
  }
}

class SecondSearchPageFailureGateway extends FakeTabGateway {
  pageTwoLoadObservations = 0;

  override async waitForComplete(
    tabId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.tabUrl(tabId)?.includes("page=2")) {
      this.pageTwoLoadObservations += 1;
      if (this.pageTwoLoadObservations === 2) {
        throw new Error("The second search page became unavailable.");
      }
    }
    await super.waitForComplete(tabId, timeoutMs, signal);
  }
}

class DeterministicClock implements RunnerClock {
  readonly sleeps: number[] = [];
  private elapsedMs = 0;

  constructor(
    private readonly events?: string[],
    private readonly onSleep?: (milliseconds: number, signal?: AbortSignal) => void | Promise<void>,
  ) {}

  now(): number {
    return this.elapsedMs;
  }

  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Scrape cancelled.");
    this.sleeps.push(milliseconds);
    this.events?.push(`sleep:${milliseconds}`);
    this.elapsedMs += milliseconds;
    await this.onSleep?.(milliseconds, signal);
    if (signal?.aborted) throw new Error("Scrape cancelled.");
  }
}

function tab(fields: {
  id: number;
  windowId: number;
  url?: string;
  openerTabId?: number;
  active: boolean;
}): chrome.tabs.Tab {
  return {
    ...fields,
    status: "complete",
    index: 0,
    pinned: false,
    highlighted: fields.active,
    incognito: false,
    selected: fields.active,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
  } as chrome.tabs.Tab;
}

function happyResponseFactory(
  listings: ListingSummary[],
  options: {
    detailFor?: (summary: ListingSummary) => ListingDetail;
    nativeWarnings?: Partial<Record<NativeSearchPhase, NativeSearchResponse["warnings"]>>;
  } = {},
): ResponseFactory {
  let resultsCommitted = false;

  return (_tabId, message, gateway) => {
    if (message.type === "LBC_PREPARE_RESULTS_FILTERS") {
      return nativeResponse("results-prepared", {
        step: resultsCommitted ? "complete" : "filters",
        warnings: options.nativeWarnings?.["results-prepared"] ?? [],
      });
    }

    if (message.type === "LBC_APPLY_RESULTS_FILTERS") {
      resultsCommitted = true;
      return nativeResponse("results-applied", {
        step: "filters",
        warnings: options.nativeWarnings?.["results-applied"] ?? [],
      });
    }

    if (message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE") {
      return nativeResponse("pagination-prepared", { hasNextPage: false });
    }

    if (message.type === "LBC_GO_NEXT_RESULTS_PAGE") {
      return nativeResponse("pagination-advanced", {
        hasNextPage: true,
        navigationExpected: true,
      });
    }

    const phase = nativePhase(message);
    if (phase) {
      return nativeResponse(phase, { warnings: options.nativeWarnings?.[phase] ?? [] });
    }

    if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
      return {
        type: "LBC_SEARCH_RESULTS",
        captcha: false,
        ready: true,
        listings,
      };
    }

    const currentUrl = gateway.tabUrl(_tabId);
    const summary = listings.find((candidate) => candidate.url === currentUrl);
    if (!summary) throw new Error(`No detail fixture exists for ${currentUrl ?? "this tab"}.`);
    return {
      type: "LBC_DETAIL",
      captcha: false,
      ready: true,
      detail: options.detailFor?.(summary) ?? detail(summary),
    };
  };
}

function stagedResultsHarness(
  listings: ListingSummary[],
  onApply?: (
    step: Exclude<NativeResultsStep, "complete">,
    attempt: number,
  ) => Partial<NativeSearchResponse> | undefined,
) {
  const fallback = happyResponseFactory(listings);
  const steps = [
    "location",
    "category",
    "property-types",
    "rooms-min",
    "rooms-max",
    "filters",
  ] as const;
  const preparedSteps: NativeResultsStep[] = [];
  const appliedSteps: NativeResultsStep[] = [];
  const applyAttempts = new Map<NativeResultsStep, number>();
  let stepIndex = 0;
  let armedStep: Exclude<NativeResultsStep, "complete"> | undefined;

  const responseFactory: ResponseFactory = (tabId, message, gateway) => {
    if (message.type === "LBC_PREPARE_RESULTS_FILTERS") {
      if (armedStep) {
        throw new Error(`The runner prepared ${steps[stepIndex]} before applying ${armedStep}.`);
      }
      const step = (steps as readonly NativeResultsStep[])[stepIndex] ?? "complete";
      preparedSteps.push(step);
      if (step === "complete") {
        return nativeResponse("results-prepared", { step });
      }
      armedStep = step;
      return nativeResponse("results-prepared", {
        step,
        navigationExpected: true,
      });
    }

    if (message.type === "LBC_APPLY_RESULTS_FILTERS") {
      if (!armedStep) {
        throw new Error("The runner applied results filters without a fresh prepare handshake.");
      }
      const step = armedStep;
      const attempt = (applyAttempts.get(step) ?? 0) + 1;
      applyAttempts.set(step, attempt);
      const override = onApply?.(step, attempt);
      const response = nativeResponse("results-applied", {
        step,
        navigationExpected: true,
        ...override,
      });
      if (response.ok || response.actionExecuted === true) {
        appliedSteps.push(step);
        armedStep = undefined;
        stepIndex += 1;
      }
      return response;
    }

    return fallback(tabId, message, gateway);
  };

  return {
    appliedSteps,
    applyAttempts,
    preparedSteps,
    responseFactory,
  };
}

function nativePhase(message: ContentRequest): NativeSearchPhase | undefined {
  switch (message.type) {
    case "LBC_PREPARE_HOME_SEARCH":
      return "home-prepared";
    case "LBC_SUBMIT_HOME_SEARCH":
      return "home-submitted";
    case "LBC_PREPARE_RESULTS_FILTERS":
      return "results-prepared";
    case "LBC_APPLY_RESULTS_FILTERS":
      return "results-applied";
    case "LBC_PREPARE_NEXT_RESULTS_PAGE":
      return "pagination-prepared";
    case "LBC_GO_NEXT_RESULTS_PAGE":
      return "pagination-advanced";
    default:
      return undefined;
  }
}

interface CapturedSnapshot {
  run: ScrapeRun;
  records: readonly ScrapedPropertyRecord[];
}

function snapshotCollector() {
  const snapshots: CapturedSnapshot[] = [];
  const waiters: Array<{
    status: ScrapeRun["status"];
    count: number;
    resolve: () => void;
  }> = [];

  const countStatus = (status: ScrapeRun["status"]) =>
    snapshots.filter((snapshot) => snapshot.run.status === status).length;

  return {
    snapshots,
    observer(snapshot: CapturedSnapshot) {
      snapshots.push({
        run: {
          ...snapshot.run,
          filterWarnings: snapshot.run.filterWarnings.map((warning) => ({ ...warning })),
        },
        records: snapshot.records.map((storedRecord) => ({ ...storedRecord })),
      });
      for (const waiter of [...waiters]) {
        if (waiter.status === snapshot.run.status && countStatus(waiter.status) >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    latest(): CapturedSnapshot {
      const latest = snapshots.at(-1);
      if (!latest) throw new Error("The runner did not emit a snapshot.");
      return latest;
    },
    waitFor(status: ScrapeRun["status"], count = 1): Promise<void> {
      if (countStatus(status) >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ status, count, resolve }));
    },
  };
}

function createRunner(
  collector: ReturnType<typeof snapshotCollector>,
  tabs: RunnerTabGateway,
  clock: RunnerClock,
  random: () => number = () => 0.5,
): ScrapeRunner {
  return new ScrapeRunner(
    collector.observer,
    vi.fn(async () => ({ evaluations: [], failures: [] })),
    { tabs, clock, random },
  );
}

async function flushMicrotasks(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

describe("scrape runner native browser orchestration", () => {
  it("does not create a search tab when cancelled while resolving the dashboard tab", async () => {
    const gateway = new FakeTabGateway(happyResponseFactory([listing("3007106001")]));
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));
    const originalGetCurrent = gateway.getCurrent.bind(gateway);
    vi.spyOn(gateway, "getCurrent").mockImplementation(async () => {
      runner.cancel();
      return originalGetCurrent();
    });

    await runner.run(searchFilters());

    expect(collector.latest().run.status).toBe("cancelled");
    expect(gateway.created).toEqual([]);
    expect(gateway.updates).toEqual([]);
    expect(gateway.removed).toEqual([]);
  });

  it("shares unchanged observer collections and isolates persisted state from observer mutations", async () => {
    const result = listing("3007106001");
    const gateway = new FakeTabGateway(happyResponseFactory([result]));
    const observed: RunnerSnapshot[] = [];
    const runner = new ScrapeRunner((snapshot) => {
      observed.push(snapshot);
      expect(() => snapshot.run.filterWarnings.push({ field: "observer", message: "Injected" })).toThrow(TypeError);
      if (snapshot.records[0]) {
        expect(() => snapshot.records[0].features.push("Injected")).toThrow(TypeError);
      }
    }, undefined, { tabs: gateway, clock: new DeterministicClock(gateway.events), random: () => 0.5 });

    await runner.run(searchFilters({ collectDetailPages: false }));

    expect(observed.at(-1)?.run.status).toBe("completed");
    const recordWrites = storageMocks.saveCrawlerState.mock.calls.filter(([state]) => state.records);
    expect(new Set(observed.map((snapshot) => snapshot.records)).size).toBe(recordWrites.length);
    expect(observed.length).toBeGreaterThan(recordWrites.length);
    expect(observed[0].run.status).toBe("opening-search");
    for (const [state] of storageMocks.saveCrawlerState.mock.calls) {
      expect(state.run.filterWarnings).not.toContainEqual({ field: "observer", message: "Injected" });
      expect(state.records?.flatMap((record: ScrapedPropertyRecord) => record.features) ?? []).not.toContain("Injected");
    }
  });

  it("retries the unsaved record delta after a rejected storage write", async () => {
    const runner = new ScrapeRunner(() => undefined) as unknown as {
      persist(run: ScrapeRun, records: ScrapedPropertyRecord[], filters: SearchFilters): Promise<void>;
    };
    const activeRun = run();
    const filters = searchFilters();
    const baseline: ScrapedPropertyRecord[] = [];
    const captured = [record("3007106001", "listing")];
    await runner.persist(activeRun, baseline, filters);
    storageMocks.saveCrawlerState.mockRejectedValueOnce(new Error("Synthetic storage failure"));

    await expect(runner.persist(activeRun, captured, filters)).rejects.toThrow("Synthetic storage failure");
    await runner.persist(activeRun, captured, filters);

    const retry = storageMocks.saveCrawlerState.mock.calls.at(-1)!;
    expect(retry[0].records).toBe(captured);
    expect(retry[1].previousRecords).toBe(baseline);
  });

  it("revalidates a single results filter pass as complete before collecting", async () => {
    const result = listing("3007106001");
    const gateway = new FakeTabGateway(
      happyResponseFactory([result], {
        nativeWarnings: {
          "results-prepared": [{ field: "squareMax", message: "Surface maximum was unavailable." }],
        },
      }),
    );
    const clock = new DeterministicClock(gateway.events);
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, clock);

    await runner.run(searchFilters({ collectDetailPages: false }));

    expect(gateway.created).toEqual([
      {
        id: HOME_TAB_ID,
        options: {
          url: "about:blank",
          active: true,
          windowId: WINDOW_ID,
          openerTabId: DASHBOARD_TAB_ID,
        },
      },
    ]);
    expect(gateway.messages.map(({ message }) => message.type).filter((type) => type.startsWith("LBC_PREPARE") || type.startsWith("LBC_SUBMIT") || type.startsWith("LBC_APPLY"))).toEqual([
      "LBC_PREPARE_HOME_SEARCH",
      "LBC_SUBMIT_HOME_SEARCH",
      "LBC_PREPARE_RESULTS_FILTERS",
      "LBC_APPLY_RESULTS_FILTERS",
      "LBC_PREPARE_RESULTS_FILTERS",
    ]);
    expect(gateway.updates[0]).toEqual({
      tabId: HOME_TAB_ID,
      options: { url: HOME_URL, active: true },
    });
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      searchUrl: OBSERVED_SEARCH_URL,
      found: 1,
      collected: 1,
      filterWarnings: [{
        field: "squareMax",
        message: { id: "legacy.message", technicalDetail: "Surface maximum was unavailable." },
      }],
    });
    expect(gateway.updates.at(-1)).toEqual({
      tabId: DASHBOARD_TAB_ID,
      options: { active: true },
    });
    expect(gateway.navigations).toEqual([OBSERVED_SEARCH_URL]);
    expect(gateway.touchedTabIds).not.toEqual(expect.arrayContaining(FOREIGN_TAB_IDS));
  });

  it("paginates natively until 70 unique listings are persisted in page batches", async () => {
    const pages = [
      Array.from({ length: 30 }, (_, index) => listing(String(3_007_106_001 + index))),
      Array.from({ length: 35 }, (_, index) => listing(String(3_007_106_031 + index))),
      [
        ...Array.from({ length: 10 }, (_, index) => listing(String(3_007_106_001 + index))),
        ...Array.from({ length: 5 }, (_, index) => listing(String(3_007_106_066 + index))),
      ],
    ];
    const pageUrls = [
      `${OBSERVED_SEARCH_URL}&page=1`,
      `${OBSERVED_SEARCH_URL}&page=2`,
      `${OBSERVED_SEARCH_URL}&page=3`,
    ];
    const fallback = happyResponseFactory([]);
    const responseFactory: ResponseFactory = (tabId, message, gateway) => {
      const pageIndex = Math.max(0, Number(new URL(gateway.tabUrl(tabId) ?? pageUrls[0]).searchParams.get("page") ?? "1") - 1);
      if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
        return {
          type: "LBC_SEARCH_RESULTS",
          captcha: false,
          ready: true,
          listings: pages[pageIndex].slice(0, message.limit),
        };
      }
      if (message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE") {
        return nativeResponse("pagination-prepared", { hasNextPage: pageIndex < pages.length - 1 });
      }
      if (message.type === "LBC_GO_NEXT_RESULTS_PAGE") {
        return nativeResponse("pagination-advanced", {
          hasNextPage: true,
          navigationExpected: true,
        });
      }
      return fallback(tabId, message, gateway);
    };
    const gateway = new FakeTabGateway(responseFactory, pageUrls);
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 70, collectDetailPages: false }));

    expect(collector.latest().run).toMatchObject({
      status: "completed",
      target: 70,
      found: 70,
      pagesVisited: 3,
      collected: 70,
      searchUrl: pageUrls[0],
    });
    expect(collector.latest().records).toHaveLength(70);
    expect(new Set(collector.latest().records.map((record) => record.id)).size).toBe(70);
    expect(gateway.navigations).toEqual(pageUrls);
    expect(gateway.messages.filter(({ message }) =>
      message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE"
    )).toHaveLength(2);
    expect(gateway.messages.filter(({ message }) =>
      message.type === "LBC_GO_NEXT_RESULTS_PAGE"
    )).toHaveLength(2);
    expect(new Set(gateway.messages.flatMap(({ message }) =>
      message.type === "LBC_COLLECT_SEARCH_RESULTS" ? [message.limit] : []
    ))).toEqual(new Set([100]));
    expect(gateway.touchedTabIds).not.toEqual(expect.arrayContaining(FOREIGN_TAB_IDS));
  });

  it("uses the content-script handshake when Leboncoin never reports load complete", async () => {
    const result = listing("3007106071");
    const gateway = new LeboncoinLoadTimeoutGateway(happyResponseFactory([result]));
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 1, collectDetailPages: false }));

    expect(gateway.loadTimeouts).toBeGreaterThan(0);
    expect(gateway.messages.some(({ message }) => message.type === "LBC_COLLECT_SEARCH_RESULTS")).toBe(true);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      pagesVisited: 1,
      collected: 1,
    });
    expect(collector.latest().records).toEqual([
      expect.objectContaining({ id: result.id, status: "listing" }),
    ]);
  });

  it("persists stable source-locality evidence from a search result", async () => {
    const result = {
      ...listing("3007106074"),
      coordinateEvidence: SOURCE_LOCALITY_EVIDENCE,
    };
    const gateway = new FakeTabGateway(happyResponseFactory([result]));
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 1, collectDetailPages: false }));

    expect(collector.latest().records.at(0)?.coordinates).toEqual({
      ...SOURCE_LOCALITY_EVIDENCE,
      verifiedAt: expect.any(String),
    });
  });

  it("uses detail coordinate evidence and falls back to summary evidence", async () => {
    const detailOnly = listing("3007106075");
    const summaryFallback = {
      ...listing("3007106076"),
      coordinateEvidence: SOURCE_LOCALITY_EVIDENCE,
    };
    const gateway = new FakeTabGateway(happyResponseFactory(
      [detailOnly, summaryFallback],
      {
        detailFor: (summary) => detail(summary, {
          coordinateEvidence: summary.id === detailOnly.id
            ? SOURCE_LOCALITY_EVIDENCE
            : undefined,
        }),
      },
    ));
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 2, collectDetailPages: true }));

    expect(collector.latest().records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: detailOnly.id,
        coordinates: expect.objectContaining(SOURCE_LOCALITY_EVIDENCE),
      }),
      expect.objectContaining({
        id: summaryFallback.id,
        coordinates: expect.objectContaining(SOURCE_LOCALITY_EVIDENCE),
      }),
    ]));
  });

  it("keeps the original verification timestamp when a bounded backfill sees the same coordinates", async () => {
    const id = "3007106077";
    const historical = {
      ...record(id, "detailed"),
      coordinates: {
        ...SOURCE_LOCALITY_EVIDENCE,
        verifiedAt: "2026-07-18T10:00:00.000Z",
      },
    };
    storageMocks.loadCrawlerState.mockResolvedValue({ records: [historical] });
    const result = { ...listing(id), coordinateEvidence: SOURCE_LOCALITY_EVIDENCE };
    const gateway = new FakeTabGateway(happyResponseFactory([result]));
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 1, collectDetailPages: false }));

    expect(collector.latest().records.at(0)?.coordinates).toEqual(historical.coordinates);
  });

  it("preserves historical and page-one records when the next search page fails", async () => {
    const historical = record("2999999999", "detailed");
    storageMocks.loadCrawlerState.mockResolvedValue({ records: [historical] });
    const firstPage = [listing("3007106072"), listing("3007106073")];
    const pageUrls = [
      `${OBSERVED_SEARCH_URL}&page=1`,
      `${OBSERVED_SEARCH_URL}&page=2`,
    ];
    const fallback = happyResponseFactory([]);
    const responseFactory: ResponseFactory = (tabId, message, gateway) => {
      const page = Number(new URL(gateway.tabUrl(tabId) ?? pageUrls[0]).searchParams.get("page") ?? "1");
      if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
        return {
          type: "LBC_SEARCH_RESULTS",
          captcha: false,
          ready: true,
          listings: page === 1 ? firstPage : [],
        };
      }
      if (message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE") {
        return nativeResponse("pagination-prepared", { hasNextPage: page === 1 });
      }
      if (message.type === "LBC_GO_NEXT_RESULTS_PAGE") {
        return nativeResponse("pagination-advanced", {
          hasNextPage: true,
          navigationExpected: true,
        });
      }
      return fallback(tabId, message, gateway);
    };
    const gateway = new SecondSearchPageFailureGateway(responseFactory, pageUrls);
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({ maxListings: 3, collectDetailPages: false }));

    expect(gateway.pageTwoLoadObservations).toBe(2);
    expect(collector.latest().run).toMatchObject({
      status: "failed",
      found: 2,
      pagesVisited: 2,
      error: {
        id: "error.crawlFailed",
        technicalDetail: "The second search page became unavailable.",
      },
    });
    expect(new Set(collector.latest().records.map(({ id }) => id))).toEqual(new Set([
      historical.id,
      ...firstPage.map(({ id }) => id),
    ]));

    const persistedRecordSnapshots = storageMocks.saveCrawlerState.mock.calls.flatMap(([state]) =>
      state.records ? [state.records as ScrapedPropertyRecord[]] : []
    );
    expect(new Set(persistedRecordSnapshots.at(-1)?.map(({ id }) => id))).toEqual(new Set([
      historical.id,
      ...firstPage.map(({ id }) => id),
    ]));
  });

  it("re-handshakes after each staged results navigation and records only the final observed URL", async () => {
    const result = listing("3007106001");
    const harness = stagedResultsHarness([result]);
    const gateway = new FakeTabGateway(harness.responseFactory, STAGED_SEARCH_URLS);
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    await runner.run(searchFilters({
      collectDetailPages: false,
      priceMax: 120_000,
      roomsMin: 2,
      roomsMax: 3,
    }));

    expect(harness.preparedSteps).toEqual([
      "location",
      "category",
      "property-types",
      "rooms-min",
      "rooms-max",
      "filters",
      "complete",
    ]);
    expect(harness.appliedSteps).toEqual([
      "location",
      "category",
      "property-types",
      "rooms-min",
      "rooms-max",
      "filters",
    ]);
    expect(Object.fromEntries(harness.applyAttempts)).toEqual({
      location: 1,
      category: 1,
      "property-types": 1,
      "rooms-min": 1,
      "rooms-max": 1,
      filters: 1,
    });
    expect(gateway.navigations).toEqual(STAGED_SEARCH_URLS);

    const firstResultsPrepare = gateway.events.indexOf(
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
    );
    expect(firstResultsPrepare).toBeGreaterThan(-1);
    const firstCollection = gateway.events.indexOf(
      `message:${HOME_TAB_ID}:LBC_COLLECT_SEARCH_RESULTS`,
      firstResultsPrepare,
    );
    expect(firstCollection).toBeGreaterThan(firstResultsPrepare);
    expect(gateway.events.slice(firstResultsPrepare, firstCollection + 1).filter((event) =>
      event === `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS` ||
      event === `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS` ||
      event === `message:${HOME_TAB_ID}:LBC_COLLECT_SEARCH_RESULTS` ||
      event === `wait-url:${HOME_TAB_ID}` ||
      event === `complete:${HOME_TAB_ID}`
    )).toEqual([
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
      `wait-url:${HOME_TAB_ID}`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      `complete:${HOME_TAB_ID}`,
      `message:${HOME_TAB_ID}:LBC_COLLECT_SEARCH_RESULTS`,
    ]);
    const finalRevalidation = gateway.events.lastIndexOf(
      `message:${HOME_TAB_ID}:LBC_PREPARE_RESULTS_FILTERS`,
      firstCollection,
    );
    expect(finalRevalidation).toBeGreaterThan(firstResultsPrepare);
    expect(finalRevalidation).toBeLessThan(firstCollection);
    expect(gateway.events.slice(finalRevalidation + 1, firstCollection)).not.toContain(
      `message:${HOME_TAB_ID}:LBC_APPLY_RESULTS_FILTERS`,
    );
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      searchUrl: STAGED_SEARCH_URLS.at(-1),
      found: 1,
      collected: 1,
    });
    expect(gateway.touchedTabIds).not.toEqual(expect.arrayContaining(FOREIGN_TAB_IDS));
  });

  it("opens detail tabs sequentially, closes successful details, and applies deterministic pacing plus cooldown", async () => {
    const listings = [listing("3007106001"), listing("3007106002")];
    const gateway = new FakeTabGateway(happyResponseFactory(listings));
    const clock = new DeterministicClock(gateway.events);
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, clock, () => 0.5);

    await runner.run(searchFilters({
      maxListings: 2,
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
      pauseAfterDetails: 1,
      cooldownSeconds: 30,
    }));

    expect(gateway.created.map(({ options }) => options)).toEqual([
      {
        url: "about:blank",
        active: true,
        windowId: WINDOW_ID,
        openerTabId: DASHBOARD_TAB_ID,
      },
      {
        url: "about:blank",
        active: true,
        windowId: WINDOW_ID,
        openerTabId: HOME_TAB_ID,
      },
      {
        url: "about:blank",
        active: true,
        windowId: WINDOW_ID,
        openerTabId: HOME_TAB_ID,
      },
    ]);
    expect(gateway.updates).toEqual(expect.arrayContaining([
      { tabId: HOME_TAB_ID + 1, options: { url: listings[0].url, active: true } },
      { tabId: HOME_TAB_ID + 2, options: { url: listings[1].url, active: true } },
    ]));
    expect(gateway.removed).toEqual([HOME_TAB_ID + 1, HOME_TAB_ID + 2]);
    expect(gateway.events.indexOf(`remove:${HOME_TAB_ID + 1}`)).toBeLessThan(
      gateway.events.indexOf(`create:${HOME_TAB_ID + 2}:about:blank`),
    );
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 40_000)).toHaveLength(2);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 30_000)).toHaveLength(1);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 3_500)).toHaveLength(5);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 1_600)).toHaveLength(4);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 1_200)).toHaveLength(10);
    expect(collector.latest().run).toMatchObject({ status: "completed", found: 2, collected: 2 });
    expect(collector.latest().records.map((storedRecord) => storedRecord.status)).toEqual([
      "detailed",
      "detailed",
    ]);
  });

  it("processes 70 detail pages sequentially in five-listing batches", async () => {
    const listings = Array.from(
      { length: 70 },
      (_, index) => listing(String(3_007_107_001 + index)),
    );
    const gateway = new FakeTabGateway(happyResponseFactory(listings));
    const clock = new DeterministicClock(gateway.events);
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, clock, () => 0.5);

    await runner.run(searchFilters({
      maxListings: 70,
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
      pauseAfterDetails: 5,
      cooldownSeconds: 30,
    }));

    expect(collector.latest().run).toMatchObject({
      status: "completed",
      target: 70,
      found: 70,
      pagesVisited: 1,
      collected: 70,
    });
    expect(collector.latest().records).toHaveLength(70);
    expect(collector.latest().records.every((record) => record.status === "detailed")).toBe(true);
    expect(gateway.created).toHaveLength(71);
    expect(gateway.removed).toHaveLength(70);
    expect(new Set(gateway.removed).size).toBe(70);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 40_000)).toHaveLength(70);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 30_000)).toHaveLength(13);
    expect(gateway.touchedTabIds).not.toEqual(expect.arrayContaining(FOREIGN_TAB_IDS));
  });

  it("uses the content-script handshake when a detail tab never reports load complete", async () => {
    const result = listing("3007106001");
    const gateway = new DetailLoadTimeoutGateway(happyResponseFactory([result]));
    const clock = new DeterministicClock(gateway.events);
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, clock);

    await runner.run(searchFilters({
      maxListings: 1,
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
    }));

    expect(gateway.detailLoadTimeouts).toBe(1);
    expect(gateway.messages.some(({ message }) => message.type === "LBC_COLLECT_DETAIL")).toBe(true);
    expect(gateway.removed).toEqual([HOME_TAB_ID + 1]);
    expect(collector.latest().run).toMatchObject({ status: "completed", found: 1, collected: 1 });
    expect(collector.latest().records.at(0)?.status).toBe("detailed");
  });

  it("preserves a failed detail tab but continues the batch and returns to the dashboard", async () => {
    const listings = [listing("3007106001"), listing("3007106002")];
    const gateway = new FakeTabGateway(happyResponseFactory(listings, {
      detailFor: (summary) => summary.id === listings[0].id
        ? detail(summary, { id: "9999999999" })
        : detail(summary),
    }));
    const clock = new DeterministicClock(gateway.events);
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, clock);

    await runner.run(searchFilters({ maxListings: 2, collectDetailPages: true }));

    const failedDetailTabId = HOME_TAB_ID + 1;
    const successfulDetailTabId = HOME_TAB_ID + 2;
    expect(gateway.removed).toEqual([successfulDetailTabId]);
    expect(gateway.tabs.has(failedDetailTabId)).toBe(true);
    expect(gateway.tabs.has(successfulDetailTabId)).toBe(false);
    expect(gateway.updates.at(-1)).toEqual({ tabId: DASHBOARD_TAB_ID, options: { active: true } });
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 2,
      collected: 1,
      filterWarnings: [expect.objectContaining({ field: `detail:${listings[0].id}` })],
    });
    expect(collector.latest().run.error).toBeUndefined();
    expect(collector.latest().records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: listings[0].id, status: "failed" }),
      expect.objectContaining({ id: listings[1].id, status: "detailed" }),
    ]));
  });

  it("cancels through the injected clock without opening or closing a detail tab", async () => {
    const result = listing("3007106001");
    const gateway = new FakeTabGateway(happyResponseFactory([result]));
    let runner: ScrapeRunner;
    const clock = new DeterministicClock(gateway.events, (milliseconds) => {
      if (milliseconds === 25_000) runner.cancel();
    });
    const collector = snapshotCollector();
    runner = createRunner(collector, gateway, clock, () => 0);

    await runner.run(searchFilters({
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 25,
    }));

    expect(gateway.created).toHaveLength(1);
    expect(gateway.removed).toEqual([]);
    expect(collector.latest().run).toMatchObject({
      status: "cancelled",
      error: undefined,
      message: { id: "run.cancelled" },
    });
    expect(gateway.touchedTabIds).not.toEqual(expect.arrayContaining(FOREIGN_TAB_IDS));
  });

  it("pauses on captcha, revalidates once on Resume, and pauses again without polling", async () => {
    const gateway = new FakeTabGateway((_tabId, message) => {
      if (message.type !== "LBC_PREPARE_HOME_SEARCH") {
        throw new Error(`Unexpected message while captcha is active: ${message.type}`);
      }
      return nativeResponse("home-prepared", {
        ok: false,
        challenge: {
          type: "captcha",
          title: "Captcha",
          message: "Manual verification required.",
          evidence: "visible test marker",
        },
      });
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha", 1);
    await flushMicrotasks();
    expect(gateway.messages).toHaveLength(1);
    expect(collector.latest().run.message).toEqual({
      id: "run.captchaPaused",
      values: {
        checkpoint: "home-prepared",
        facts: " [source=native-action-response; phase=home-prepared; actionExecuted=unknown; evidence=visible test marker]",
      },
    });

    runner.resume();
    await collector.waitFor("paused-captcha", 2);
    await flushMicrotasks();
    expect(gateway.messages.map(({ tabId, message }) => ({ tabId, type: message.type }))).toEqual([
      { tabId: HOME_TAB_ID, type: "LBC_PREPARE_HOME_SEARCH" },
      { tabId: HOME_TAB_ID, type: "LBC_PREPARE_HOME_SEARCH" },
    ]);

    runner.cancel();
    await runPromise;

    expect(collector.snapshots.filter((snapshot) => snapshot.run.status === "paused-captcha")).toHaveLength(2);
    expect(collector.latest().run.status).toBe("cancelled");
    expect(gateway.messages.some(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH")).toBe(false);
  });

  it("reports a queued unexecuted action after navigation timeout and retries it once", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let submitAttempts = 0;
    let inspections = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_SUBMIT_HOME_SEARCH") submitAttempts += 1;
      if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
        inspections += 1;
        if (inspections === 1) {
          return nativeResponse("home-submitted", {
            ok: false,
            actionExecuted: false,
            challenge: {
              type: "captcha",
              title: "Captcha",
              message: "Manual verification interrupted the queued submission.",
              evidence: " visible\nqueued; marker=1 [safe] ",
            },
          });
        }
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const waitForUrl = vi.spyOn(gateway, "waitForUrl")
      .mockRejectedValueOnce(new Error("Timed out waiting for Leboncoin search navigation."));
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(collector.latest().run.message).toEqual({
      id: "run.captchaPaused",
      values: {
        checkpoint: "search-navigation",
        facts: " [source=queued-native-action; phase=home-submitted; actionExecuted=false; evidence=visible queued marker 1 safe]",
      },
    });
    expect(submitAttempts).toBe(1);
    expect(waitForUrl).toHaveBeenCalledTimes(1);

    runner.resume();
    await runPromise;

    expect(submitAttempts).toBe(2);
    expect(waitForUrl).toHaveBeenCalledTimes(2);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("reports a queued executed action after navigation timeout without submitting twice", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let submitAttempts = 0;
    let inspections = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_SUBMIT_HOME_SEARCH") submitAttempts += 1;
      if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
        inspections += 1;
        if (inspections === 1) {
          return nativeResponse("home-submitted", {
            ok: false,
            actionExecuted: true,
            challenge: {
              type: "captcha",
              title: "Captcha",
              message: "Manual verification appeared after the queued click.",
              evidence: "queued click completed",
            },
          });
        }
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const waitForUrl = vi.spyOn(gateway, "waitForUrl")
      .mockRejectedValueOnce(new Error("Timed out waiting for Leboncoin search navigation."));
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(collector.latest().run.message).toEqual({
      id: "run.captchaPaused",
      values: {
        checkpoint: "search-navigation",
        facts: " [source=queued-native-action; phase=home-submitted; actionExecuted=true; evidence=queued click completed]",
      },
    });
    expect(submitAttempts).toBe(1);

    runner.resume();
    await runPromise;

    expect(submitAttempts).toBe(1);
    expect(waitForUrl).toHaveBeenCalledTimes(2);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("reports direct page inspection after navigation timeout without retrying submit", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let submitAttempts = 0;
    let inspections = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_SUBMIT_HOME_SEARCH") submitAttempts += 1;
      if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
        inspections += 1;
        if (inspections === 1) {
          return {
            type: "LBC_SEARCH_RESULTS",
            captcha: true,
            ready: false,
            challenge: {
              type: "captcha",
              title: "Captcha",
              message: "Manual verification found by direct inspection.",
              evidence: "visible direct inspection marker",
            },
            listings: [],
          };
        }
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const waitForUrl = vi.spyOn(gateway, "waitForUrl")
      .mockRejectedValueOnce(new Error("Timed out waiting for Leboncoin search navigation."));
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(collector.latest().run.message).toEqual({
      id: "run.captchaPaused",
      values: {
        checkpoint: "search-navigation",
        facts: " [source=direct-page-inspection; phase=search-results; actionExecuted=unknown; evidence=visible direct inspection marker]",
      },
    });
    expect(submitAttempts).toBe(1);

    runner.resume();
    await runPromise;

    expect(submitAttempts).toBe(1);
    expect(waitForUrl).toHaveBeenCalledTimes(2);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("re-sends an unexecuted home submit exactly once after explicit captcha Resume", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let submitAttempts = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_SUBMIT_HOME_SEARCH") {
        submitAttempts += 1;
        if (submitAttempts === 1) {
          return nativeResponse("home-submitted", {
            ok: false,
            actionExecuted: false,
            challenge: {
              type: "captcha",
              title: "Captcha",
              message: "Manual verification interrupted the armed home submission.",
            },
          });
        }
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(1);
    expect(collector.latest().run.status).toBe("paused-captcha");

    runner.resume();
    await runPromise;

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(2);
    expect(submitAttempts).toBe(2);
    expect(collector.snapshots.filter(({ run }) => run.status === "paused-captcha")).toHaveLength(1);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("does not re-send an executed home submit after explicit captcha Resume", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let submitAttempts = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_SUBMIT_HOME_SEARCH") {
        submitAttempts += 1;
        if (submitAttempts > 1) {
          throw new Error("An executed native home submission must not be sent twice.");
        }
        return nativeResponse("home-submitted", {
          ok: false,
          actionExecuted: true,
          challenge: {
            type: "captcha",
            title: "Captcha",
            message: "Manual verification appeared after the home submission click.",
          },
        });
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(1);

    runner.resume();
    await runPromise;

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(1);
    expect(submitAttempts).toBe(1);
    expect(collector.snapshots.filter(({ run }) => run.status === "paused-captcha")).toHaveLength(1);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("re-sends an unexecuted results apply exactly once after explicit captcha Resume", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let applyAttempts = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_APPLY_RESULTS_FILTERS") {
        applyAttempts += 1;
        if (applyAttempts === 1) {
          return nativeResponse("results-applied", {
            ok: false,
            actionExecuted: false,
            challenge: {
              type: "captcha",
              title: "Captcha",
              message: "Manual verification interrupted the armed filter application.",
            },
          });
        }
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_APPLY_RESULTS_FILTERS"))
      .toHaveLength(1);
    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(1);

    runner.resume();
    await runPromise;

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_APPLY_RESULTS_FILTERS"))
      .toHaveLength(2);
    expect(applyAttempts).toBe(2);
    expect(collector.snapshots.filter(({ run }) => run.status === "paused-captcha")).toHaveLength(1);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("does not re-send an executed results apply after explicit captcha Resume", async () => {
    const result = listing("3007106001");
    const happyResponse = happyResponseFactory([result]);
    let applyAttempts = 0;
    const gateway = new FakeTabGateway((tabId, message, currentGateway) => {
      if (message.type === "LBC_PREPARE_RESULTS_FILTERS" && applyAttempts === 1) {
        return nativeResponse("results-prepared", { step: "complete" });
      }
      if (message.type === "LBC_APPLY_RESULTS_FILTERS") {
        applyAttempts += 1;
        if (applyAttempts > 1) {
          throw new Error("An executed native results application must not be sent twice.");
        }
        return nativeResponse("results-applied", {
          ok: false,
          actionExecuted: true,
          challenge: {
            type: "captcha",
            title: "Captcha",
            message: "Manual verification appeared after the results apply click.",
          },
        });
      }
      return happyResponse(tabId, message, currentGateway);
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    const runPromise = runner.run(searchFilters());
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_APPLY_RESULTS_FILTERS"))
      .toHaveLength(1);

    runner.resume();
    await runPromise;

    expect(gateway.messages.filter(({ message }) => message.type === "LBC_APPLY_RESULTS_FILTERS"))
      .toHaveLength(1);
    expect(applyAttempts).toBe(1);
    expect(gateway.messages.filter(({ message }) => message.type === "LBC_SUBMIT_HOME_SEARCH"))
      .toHaveLength(1);
    expect(collector.snapshots.filter(({ run }) => run.status === "paused-captcha")).toHaveLength(1);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      found: 1,
      collected: 1,
    });
  });

  it("continues with a fresh staged handshake after an executed apply pauses for captcha", async () => {
    const result = listing("3007106001");
    const harness = stagedResultsHarness([result], (step, attempt) => {
      if (step !== "location" || attempt !== 1) return undefined;
      return {
        ok: false,
        actionExecuted: true,
        challenge: {
          type: "captcha",
          title: "Captcha",
          message: "Manual verification appeared after the location click.",
          evidence: "visible staged location challenge",
        },
      };
    });
    const gateway = new FakeTabGateway(harness.responseFactory, STAGED_SEARCH_URLS);
    const collector = snapshotCollector();
    const runner = createRunner(
      collector,
      gateway,
      new DeterministicClock(gateway.events),
    );

    const runPromise = runner.run(searchFilters({ collectDetailPages: false }));
    await collector.waitFor("paused-captcha");
    await flushMicrotasks();

    expect(harness.preparedSteps).toEqual(["location"]);
    expect(harness.appliedSteps).toEqual(["location"]);
    expect(harness.applyAttempts.get("location")).toBe(1);
    expect(gateway.navigations).toEqual([STAGED_SEARCH_URLS[0]]);
    expect(collector.latest().run.message).toEqual({
      id: "run.captchaPaused",
      values: {
        checkpoint: "results-applied",
        facts: " [source=native-action-response; phase=results-applied; actionExecuted=true; evidence=visible staged location challenge]",
      },
    });

    runner.resume();
    await runPromise;

    expect(harness.preparedSteps).toEqual([
      "location",
      "category",
      "property-types",
      "rooms-min",
      "rooms-max",
      "filters",
      "complete",
    ]);
    expect(harness.appliedSteps).toEqual([
      "location",
      "category",
      "property-types",
      "rooms-min",
      "rooms-max",
      "filters",
    ]);
    expect(Object.fromEntries(harness.applyAttempts)).toEqual({
      location: 1,
      category: 1,
      "property-types": 1,
      "rooms-min": 1,
      "rooms-max": 1,
      filters: 1,
    });
    expect(gateway.messages.filter(({ message }) => message.type === "LBC_APPLY_RESULTS_FILTERS"))
      .toHaveLength(6);
    expect(gateway.navigations).toEqual(STAGED_SEARCH_URLS);
    expect(collector.snapshots.filter(({ run }) => run.status === "paused-captcha"))
      .toHaveLength(1);
    expect(collector.latest().run).toMatchObject({
      status: "completed",
      searchUrl: STAGED_SEARCH_URLS.at(-1),
      found: 1,
      collected: 1,
    });
  });

  it("stops terminally on unusual activity without retrying or navigating further", async () => {
    const gateway = new FakeTabGateway((_tabId, message) => {
      if (message.type !== "LBC_PREPARE_HOME_SEARCH") {
        throw new Error(`Unexpected message after activity block: ${message.type}`);
      }
      return nativeResponse("home-prepared", {
        ok: false,
        challenge: {
          type: "unusual-activity",
          title: "Accès temporairement restreint",
          message: "Blocked activity detected.",
        },
      });
    });
    const collector = snapshotCollector();
    const runner = createRunner(collector, gateway, new DeterministicClock(gateway.events));

    await runner.run(searchFilters());

    expect(gateway.messages).toHaveLength(1);
    expect(gateway.created).toHaveLength(1);
    expect(gateway.removed).toEqual([]);
    expect(collector.latest().run).toMatchObject({
      status: "blocked-activity",
      message: {
        id: "challenge.unusualMessage",
        technicalDetail: "Blocked activity detected.",
      },
      error: { id: "error.activityBlocked" },
    });
    expect(gateway.updates.at(-1)).toEqual({
      tabId: HOME_TAB_ID,
      options: { active: true },
    });
  });
});

const recipe: IntelligenceRecipe = {
  id: "personal-fit",
  version: 3,
  name: "Personal fit",
  threshold: 70,
  enabled: true,
  criteria: [
    {
      id: "garden",
      name: "Garden",
      description: "The listing explicitly describes a private garden.",
      weight: 30,
      required: true,
    },
  ],
};

function run(): ScrapeRun {
  return {
    id: "run-1",
    status: "collecting-details",
    target: 2,
    found: 2,
    pagesVisited: 1,
    collected: 1,
    evaluated: 0,
    relevant: 0,
    notRelevant: 0,
    review: 0,
    filterWarnings: [],
    intelligenceStatus: "idle",
  };
}

function record(id: string, status: ScrapedPropertyRecord["status"]): ScrapedPropertyRecord {
  return {
    id,
    source: "leboncoin",
    listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`,
    title: `Listing ${id}`,
    description: "Maison avec jardin privatif.",
    features: ["Jardin"],
    scrapedAt: "2026-07-12T10:00:00.000Z",
    searchRunId: "run-1",
    status,
    rawTextSample: "Maison avec jardin",
  };
}

function evaluation(listingId: string): ListingEvaluation {
  return {
    listingId,
    decision: "relevant",
    score: 100,
    summary: "The required garden is present.",
    criteria: [
      {
        criterionId: "garden",
        verdict: "pass",
        reason: "The description explicitly mentions the garden.",
        evidence: ["jardin privatif"],
      },
    ],
    missingData: [],
    evaluatedAt: "2026-07-12T10:01:00.000Z",
    evaluator: { provider: "openai", model: "gpt-5-mini-2025-08-07", version: "1.0.0" },
    recipeId: recipe.id,
    recipeVersion: recipe.version,
  };
}

describe("scrape runner intelligence phase", () => {
  it("evaluates only detailed run records and persists the merged result", async () => {
    const activeRun = run();
    const detailed = record("listing-1", "detailed");
    const failed = record("listing-2", "failed");
    const evaluator = vi.fn(async () => ({
      evaluations: [evaluation(detailed.id)],
      failures: [],
    }));
    const snapshots: Array<{ status: ScrapeRun["status"]; intelligenceStatus: ScrapeRun["intelligenceStatus"] }> = [];

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [detailed, failed],
      recipe,
      evaluator,
      signal: new AbortController().signal,
      persist: async (nextRun) => {
        snapshots.push({ status: nextRun.status, intelligenceStatus: nextRun.intelligenceStatus });
      },
    });

    expect(evaluator).toHaveBeenCalledWith(
      "run-1",
      recipe,
      [detailed],
      "fr",
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(snapshots).toEqual([
      { status: "evaluating", intelligenceStatus: "evaluating" },
      { status: "completed", intelligenceStatus: "completed" },
    ]);
    expect(records[0].evaluation?.decision).toBe("relevant");
    expect(records[1]).toBe(failed);
    expect(activeRun).toMatchObject({ evaluated: 1, relevant: 1, status: "completed" });
  });

  it("preserves detailed records and completes the crawl when evaluation fails", async () => {
    const activeRun = run();
    const detailed = record("listing-1", "detailed");
    const persist = vi.fn(async () => undefined);

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [detailed],
      recipe,
      evaluator: vi.fn(async () => {
        throw new Error("API unavailable");
      }),
      signal: new AbortController().signal,
      persist,
    });

    expect(records[0]).toMatchObject({
      ...detailed,
      evaluationFailure: {
        listingId: detailed.id,
        code: "INTERNAL_ERROR",
        stage: "internal",
        retryable: false,
      },
    });
    expect(activeRun).toMatchObject({
      status: "completed",
      intelligenceStatus: "failed",
      intelligenceError: { id: "error.intelligenceFailed", technicalDetail: "API unavailable" },
      collected: 1,
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("persists successes and technical failures independently for a partial evaluation", async () => {
    const activeRun = run();
    const first = record("listing-1", "detailed");
    const second = record("listing-2", "detailed");

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [first, second],
      recipe,
      evaluator: vi.fn(async () => ({
        evaluations: [evaluation(first.id)],
        failures: [{
          listingId: second.id,
          code: "UNKNOWN_EVIDENCE_ID",
          stage: "semantic",
          retryable: true,
          requestId: "request-partial",
        }],
      })),
      signal: new AbortController().signal,
      persist: vi.fn(async () => undefined),
    });

    expect(records[0].evaluation?.listingId).toBe(first.id);
    expect(records[1].evaluation).toBeUndefined();
    expect(records[1].evaluationFailure).toMatchObject({
      code: "UNKNOWN_EVIDENCE_ID",
      requestId: "request-partial",
    });
    expect(activeRun).toMatchObject({
      status: "completed",
      intelligenceStatus: "partial",
      evaluated: 1,
      relevant: 1,
      review: 0,
      intelligenceError: { id: "error.apiInvalidOutput" },
    });
  });

  it("keeps completed evaluation batches when a later batch fails", async () => {
    const activeRun = run();
    const first = record("listing-1", "detailed");
    const second = record("listing-2", "detailed");
    const firstEvaluation = evaluation(first.id);
    const persist = vi.fn(async () => undefined);

    const records = await runIntelligencePhase({
      run: activeRun,
      records: [first, second],
      recipe,
      evaluator: vi.fn(async (_runId, _recipe, _records, _locale, _signal, onBatchComplete) => {
        await onBatchComplete?.(
          { evaluations: [firstEvaluation], failures: [] },
          { evaluations: [firstEvaluation], failures: [] },
        );
        throw new Error("second batch failed");
      }),
      signal: new AbortController().signal,
      persist,
    });

    expect(records[0].evaluation).toEqual(firstEvaluation);
    expect(records[1].evaluation).toBeUndefined();
    expect(records[1].evaluationFailure).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: false,
    });
    expect(activeRun).toMatchObject({
      status: "completed",
      intelligenceStatus: "partial",
      evaluated: 1,
      relevant: 1,
    });
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it("propagates cancellation instead of persisting a fabricated evaluation result", async () => {
    const activeRun = run();
    const abortController = new AbortController();

    await expect(runIntelligencePhase({
      run: activeRun,
      records: [record("listing-1", "detailed")],
      recipe,
      evaluator: vi.fn(async () => {
        abortController.abort();
        throw new DOMException("cancelled", "AbortError");
      }),
      signal: abortController.signal,
      persist: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
