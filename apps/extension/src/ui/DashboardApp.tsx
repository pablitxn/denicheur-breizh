import {
  AlertTriangle,
  Brain,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, EmptyState, SectionLabel, Select } from "@denicheur-breizh/design-system";
import { ScrapeRunner } from "../automation/scrapeRunner";
import {
  LocaleSelector,
  extensionMessage,
  filterWarningFieldLabel,
  localeDisplayName,
  missingFieldLabel,
  translateFilterValidationIssue,
  useExtensionI18n,
  type ExtensionMessageId,
} from "../i18n";
import {
  evaluationFailureDescriptor,
} from "../intelligence/filterApi";
import {
  CATEGORY_OPTIONS,
  createDefaultSearchFilters,
  MAX_LISTINGS_LIMIT,
  normalizeSearchFilters,
  OWNER_TYPE_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  SORT_OPTIONS,
  validateSearchFilters,
} from "../lib/leboncoinSearch";
import type {
  IntelligenceRecipe,
  EvaluationPlan,
  ListingEvaluation,
  ListingEvaluationFailure,
  PlanEvaluation,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
} from "../lib/types";
import {
  clearRecords,
  CRAWLER_STORAGE_KEYS,
  IDLE_RUN,
  loadCrawlerState,
  loadEvaluationPlan,
  reconcileInterruptedRun,
  saveFilters,
  saveRun,
} from "../storage/chromeStorage";
import {
  requestDefaultPlanRefresh,
  requestImmediateSync,
  requestPlanEvaluation,
} from "../sync/runtime";
import {
  EMPTY_SYNC_STATE,
  loadExtensionSyncState,
  SYNC_STORAGE_KEY,
} from "../sync/storage";
import type { ExtensionSyncState } from "../sync/types";
import {
  useThemePreference,
  type ThemePreference,
} from "./theme";
import { RuntimeApiSettings } from "./RuntimeApiSettings";

type NumericFilterKey =
  | "priceMin"
  | "priceMax"
  | "roomsMin"
  | "roomsMax"
  | "bedroomsMin"
  | "bedroomsMax"
  | "squareMin"
  | "squareMax"
  | "maxListings"
  | "minDelaySeconds"
  | "maxDelaySeconds"
  | "pauseAfterDetails"
  | "cooldownSeconds";

const RUNNING_STATUSES = new Set<ScrapeRun["status"]>([
  "opening-search",
  "configuring-search",
  "collecting-search",
  "collecting-details",
  "evaluating",
]);
const RECORDS_PAGE_SIZES = [12, 24, 48] as const;
const DEFAULT_RECORDS_PAGE_SIZE = 24;
const DASHBOARD_RUNNER_LOCK_NAME = "denicheur:crawler:dashboard-runner";

type RecordsPageSize = (typeof RECORDS_PAGE_SIZES)[number];

interface DashboardRunnerLockManager {
  query(): Promise<LockManagerSnapshot>;
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T>;
}

interface DashboardAppProps {
  initialThemePreference?: ThemePreference;
}

export class DashboardRunnerBusyError extends Error {
  readonly code = "DASHBOARD_RUNNER_BUSY";

  constructor() {
    super("Another dashboard already owns the crawler run.");
    this.name = "DashboardRunnerBusyError";
  }
}

export function DashboardApp({ initialThemePreference = "system" }: DashboardAppProps) {
  const {
    formatNumber,
    locale,
    resolveText,
    t,
  } = useExtensionI18n();
  const [filters, setFilters] = useState<SearchFilters>(createDefaultSearchFilters);
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [records, setRecords] = useState<ScrapedPropertyRecord[]>([]);
  const [plan, setPlan] = useState<EvaluationPlan>();
  const [syncState, setSyncState] = useState<ExtensionSyncState>(EMPTY_SYNC_STATE);
  const [filtersDirty, setFiltersDirty] = useState(false);
  const [hydrationState, setHydrationState] = useState<"loading" | "ready" | "error">("loading");
  const [hydrationRetry, setHydrationRetry] = useState(0);
  const [loadError, setLoadError] = useState<unknown>();
  const initialResultsState = useMemo(readResultsViewState, []);
  const [decisionFilter, setDecisionFilter] = useState<"all" | ListingEvaluation["decision"]>(initialResultsState.decision);
  const [recordQuery, setRecordQuery] = useState(initialResultsState.query);
  const [resultsPage, setResultsPage] = useState(initialResultsState.page);
  const [recordsPageSize, setRecordsPageSize] = useState(initialResultsState.pageSize);
  const [intelligenceExpanded, setIntelligenceExpanded] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [refreshingRecipe, setRefreshingRecipe] = useState(false);
  const [reevaluationPending, setReevaluationPending] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string>();
  const [error, setError] = useState<unknown>();
  const { preference: themePreference, setPreference: setThemePreference } =
    useThemePreference(initialThemePreference);
  const runnerRef = useRef<ScrapeRunner | undefined>(undefined);
  const startPendingRef = useRef(false);
  const reevaluationPendingRef = useRef(false);
  const filtersDirtyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const isRunning = RUNNING_STATUSES.has(run.status);
  const isRunActive = isRunning || run.status === "paused-captcha";
  const canControlActiveRun = Boolean(runnerRef.current);
  const requiresReset = run.status === "blocked-captcha" || run.status === "blocked-activity";
  const formPending = savingFilters || refreshingRecipe || reevaluationPending || startPending;
  const durableEvaluationPending = syncState.evaluationQueue.some((entry) =>
    entry.status === "queued" || entry.status === "creating" || entry.status === "polling");
  const evaluationFailures = records.flatMap((record) => (
    record.evaluationFailure ? [record.evaluationFailure] : []
  ));
  const successfulEvaluationCount = records.filter((record) => (
    record.status === "detailed" && (record.planEvaluation || (record.evaluation && !record.evaluationFailure))
  )).length;
  const filterIssues = useMemo(() => validateSearchFilters(filters), [filters]);
  const filterIssueMessages = useMemo(
    () => new Map(filterIssues.map((issue) => [
      issue.field,
      translateFilterValidationIssue(issue, filters, t),
    ])),
    [filterIssues, filters, t],
  );
  const filteredRecords = useMemo(
    () => records.filter((record) => {
      const decision = record.planEvaluation?.decision ?? record.evaluation?.decision;
      if (decisionFilter !== "all" && decision !== decisionFilter) return false;
      return recordMatchesQuery(record, recordQuery, locale);
    }),
    [decisionFilter, locale, recordQuery, records],
  );
  const resultsPageCount = Math.max(1, Math.ceil(filteredRecords.length / recordsPageSize));
  const currentResultsPage = resolveResultsPage(
    resultsPage,
    resultsPageCount,
    hydrationState === "ready",
  );
  const visibleRecords = useMemo(() => {
    const offset = (currentResultsPage - 1) * recordsPageSize;
    return filteredRecords.slice(offset, offset + recordsPageSize);
  }, [currentResultsPage, filteredRecords, recordsPageSize]);
  useEffect(() => {
    let mounted = true;
    setHydrationState("loading");
    setLoadError(undefined);

    void Promise.all([loadCrawlerState(), loadExtensionSyncState(), loadEvaluationPlan()])
      .then(async ([snapshot, restoredSyncState, restoredPlan]) => {
        const hasLiveRunner = await hasLiveDashboardRunner(
          Boolean(runnerRef.current),
        );
        const recoveredRun = reconcileDashboardRun(snapshot.run, hasLiveRunner);
        if (recoveredRun !== snapshot.run) await saveRun(recoveredRun);
        if (!mounted) return;

        setFilters(snapshot.filters);
        setRun(recoveredRun);
        setRecords(snapshot.records);
        const activePlan = restoredSyncState.activePlan.status === "cached" &&
          restoredPlan !== undefined &&
          restoredPlan.id === restoredSyncState.activePlan.planId &&
          restoredPlan.version === restoredSyncState.activePlan.planVersion
          ? restoredPlan
          : undefined;
        setSyncState(restoredSyncState);
        setPlan(activePlan);
        setFiltersDirtyState(false);
        setDraftConflict(false);
        setIntelligenceExpanded(Boolean(activePlan));
        setHydrationState("ready");
      })
      .catch((caught) => {
        if (mounted) {
          setLoadError(caught instanceof Error ? caught.message : String(caught));
          setHydrationState("error");
        }
      });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (
        areaName !== "local" ||
        !Object.keys(changes).some((key) =>
          key === SYNC_STORAGE_KEY || Object.values(CRAWLER_STORAGE_KEYS).includes(
            key as (typeof CRAWLER_STORAGE_KEYS)[keyof typeof CRAWLER_STORAGE_KEYS],
          ))
      ) {
        return;
      }

      void Promise.all([loadCrawlerState(), loadExtensionSyncState(), loadEvaluationPlan()])
        .then(([snapshot, restoredSyncState, restoredPlan]) => {
          if (!mounted) return;
          if (CRAWLER_STORAGE_KEYS.filters in changes) {
            if (filtersDirtyRef.current) {
              setDraftConflict(true);
            } else {
              setFilters(snapshot.filters);
            }
          }
          if (CRAWLER_STORAGE_KEYS.recipe in changes || CRAWLER_STORAGE_KEYS.plan in changes || SYNC_STORAGE_KEY in changes) {
            const activePlan = restoredSyncState.activePlan.status === "cached" &&
              restoredPlan !== undefined &&
              restoredPlan.id === restoredSyncState.activePlan.planId &&
              restoredPlan.version === restoredSyncState.activePlan.planVersion
              ? restoredPlan
              : undefined;
            setSyncState(restoredSyncState);
            setPlan(activePlan);
          }
          if (CRAWLER_STORAGE_KEYS.run in changes) setRun(snapshot.run);
          if (CRAWLER_STORAGE_KEYS.records in changes) setRecords(snapshot.records);
        })
        .catch((caught) => {
          if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
        });
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
      runnerRef.current?.cancel();
    };
  }, [hydrationRetry]);

  useEffect(() => {
    if (run.status !== "paused-captcha" || runnerRef.current) return;

    const abortController = new AbortController();
    let mounted = true;

    void waitForDashboardRunnerRelease(abortController.signal)
      .then(async () => {
        if (!mounted || runnerRef.current) return;

        const snapshot = await loadCrawlerState();
        const recoveredRun = reconcileDashboardRun(snapshot.run, false);
        if (recoveredRun === snapshot.run) return;

        await saveRun(recoveredRun);
        if (mounted) setRun(recoveredRun);
      })
      .catch((caught) => {
        if (mounted && !isAbortError(caught)) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });

    return () => {
      mounted = false;
      abortController.abort();
    };
  }, [run.status]);

  useEffect(() => {
    if (hydrationState !== "ready" || !durableEvaluationPending) return;
    let active = true;
    let requestPending = false;
    const poll = () => {
      if (!active || requestPending) return;
      requestPending = true;
      void requestImmediateSync()
        .catch((caught) => {
          if (active) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          requestPending = false;
        });
    };
    poll();
    const intervalId = window.setInterval(poll, 2_000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [durableEvaluationPending, hydrationState]);

  useEffect(() => {
    if (hydrationState !== "ready") return;
    if (resultsPage > resultsPageCount) setResultsPage(resultsPageCount);
  }, [hydrationState, resultsPage, resultsPageCount]);

  useEffect(() => {
    if (hydrationState !== "ready") return;
    const url = new URL(window.location.href);
    setOptionalSearchParam(url, "decision", decisionFilter === "all" ? "" : decisionFilter);
    setOptionalSearchParam(url, "q", recordQuery.trim());
    setOptionalSearchParam(url, "page", currentResultsPage === 1 ? "" : String(currentResultsPage));
    setOptionalSearchParam(
      url,
      "pageSize",
      recordsPageSize === DEFAULT_RECORDS_PAGE_SIZE ? "" : String(recordsPageSize),
    );
    window.history.replaceState(null, "", url);
  }, [currentResultsPage, decisionFilter, hydrationState, recordQuery, recordsPageSize]);

  useEffect(() => {
    if (!filtersDirty) return;
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedChanges);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedChanges);
  }, [filtersDirty]);

  function setFiltersDirtyState(nextDirty: boolean) {
    filtersDirtyRef.current = nextDirty;
    setFiltersDirty(nextDirty);
  }

  function markFiltersDirty() {
    setFiltersDirtyState(true);
    setActionFeedback(undefined);
  }

  function patchFilters(patch: Partial<SearchFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    markFiltersDirty();
  }

  function patchNumericFilter(key: NumericFilterKey, value: string) {
    const parsed = value === "" ? undefined : Number(value);
    patchFilters({ [key]: Number.isFinite(parsed) ? parsed : undefined } as Partial<SearchFilters>);
  }

  function togglePropertyType(value: string) {
    setFilters((current) => {
      const exists = current.propertyTypes.includes(value);
      return {
        ...current,
        propertyTypes: exists
          ? current.propertyTypes.filter((selected) => selected !== value)
          : [...current.propertyTypes, value],
      };
    });
    markFiltersDirty();
  }

  async function persistFiltersForUse(): Promise<SearchFilters> {
    if (filterIssues.length > 0) {
      focusFirstFilterIssue();
      throw extensionMessage("validation.fixFilters");
    }
    const normalizedFilters = normalizeSearchFilters(filters);
    setFiltersDirtyState(false);
    try {
      await saveFilters(normalizedFilters);
      setFilters(normalizedFilters);
      setDraftConflict(false);
      return normalizedFilters;
    } catch (caught) {
      setFiltersDirtyState(true);
      throw caught;
    }
  }

  async function handleRefreshRecipe() {
    setError(undefined);
    setRefreshingRecipe(true);
    setActionFeedback(t("intelligence.refreshingRecipe"));
    try {
      const response = await requestDefaultPlanRefresh();
      if (!response.ok || !response.plan) {
        throw new Error(response.error ?? "No default evaluation plan is available.");
      }
      setPlan(response.plan);
      setSyncState(response.state);
      setIntelligenceExpanded(true);
      setActionFeedback(t("feedback.recipeRefreshed"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setActionFeedback(undefined);
    } finally {
      setRefreshingRecipe(false);
    }
  }

  async function handleSaveFilters() {
    setError(undefined);
    setSavingFilters(true);
    setActionFeedback(t("action.saving"));
    try {
      await persistFiltersForUse();
      setActionFeedback(t("feedback.filtersSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : caught);
      setActionFeedback(undefined);
    } finally {
      setSavingFilters(false);
    }
  }

  async function handleThemeChange(nextPreference: ThemePreference) {
    setActionFeedback(undefined);
    try {
      await setThemePreference(nextPreference);
    } catch {
      setActionFeedback(t("feedback.themeFailed"));
    }
  }

  async function handleCopyRequestId(requestId: string) {
    try {
      await navigator.clipboard.writeText(requestId);
      setActionFeedback(t("feedback.requestIdCopied"));
    } catch {
      // The selectable request id remains visible when clipboard access is unavailable.
    }
  }

  function focusFirstFilterIssue() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hydrationState !== "ready" || startPendingRef.current || isRunActive) return;
    if (requiresReset) {
      setError(extensionMessage("validation.manualReset"));
      return;
    }
    if (filterIssues.length > 0) {
      setError(extensionMessage("validation.fixFilters"));
      focusFirstFilterIssue();
      return;
    }
    startPendingRef.current = true;
    setStartPending(true);
    runnerRef.current?.cancel();
    setError(undefined);
    setActionFeedback(t("action.starting"));

    try {
      await withDashboardRunnerLease(async () => {
        const planForRun = plan;
        const normalizedFilters = await persistFiltersForUse();
        const runnableFilters = normalizeSearchFilters({
          ...normalizedFilters,
          collectDetailPages: planForRun ? true : normalizedFilters.collectDetailPages,
        });
        if (runnableFilters.collectDetailPages !== normalizedFilters.collectDetailPages) {
          await saveFilters(runnableFilters);
          setFilters(runnableFilters);
        }
        const runner = new ScrapeRunner((snapshot) => {
          setRun(snapshot.run);
          setRecords(snapshot.records);
        });
        runnerRef.current = runner;
        await runner.run(runnableFilters, undefined, locale);
        const completed = await loadCrawlerState();
        if (planForRun && completed.run.status === "completed" &&
          completed.records.some((record) => record.searchRunId === completed.run.id && record.status === "detailed")) {
          const response = await requestPlanEvaluation({
            runId: completed.run.id,
            locale,
          });
          if (!response.ok) throw new Error(response.error ?? "Evaluation execution could not be queued.");
          setSyncState(response.state);
        }
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      runnerRef.current = undefined;
      startPendingRef.current = false;
      setStartPending(false);
      setActionFeedback(undefined);
    }
  }

  function handleCancel() {
    runnerRef.current?.cancel();
  }

  function handleResume() {
    runnerRef.current?.resume();
  }

  async function handleReevaluate(_pendingOnly = false) {
    if (reevaluationPendingRef.current) return;
    reevaluationPendingRef.current = true;
    setReevaluationPending(true);
    setError(undefined);
    setActionFeedback(t("intelligence.reevaluating"));
    try {
      if (!plan) throw extensionMessage("error.enableRecipe");
      const detailedRecords = records.filter(
        (record) => record.searchRunId === run.id && record.status === "detailed",
      );
      if (detailedRecords.length === 0) throw extensionMessage("error.noDetailedRecords");
      const response = await requestPlanEvaluation({
        runId: run.id,
        locale,
        force: true,
      });
      setSyncState(response.state);
      if (!response.ok) throw new Error(response.error ?? "Evaluation execution could not be queued.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : caught);
    } finally {
      reevaluationPendingRef.current = false;
      setReevaluationPending(false);
      setActionFeedback(undefined);
    }
  }

  async function handleClear() {
    const prompt = requiresReset
      ? t("confirm.clearTerminal")
      : t("confirm.clear");
    if (!window.confirm(prompt)) return;
    runnerRef.current?.cancel();
    try {
      await clearRecords();
      setRecords([]);
      setRun(IDLE_RUN);
      setRecordQuery("");
      setDecisionFilter("all");
      setResultsPage(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function retryHydration() {
    setHydrationRetry((current) => current + 1);
  }

  function resetResultFilters() {
    setDecisionFilter("all");
    setRecordQuery("");
    setResultsPage(1);
  }

  function focusSearchConfiguration() {
    const control = document.getElementById("search-category");
    control?.focus();
    control?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  return (
    <div className="extension-page">
      <a className="skip-link" href="#main-content">{t("a11y.skipToContent")}</a>
      <header className="extension-topbar">
        <div className="extension-brand">
          <span className="extension-mark">DB</span>
          <div>
            <h1>{t("app.dashboardTitle")}</h1>
            <p>{t("app.dashboardSubtitle")}</p>
          </div>
        </div>
        <div className="extension-toolbar-actions">
          <label className="theme-selector">
            <span className="sr-only">{t("appearance.themeLabel")}</span>
            <Select
              aria-label={t("appearance.themeLabel")}
              value={themePreference}
              onChange={(event) => void handleThemeChange(event.target.value as ThemePreference)}
            >
              <option value="system">{t("appearance.themeSystem")}</option>
              <option value="light">{t("appearance.themeLight")}</option>
              <option value="dark">{t("appearance.themeDark")}</option>
            </Select>
          </label>
          <LocaleSelector />
          <div aria-live={hydrationState === "ready" ? "polite" : undefined}>
            {hydrationState === "loading" ? (
              <Chip tone="sea">
                <LoaderCircle className="spin" size={13} />
                {t("popup.loading")}
              </Chip>
            ) : hydrationState === "error" ? (
              <Chip tone="danger">{t("popup.loadFailed")}</Chip>
            ) : (
              <StatusPill run={run} />
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="dashboard-layout" tabIndex={-1}>
        <RuntimeApiSettings />
        {hydrationState === "loading" && (
          <div className="dashboard-state loading-state" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{t("popup.loading")}</span>
          </div>
        )}
        {hydrationState === "error" && (
          <div className="dashboard-state inline-alert danger" role="alert">
            <AlertTriangle size={16} />
            <div>
              <p>{t("popup.loadFailed")}</p>
              {loadError !== undefined && <LocalizedMessageView value={loadError} />}
              <Button type="button" size="sm" onClick={retryHydration}>
                <RefreshCw size={14} />
                {t("action.retry")}
              </Button>
            </div>
          </div>
        )}
        <form
          ref={formRef}
          className="control-surface"
          aria-busy={hydrationState === "loading" || formPending}
          onSubmit={handleStart}
        >
          <div className="surface-head">
            <div>
              <h2>{t("search.title")}</h2>
              <p>{t("search.description")}</p>
            </div>
            {filtersDirty && (
              <Chip tone="sunset">{t("feedback.unsavedChanges")}</Chip>
            )}
          </div>

          <fieldset
            className="form-section"
            disabled={hydrationState !== "ready" || isRunActive || formPending}
          >
            <legend className="sr-only">{t("search.basicLegend")}</legend>
            <div className="form-grid">
            <label className="field">
              <SectionLabel>{t("search.mode")}</SectionLabel>
              <Select
                id="search-category"
                name="category"
                value={filters.category}
                onChange={(event) => patchFilters({ category: event.target.value as SearchFilters["category"] })}
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(`category.${option.value}`)}
                  </option>
                ))}
              </Select>
            </label>

            <label className="field">
              <SectionLabel>{t("search.keywords")}</SectionLabel>
              <input
                className="input"
                name="keywords"
                autoComplete="off"
                value={filters.text}
                onChange={(event) => patchFilters({ text: event.target.value })}
                placeholder={t("search.keywordsPlaceholder")}
              />
            </label>

            <label className="field wide">
              <SectionLabel>{t("search.location")}</SectionLabel>
              <input
                className="input"
                name="location-query"
                autoComplete="off"
                value={filters.locationQuery}
                onChange={(event) => patchFilters({ locationQuery: event.target.value })}
                placeholder={t("search.locationPlaceholder")}
              />
            </label>

            <div className="field wide">
              <SectionLabel id="property-types-label">{t("search.types")}</SectionLabel>
              <div className="chip-row" role="group" aria-labelledby="property-types-label">
                {PROPERTY_TYPE_OPTIONS.map((option) => (
                  <Chip
                    key={option.value}
                    active={filters.propertyTypes.includes(option.value)}
                    onClick={() => togglePropertyType(option.value)}
                  >
                    {t(`propertyType.${option.value}` as ExtensionMessageId)}
                  </Chip>
                ))}
              </div>
            </div>

            <NumberField label={t("search.priceMin")} name="price-min" value={filters.priceMin} error={filterIssueMessages.get("priceMin")} onChange={(value) => patchNumericFilter("priceMin", value)} />
            <NumberField label={t("search.priceMax")} name="price-max" value={filters.priceMax} error={filterIssueMessages.get("priceMax")} onChange={(value) => patchNumericFilter("priceMax", value)} />
            <NumberField label={t("search.roomsMin")} name="rooms-min" value={filters.roomsMin} min={1} max={8} error={filterIssueMessages.get("roomsMin")} onChange={(value) => patchNumericFilter("roomsMin", value)} />
            <NumberField label={t("search.roomsMax")} name="rooms-max" value={filters.roomsMax} min={1} max={8} error={filterIssueMessages.get("roomsMax")} onChange={(value) => patchNumericFilter("roomsMax", value)} />
            <NumberField label={t("search.bedsMin")} name="beds-min" value={filters.bedroomsMin} min={1} max={8} error={filterIssueMessages.get("bedroomsMin")} onChange={(value) => patchNumericFilter("bedroomsMin", value)} />
            <NumberField label={t("search.bedsMax")} name="beds-max" value={filters.bedroomsMax} min={1} max={8} error={filterIssueMessages.get("bedroomsMax")} onChange={(value) => patchNumericFilter("bedroomsMax", value)} />
            <NumberField label={t("search.surfaceMin")} name="surface-min" value={filters.squareMin} error={filterIssueMessages.get("squareMin")} onChange={(value) => patchNumericFilter("squareMin", value)} />
            <NumberField label={t("search.surfaceMax")} name="surface-max" value={filters.squareMax} error={filterIssueMessages.get("squareMax")} onChange={(value) => patchNumericFilter("squareMax", value)} />

            <label className="field">
              <SectionLabel>{t("search.seller")}</SectionLabel>
              <Select
                name="owner-type"
                value={filters.ownerType}
                onChange={(event) => patchFilters({ ownerType: event.target.value as SearchFilters["ownerType"] })}
              >
                {OWNER_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(`owner.${option.value}`)}
                  </option>
                ))}
              </Select>
            </label>

            <label className="field">
              <SectionLabel>{t("search.sort")}</SectionLabel>
              <Select
                name="sort"
                value={filters.sort}
                onChange={(event) => patchFilters({ sort: event.target.value as SearchFilters["sort"] })}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(`sort.${option.value}`)}
                  </option>
                ))}
              </Select>
            </label>

            </div>
          </fieldset>

          <details className="advanced-panel">
            <summary>{t("search.advancedSummary")}</summary>
            <p>{t("search.advancedDescription")}</p>
            <fieldset
              className="form-section"
              disabled={hydrationState !== "ready" || isRunActive || formPending}
            >
              <legend className="sr-only">{t("search.advancedSummary")}</legend>
              <div className="form-grid">

            <NumberField
              label={t("search.maxListings")}
              name="max-listings"
              value={filters.maxListings}
              min={1}
              max={MAX_LISTINGS_LIMIT}
              error={filterIssueMessages.get("maxListings")}
              onChange={(value) => patchNumericFilter("maxListings", value)}
            />

            <label className="toggle close-toggle">
              <input
                type="checkbox"
                name="collect-detail-pages"
                checked={filters.collectDetailPages}
                onChange={(event) => patchFilters({ collectDetailPages: event.target.checked })}
              />
              <span className="track" />
              <span>{t("search.collectDetails")}</span>
            </label>
            <small className="field wide intelligence-note">
              {t("search.detailBehaviour")}
            </small>

            <NumberField label={t("search.delayMin")} name="delay-min-seconds" value={filters.minDelaySeconds} error={filterIssueMessages.get("minDelaySeconds")} onChange={(value) => patchNumericFilter("minDelaySeconds", value)} />
            <NumberField label={t("search.delayMax")} name="delay-max-seconds" value={filters.maxDelaySeconds} error={filterIssueMessages.get("maxDelaySeconds")} onChange={(value) => patchNumericFilter("maxDelaySeconds", value)} />
            <NumberField label={t("search.pauseEvery")} name="pause-every" value={filters.pauseAfterDetails} error={filterIssueMessages.get("pauseAfterDetails")} onChange={(value) => patchNumericFilter("pauseAfterDetails", value)} />
            <NumberField label={t("search.cooldown")} name="cooldown-seconds" value={filters.cooldownSeconds} error={filterIssueMessages.get("cooldownSeconds")} onChange={(value) => patchNumericFilter("cooldownSeconds", value)} />

              </div>
            </fieldset>
          </details>

          <details
            className="intelligence-panel"
            open={intelligenceExpanded}
            onToggle={(event) => setIntelligenceExpanded(event.currentTarget.open)}
          >
            <summary className="intelligence-summary">
              <span className="intelligence-title-row">
                <Brain size={17} />
                <span id="intelligence-title">{t("intelligence.summary")}</span>
                <Chip tone={plan ? "good" : "sea"}>
                  {plan ? t("intelligence.enabled") : t("intelligence.disabled")}
                </Chip>
              </span>
            </summary>
            <div className="intelligence-content" aria-labelledby="intelligence-title">
              <div className="intelligence-head">
                <p>{plan ? t("intelligence.activePlanDescription") : t("intelligence.noDefaultPlan")}</p>
              </div>

              <div className="recipe-grid">
                <div className="field wide">
                  <SectionLabel>{t("intelligence.planName")}</SectionLabel>
                  <strong>{plan?.name ?? "—"}</strong>
                </div>
                <div className="field">
                  <SectionLabel>{t("intelligence.planOperator")}</SectionLabel>
                  <strong>{plan ? t(plan.operator === "all" ? "intelligence.operatorAll" : "intelligence.operatorAny") : "—"}</strong>
                </div>
                <div className="recipe-version">
                  <SectionLabel>{t("intelligence.version")}</SectionLabel>
                  <strong>{plan ? `v${formatNumber(plan.version)}` : "—"}</strong>
                </div>
              </div>

              <div className="criteria-list">
                {!plan && (
                  <p className="criteria-empty">{t("intelligence.noActiveCriteria")}</p>
                )}
                {plan?.recipes.flatMap((step) => step.recipe.criteria.map((criterion) => ({ step, criterion }))).map(({ step, criterion }, index) => (
                  <article className="criterion-row" key={`${step.recipeId}:${step.recipeVersion}:${criterion.id}`}>
                    <div className="criterion-index">{index + 1}</div>
                    <div className="criterion-fields">
                      <strong>{step.recipe.name} v{formatNumber(step.recipeVersion)} · {criterion.name}</strong>
                      <p>{criterion.description}</p>
                      <div className="criterion-options">
                        <span>{t("intelligence.weight")}: {formatNumber(criterion.weight)}</span>
                        {criterion.required && <Chip tone="sunset">{t("intelligence.required")}</Chip>}
                      </div>
                    </div>
                  </article>
                ))}
              </div>

              <div className="intelligence-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleRefreshRecipe}
                  disabled={refreshingRecipe || isRunActive}
                >
                  {refreshingRecipe ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                  {refreshingRecipe ? t("intelligence.refreshingPlan") : t("intelligence.refreshPlan")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleReevaluate(false)}
                  disabled={reevaluationPending || durableEvaluationPending || isRunActive || !plan || records.every((record) => record.status !== "detailed")}
                >
                  {reevaluationPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                  {reevaluationPending ? t("intelligence.reevaluating") : t("intelligence.reevaluate")}
                </Button>
              </div>
              {plan && <p className="intelligence-note">{t("intelligence.autoDetails")}</p>}
            </div>
          </details>

          <div className="guardrail-panel">
            <AlertTriangle size={16} />
            <span>
              {t("guardrail.notice")}
            </span>
          </div>

          {filterIssues.length > 0 && (
            <div className="inline-alert danger" role="alert">
              <AlertTriangle size={16} />
              <span>{t("validation.summary", { count: filterIssues.length })}</span>
            </div>
          )}

          {run.filterWarnings.length > 0 && (
            <div className="inline-alert warning" role="status">
              <AlertTriangle size={16} />
              <span>
                {run.filterWarnings.map((warning) => {
                  const resolved = resolveText(warning.message);
                  const detail = resolved.technicalDetail
                    ? ` ${t("error.technicalDetail", { detail: resolved.technicalDetail })}`
                    : "";
                  return `${t("warning.field", {
                    field: filterWarningFieldLabel(warning.field, t),
                    message: resolved.text,
                  })}${detail}`;
                }).join(" ")}
              </span>
            </div>
          )}

          {error !== undefined && error !== null && (
            <div className="inline-alert danger" role="alert">
              <AlertTriangle size={16} />
              <LocalizedMessageView value={error} />
            </div>
          )}

          {draftConflict && (
            <div className="inline-alert warning" role="status">
              <AlertTriangle size={16} />
              <span>{t("feedback.externalChanges")}</span>
            </div>
          )}

          <div className="action-row">
            <Button
              type="button"
              variant="ghost"
              onClick={handleSaveFilters}
              disabled={!filtersDirty || formPending || hydrationState !== "ready" || isRunActive}
            >
              {savingFilters ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              {savingFilters ? t("action.saving") : t("action.saveFilters")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={hydrationState !== "ready" || isRunActive || requiresReset || formPending}
            >
              {startPending ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              {startPending ? t("action.starting") : t("action.start")}
            </Button>
            {run.status === "paused-captcha" && runnerRef.current && (
              <Button type="button" variant="primary" onClick={handleResume}>
                <Play size={16} />
                {t("action.resume")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={handleCancel}
              disabled={!isRunActive || !canControlActiveRun}
            >
              <Square size={16} />
              {t("action.cancel")}
            </Button>
            {actionFeedback && <span className="action-feedback" role="status">{actionFeedback}</span>}
          </div>
        </form>

        <section
          className="results-surface"
          aria-busy={hydrationState === "loading" || isRunning}
        >
          {hydrationState === "ready" && (
            <>
          <div className="metrics-grid">
            <Metric label={t("metric.found")} value={run.found} />
            <Metric label={t("metric.pages")} value={run.pagesVisited} />
            <Metric label={filters.collectDetailPages ? t("metric.detailed") : t("metric.collected")} value={run.collected} />
            <Metric label={t("metric.stored")} value={records.length} />
            {(plan || run.evaluated > 0) && (
              <>
                <Metric label={t("metric.evaluated")} value={run.evaluated} />
                <Metric label={t("metric.relevant")} value={run.relevant} />
                <Metric label={t("metric.review")} value={run.review} />
              </>
            )}
          </div>

          {run.status !== "idle" && (
            <div
              className="run-progress"
              role="progressbar"
              aria-live="polite"
              aria-label={t("popup.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={Math.max(run.target, 1)}
              aria-valuenow={Math.min(run.collected, Math.max(run.target, 1))}
              aria-valuetext={t("popup.progressValue", {
                current: formatNumber(run.collected),
                total: formatNumber(run.target),
              })}
            >
              <span>{resolveText(run.message, "results.localStorage").text}</span>
              <strong>{formatNumber(run.collected)} / {formatNumber(run.target)}</strong>
              <progress max={Math.max(run.target, 1)} value={Math.min(run.collected, Math.max(run.target, 1))} />
            </div>
          )}

          {run.error && (
            <div className="inline-alert danger" role="alert">
              <AlertTriangle size={16} />
              <LocalizedMessageView value={run.error} />
            </div>
          )}

          {(run.intelligenceStatus === "partial" || run.intelligenceStatus === "failed") && (
            <EvaluationRecoveryAlert
              status={run.intelligenceStatus}
              evaluated={successfulEvaluationCount}
              failures={evaluationFailures}
              pending={reevaluationPending}
              onRetry={() => void handleReevaluate(true)}
              onCopyRequestId={(requestId) => void handleCopyRequestId(requestId)}
            />
          )}

          <div className="results-head">
            <div>
              <h2>{t("results.title")}</h2>
              <p>{t("results.localStorage")}</p>
            </div>
            <div className="results-actions">
              <div className="results-search">
                <label className="sr-only" htmlFor="record-search">{t("results.searchLabel")}</label>
                <input
                  id="record-search"
                  className="input"
                  type="search"
                  name="record-search"
                  autoComplete="off"
                  value={recordQuery}
                  placeholder={t("results.searchPlaceholder")}
                  onChange={(event) => {
                    setRecordQuery(event.target.value);
                    setResultsPage(1);
                  }}
                />
                {recordQuery && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    iconOnly
                    aria-label={t("action.clearSearch")}
                    onClick={() => {
                      setRecordQuery("");
                      setResultsPage(1);
                    }}
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
              <Select
                aria-label={t("results.filterAria")}
                value={decisionFilter}
                onChange={(event) => {
                  setDecisionFilter(event.target.value as typeof decisionFilter);
                  setResultsPage(1);
                }}
              >
                <option value="all">{t("results.allDecisions")}</option>
                <option value="relevant">{t("decision.relevant")}</option>
                <option value="not-relevant">{t("decision.not-relevant")}</option>
                <option value="review">{t("decision.review")}</option>
              </Select>
              <label className="page-size-control">
                <span>{t("results.recordsPerPage")}</span>
                <Select
                  aria-label={t("results.recordsPerPage")}
                  value={recordsPageSize}
                  onChange={(event) => {
                    setRecordsPageSize(parseRecordsPageSize(event.target.value));
                    setResultsPage(1);
                  }}
                >
                  {RECORDS_PAGE_SIZES.map((pageSize) => (
                    <option key={pageSize} value={pageSize}>
                      {t("results.perPageOption", { count: pageSize })}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                type="button"
                size="sm"
                variant="danger"
                onClick={handleClear}
                disabled={(records.length === 0 && run.status === "idle") || isRunActive}
              >
                <Trash2 size={15} />
                {t("action.clear")}
              </Button>
            </div>
          </div>

          {visibleRecords.length === 0 ? (
            <EmptyState>
              <div className="empty-copy">
                <Database size={24} />
                <span>{records.length === 0 ? t("results.empty") : t("results.emptyFilter")}</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={records.length === 0 ? focusSearchConfiguration : resetResultFilters}
                >
                  {records.length === 0 ? t("action.configureSearch") : t("action.clearSearch")}
                </Button>
              </div>
            </EmptyState>
          ) : (
            <div className="records-grid" role="list">
              {visibleRecords.map((record) => (
                <PropertyRecordCard key={record.listingUrl} record={record} />
              ))}
            </div>
          )}
          {filteredRecords.length > 0 && (
            <p className="records-limit">
              {t("results.showing", {
                count: visibleRecords.length,
                visible: formatNumber(visibleRecords.length),
                total: formatNumber(filteredRecords.length),
              })}
            </p>
          )}
          {resultsPageCount > 1 && (
            <nav className="pagination" aria-label={t("results.page", { page: currentResultsPage, pages: resultsPageCount })}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setResultsPage((current) => Math.max(1, current - 1))}
                disabled={currentResultsPage === 1}
              >
                <ChevronLeft size={14} />
                {t("action.previousPage")}
              </Button>
              <span aria-current="page">
                {t("results.page", {
                  page: formatNumber(currentResultsPage),
                  pages: formatNumber(resultsPageCount),
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setResultsPage((current) => Math.min(resultsPageCount, current + 1))}
                disabled={currentResultsPage === resultsPageCount}
              >
                {t("action.nextPage")}
                <ChevronRight size={14} />
              </Button>
            </nav>
          )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

interface ResultsViewState {
  decision: "all" | ListingEvaluation["decision"];
  query: string;
  page: number;
  pageSize: RecordsPageSize;
}

export function parseResultsViewState(search: string): ResultsViewState {
  const params = new URLSearchParams(search);
  const rawDecision = params.get("decision");
  const decision = rawDecision === "relevant" || rawDecision === "not-relevant" || rawDecision === "review"
    ? rawDecision
    : "all";
  const rawPage = Number(params.get("page"));
  return {
    decision,
    query: params.get("q")?.trim() ?? "",
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    pageSize: parseRecordsPageSize(params.get("pageSize")),
  };
}

export function parseRecordsPageSize(value: unknown): RecordsPageSize {
  const parsedValue = Number(value);
  return RECORDS_PAGE_SIZES.find((pageSize) => pageSize === parsedValue)
    ?? DEFAULT_RECORDS_PAGE_SIZE;
}

export function resolveResultsPage(
  requestedPage: number,
  pageCount: number,
  hydrated: boolean,
): number {
  if (!hydrated) return requestedPage;
  return Math.max(1, Math.min(requestedPage, pageCount));
}

function readResultsViewState(): ResultsViewState {
  return parseResultsViewState(typeof window === "undefined" ? "" : window.location.search);
}

function setOptionalSearchParam(url: URL, name: string, value: string) {
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
}

export function recordMatchesQuery(
  record: ScrapedPropertyRecord,
  query: string,
  locale = "fr",
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return true;
  return [
    record.title,
    record.location,
    record.priceText,
    record.propertyType,
    record.sellerName,
    ...record.features,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase(locale)
    .includes(normalizedQuery);
}

export function recipeFromDrafts(
  recipe: IntelligenceRecipe,
  thresholdDraft: string,
  weightDrafts: Record<string, string>,
): IntelligenceRecipe {
  return {
    ...recipe,
    threshold: numericDraftValue(thresholdDraft),
    criteria: recipe.criteria.map((criterion) => ({
      ...criterion,
      weight: numericDraftValue(weightDrafts[criterion.id] ?? String(criterion.weight)),
    })),
  };
}

function numericDraftValue(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

export function reconcileDashboardRun(
  run: ScrapeRun,
  hasLiveRunner: boolean,
  finishedAt?: string,
): ScrapeRun {
  return hasLiveRunner ? run : reconcileInterruptedRun(run, finishedAt);
}

export async function hasLiveDashboardRunner(
  hasLocalRunner: boolean,
  lockManager: Pick<DashboardRunnerLockManager, "query"> = navigator.locks,
): Promise<boolean> {
  if (hasLocalRunner) return true;

  try {
    const snapshot = await lockManager.query();
    return Boolean(
      snapshot.held?.some((lock) => lock.name === DASHBOARD_RUNNER_LOCK_NAME),
    );
  } catch {
    return false;
  }
}

export async function withDashboardRunnerLease<T>(
  operation: () => Promise<T>,
  lockManager: Pick<DashboardRunnerLockManager, "request"> = navigator.locks,
): Promise<T> {
  return lockManager.request(
    DASHBOARD_RUNNER_LOCK_NAME,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new DashboardRunnerBusyError();
      }
      return operation();
    },
  );
}

async function waitForDashboardRunnerRelease(
  signal: AbortSignal,
  lockManager: Pick<DashboardRunnerLockManager, "request"> = navigator.locks,
): Promise<void> {
  await lockManager.request(
    DASHBOARD_RUNNER_LOCK_NAME,
    { mode: "shared", signal },
    async () => undefined,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface NumberFieldProps {
  label: string;
  name: string;
  value?: number | string;
  min?: number;
  max?: number;
  error?: string;
  onChange: (value: string) => void;
}

function NumberField({ label, name, value, min = 0, max, error, onChange }: NumberFieldProps) {
  const errorId = `${name}-error`;
  return (
    <label className="field">
      <SectionLabel>{label}</SectionLabel>
      <input
        id={name}
        className="input"
        type="number"
        name={name}
        autoComplete="off"
        inputMode="numeric"
        step={1}
        min={min}
        max={max}
        value={value ?? ""}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <small id={errorId} className="field-error">{error}</small>}
    </label>
  );
}

interface StatusPillProps {
  run: ScrapeRun;
}

function StatusPill({ run }: StatusPillProps) {
  const { t } = useExtensionI18n();
  const tone =
    run.status === "completed"
      ? "good"
      : run.status === "failed" || run.status === "blocked-activity" || run.status === "blocked-captcha"
        ? "danger"
        : run.status === "paused-captcha"
          ? "sunset"
          : "sea";

  return (
    <Chip tone={tone}>
      <span className="status-dot" />
      {t(`status.${run.status}`)}
    </Chip>
  );
}

interface MetricProps {
  label: string;
  value: number;
}

function Metric({ label, value }: MetricProps) {
  const { formatNumber } = useExtensionI18n();
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

interface EvaluationRecoveryAlertProps {
  status: "partial" | "failed";
  evaluated: number;
  failures: ListingEvaluationFailure[];
  pending: boolean;
  onRetry: () => void;
  onCopyRequestId: (requestId: string) => void;
}

function EvaluationRecoveryAlert({
  status,
  evaluated,
  failures,
  pending,
  onRetry,
  onCopyRequestId,
}: EvaluationRecoveryAlertProps) {
  const { formatNumber, t } = useExtensionI18n();
  const retryableCount = failures.filter((failure) => failure.retryable).length;
  const requestIds = Array.from(new Set(
    failures.flatMap((failure) => failure.requestId ? [failure.requestId] : []),
  ));
  const uniqueFailures = Array.from(new Map(
    failures.map((failure) => [failure.code, failure]),
  ).values());

  return (
    <div
      className={`inline-alert intelligence-recovery ${status === "failed" ? "danger" : "warning"}`}
      role={status === "failed" ? "alert" : "status"}
      aria-atomic="true"
    >
      <AlertTriangle aria-hidden="true" size={16} />
      <div className="intelligence-recovery-copy">
        <strong>
          {status === "failed"
            ? t("results.intelligenceFailedPreserved")
            : t("results.intelligencePartial", {
                count: failures.length,
                evaluated: formatNumber(evaluated),
                pending: formatNumber(failures.length),
                total: formatNumber(evaluated + failures.length),
              })}
        </strong>
        {retryableCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={onRetry}
          >
            {pending ? <LoaderCircle className="spin" aria-hidden="true" size={14} /> : <RefreshCw aria-hidden="true" size={14} />}
            {pending
              ? t("intelligence.reevaluating")
              : t("intelligence.retryPending", {
                  count: retryableCount,
                })}
          </Button>
        )}
        {(uniqueFailures.length > 0 || requestIds.length > 0) && (
          <details className="intelligence-failure-details">
            <summary>{t("results.intelligenceFailureDetails")}</summary>
            <div>
              {uniqueFailures.map((failure) => (
                <LocalizedMessageView
                  key={failure.code}
                  value={evaluationFailureDescriptor(failure)}
                />
              ))}
              {requestIds.map((requestId) => (
                <div className="request-id-row" key={requestId}>
                  <span>{t("results.requestId")}</span>
                  <code translate="no">{requestId}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onCopyRequestId(requestId)}
                  >
                    {t("action.copyRequestId")}
                  </Button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

interface EvaluationFailureNoticeProps {
  failure: ListingEvaluationFailure;
  hasPreviousEvaluation: boolean;
}

function EvaluationFailureNotice({
  failure,
  hasPreviousEvaluation,
}: EvaluationFailureNoticeProps) {
  const { t } = useExtensionI18n();
  return (
    <section className="evaluation-failure-notice" role="status">
      <AlertTriangle aria-hidden="true" size={15} />
      <div>
        <strong>
          {hasPreviousEvaluation
            ? t("evaluation.pendingWithPrevious")
            : t("evaluation.pending")}
        </strong>
        <LocalizedMessageView value={evaluationFailureDescriptor(failure)} />
      </div>
    </section>
  );
}

interface PropertyRecordCardProps {
  record: ScrapedPropertyRecord;
}

function PropertyRecordCard({ record }: PropertyRecordCardProps) {
  const { formatNumber, resolveText, t } = useExtensionI18n();
  const recordError = resolveText(record.error);
  const displayTitle = record.title ?? t("record.titleUnavailable");

  return (
    <article className="record-card" role="listitem">
      <div className="record-main">
        <PropertyImagePreview record={record} title={displayTitle} />
        <div>
          <div className="record-title-row">
            <h3>{displayTitle}</h3>
            <a className="btn sm icon" href={record.listingUrl} target="_blank" rel="noreferrer" aria-label={t("record.openListing")}>
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="record-price">{record.priceText ?? t("record.noPrice")}</div>
          <div className="record-location">{record.location ?? t("record.locationPending")}</div>
        </div>
      </div>

      <div className="record-facts">
        <Fact label={t("record.type")} value={record.propertyType} />
        <Fact label={t("record.rooms")} value={record.rooms === undefined ? undefined : formatNumber(record.rooms)} />
        <Fact label={t("record.beds")} value={record.bedrooms === undefined ? undefined : formatNumber(record.bedrooms)} />
        <Fact label={t("record.surface")} value={record.surfaceM2 === undefined ? undefined : `${formatNumber(record.surfaceM2)} m²`} />
        <Fact label={t("record.dpe")} value={record.energyClass} />
        <Fact label={t("record.ges")} value={record.gesClass} />
      </div>

      {record.description && <p className="record-description">{record.description}</p>}

      {record.evaluationFailure && (
        <EvaluationFailureNotice
          failure={record.evaluationFailure}
          hasPreviousEvaluation={Boolean(record.planEvaluation ?? record.evaluation)}
        />
      )}

      {record.planEvaluation
        ? <PlanEvaluationSummary evaluation={record.planEvaluation} />
        : record.evaluation && <EvaluationSummary evaluation={record.evaluation} />}

      <div className="record-footer">
        <Chip tone={record.status === "failed" ? "danger" : record.status === "detailed" ? "good" : "sea"}>
          {t(`recordStatus.${record.status}`)}
        </Chip>
        {record.features.slice(0, 4).map((feature) => (
          <Chip key={feature}>{feature}</Chip>
        ))}
        {record.error && (
          <span className="record-error">
            {recordError.text}
            {recordError.technicalDetail && (
              <> · {t("error.technicalDetail", { detail: recordError.technicalDetail })}</>
            )}
          </span>
        )}
      </div>
    </article>
  );
}

interface PropertyImagePreviewProps {
  record: ScrapedPropertyRecord;
  title: string;
}

function PropertyImagePreview({ record, title }: PropertyImagePreviewProps) {
  const { formatNumber, t } = useExtensionI18n();
  const imageUrls = useMemo(() => getRecordImageUrls(record), [record]);
  const imageSignature = imageUrls.join("\n");
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setActiveImageIndex(0);
    setFailedImageUrls(new Set());
  }, [imageSignature]);

  const activeImageUrl = imageUrls[activeImageIndex];
  const hasVisibleImage = Boolean(activeImageUrl && !failedImageUrls.has(activeImageUrl));
  const availableImageCount = imageUrls.filter((url) => !failedImageUrls.has(url)).length;

  function moveImage(direction: -1 | 1) {
    const nextIndex = findAvailableImageIndex(
      imageUrls,
      activeImageIndex,
      direction,
      failedImageUrls,
    );
    if (nextIndex !== undefined) setActiveImageIndex(nextIndex);
  }

  function handleImageError() {
    if (!activeImageUrl) return;
    const nextFailedImageUrls = new Set(failedImageUrls);
    nextFailedImageUrls.add(activeImageUrl);
    setFailedImageUrls(nextFailedImageUrls);
    const nextIndex = findAvailableImageIndex(
      imageUrls,
      activeImageIndex,
      1,
      nextFailedImageUrls,
    );
    if (nextIndex !== undefined) setActiveImageIndex(nextIndex);
  }

  return (
    <figure className="record-gallery">
      {hasVisibleImage && activeImageUrl ? (
        <img
          key={activeImageUrl}
          src={activeImageUrl}
          alt={t("record.imageAlt", {
            index: formatNumber(activeImageIndex + 1),
            title,
            total: formatNumber(imageUrls.length),
          })}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={handleImageError}
        />
      ) : (
        <div
          className="image-fallback"
          role="img"
          aria-label={imageUrls.length > 0 ? t("record.imageUnavailable") : t("record.noImage")}
        >
          <Search aria-hidden="true" size={22} />
          <span>{imageUrls.length > 0 ? t("record.imageUnavailable") : t("record.noImage")}</span>
        </div>
      )}

      {imageUrls.length > 1 && availableImageCount > 1 && (
        <>
          <Button
            className="gallery-nav previous"
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={t("record.previousImage", { title })}
            onClick={() => moveImage(-1)}
          >
            <ChevronLeft aria-hidden="true" size={16} />
          </Button>
          <Button
            className="gallery-nav next"
            size="sm"
            variant="ghost"
            iconOnly
            aria-label={t("record.nextImage", { title })}
            onClick={() => moveImage(1)}
          >
            <ChevronRight aria-hidden="true" size={16} />
          </Button>
        </>
      )}

      {imageUrls.length > 1 && hasVisibleImage && (
        <figcaption className="gallery-counter" aria-live="polite">
          {formatNumber(activeImageIndex + 1)} / {formatNumber(imageUrls.length)}
        </figcaption>
      )}
    </figure>
  );
}

export function getRecordImageUrls(record: ScrapedPropertyRecord): string[] {
  const imageUrls: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [record.imageUrl, ...(record.imageUrls ?? [])]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const normalizedUrl = new URL(candidate.trim(), record.listingUrl);
      if (normalizedUrl.protocol !== "http:" && normalizedUrl.protocol !== "https:") continue;
      if (seen.has(normalizedUrl.href)) continue;
      seen.add(normalizedUrl.href);
      imageUrls.push(normalizedUrl.href);
    } catch {
      // Ignore malformed or unsafe image locations persisted by older builds.
    }
  }

  return imageUrls;
}

function findAvailableImageIndex(
  imageUrls: readonly string[],
  activeIndex: number,
  direction: -1 | 1,
  failedImageUrls: ReadonlySet<string>,
): number | undefined {
  for (let offset = 1; offset <= imageUrls.length; offset += 1) {
    const candidateIndex = (activeIndex + (offset * direction) + imageUrls.length) % imageUrls.length;
    const candidateUrl = imageUrls[candidateIndex];
    if (candidateUrl && !failedImageUrls.has(candidateUrl)) return candidateIndex;
  }
  return undefined;
}

interface FactProps {
  label: string;
  value?: string;
}

function Fact({ label, value }: FactProps) {
  const { t } = useExtensionI18n();
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value ?? t("record.missingValue")}</strong>
    </div>
  );
}

interface EvaluationSummaryProps {
  evaluation: ListingEvaluation;
}

function EvaluationSummary({ evaluation }: EvaluationSummaryProps) {
  const { formatDateTime, formatList, formatNumber, locale, t } = useExtensionI18n();
  const tone = evaluation.decision === "relevant" ? "good" : evaluation.decision === "review" ? "sunset" : "danger";
  const missingFields = evaluation.missingData.map((field) => missingFieldLabel(field, t));
  const hasLocaleMismatch = evaluation.locale !== undefined && evaluation.locale !== locale;
  return (
    <section className="evaluation-summary" aria-label={t("evaluation.aria")}>
      <div className="evaluation-head">
        <Chip tone={tone}>{t(`decision.${evaluation.decision}`)}</Chip>
        <strong>{evaluation.score === null ? t("evaluation.noScore") : `${formatNumber(Math.round(evaluation.score))} / 100`}</strong>
      </div>
      <p>{evaluation.summary}</p>
      <details>
        <summary>{t("evaluation.evidence")}</summary>
        <div className="evaluation-criteria">
          {evaluation.criteria.map((criterion) => (
            <div key={criterion.criterionId} className={`criterion-result ${criterion.verdict}`}>
              <strong>{t(`verdict.${criterion.verdict}`)}</strong>
              <span>{criterion.reason}</span>
              {criterion.evidence.length > 0 && <small>{criterion.evidence.join(" · ")}</small>}
            </div>
          ))}
        </div>
      </details>
      {evaluation.missingData.length > 0 && (
        <small className="missing-data">
          {t("evaluation.missing", { fields: formatList(missingFields) })}
        </small>
      )}
      {hasLocaleMismatch && (
        <small className="evaluation-language-note">
          {t("intelligence.languageMismatch", {
            language: localeDisplayName(evaluation.locale!, t),
          })}
        </small>
      )}
      {evaluation.locale === undefined && (
        <small className="evaluation-language-note">{t("intelligence.legacyLanguage")}</small>
      )}
      <small className="evaluation-meta" translate="no">
        {t("evaluation.meta", {
          version: formatNumber(evaluation.recipeVersion),
          model: evaluation.evaluator.model,
          date: formatDateTime(evaluation.evaluatedAt, { dateStyle: "medium", timeStyle: "short" }),
        })}
      </small>
    </section>
  );
}

interface PlanEvaluationSummaryProps {
  evaluation: PlanEvaluation;
}

function PlanEvaluationSummary({ evaluation }: PlanEvaluationSummaryProps) {
  const { formatDateTime, formatNumber, t } = useExtensionI18n();
  const tone = evaluation.decision === "relevant"
    ? "good"
    : evaluation.decision === "review"
      ? "sunset"
      : "danger";
  return (
    <section className="evaluation-summary" aria-label={t("evaluation.aria")}>
      <div className="evaluation-head">
        <Chip tone={tone}>{t(`decision.${evaluation.decision}`)}</Chip>
        <strong>{evaluation.score === null ? t("evaluation.noScore") : `${formatNumber(Math.round(evaluation.score))} / 100`}</strong>
      </div>
      <p>{evaluation.summary}</p>
      <details>
        <summary>{t("evaluation.recipeBreakdown")}</summary>
        <div className="evaluation-criteria">
          {evaluation.steps.map((step) => (
            <div key={`${step.recipeId}:${step.recipeVersion}`} className={`criterion-result ${step.status === "failed" ? "fail" : "pass"}`}>
              <strong translate="no">{step.recipeId} v{formatNumber(step.recipeVersion)} · {step.status}</strong>
              {step.evaluation?.criteria.map((criterion) => (
                <span key={criterion.criterionId}>
                  {t(`verdict.${criterion.verdict}`)} · {criterion.reason}
                  {criterion.evidence.length > 0 ? ` · ${criterion.evidence.join(" · ")}` : ""}
                </span>
              ))}
              {step.evaluator && (
                <small className="evaluation-meta" translate="no">
                  {step.evaluator.provider} · {step.evaluator.model} · {step.evaluator.version}
                </small>
              )}
              {step.error && <span>{step.error.code}{step.error.message ? ` · ${step.error.message}` : ""}</span>}
            </div>
          ))}
        </div>
      </details>
      <small className="evaluation-meta" translate="no">
        {t("evaluation.planMeta", {
          version: formatNumber(evaluation.planVersion),
          date: formatDateTime(evaluation.evaluatedAt ?? new Date(0).toISOString(), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </small>
    </section>
  );
}

interface LocalizedMessageViewProps {
  value: unknown;
  fallbackId?: ExtensionMessageId;
}

function LocalizedMessageView({ value, fallbackId }: LocalizedMessageViewProps) {
  const { resolveText, t } = useExtensionI18n();
  const resolved = resolveText(value, fallbackId);

  return (
    <span className="localized-message">
      <span>{resolved.text}</span>
      {resolved.technicalDetail && (
        <small className="technical-detail">
          {t("error.technicalDetail", { detail: resolved.technicalDetail })}
        </small>
      )}
    </span>
  );
}
