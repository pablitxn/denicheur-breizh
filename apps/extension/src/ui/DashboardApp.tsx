import {
  AlertTriangle,
  Brain,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  LoaderCircle,
  Play,
  Plus,
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
  evaluateDetailedRecordsInBatches,
  filterApiErrorDescriptor,
  mergeRecordEvaluations,
} from "../intelligence/filterApi";
import {
  createDefaultIntelligenceRecipe,
  createEmptyCriterion,
  MAX_INTELLIGENCE_CRITERIA,
  normalizeIntelligenceRecipe,
  validateIntelligenceRecipe,
  type RecipeValidationIssue,
} from "../intelligence/recipe";
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
  IntelligenceCriterion,
  IntelligenceRecipe,
  ListingEvaluation,
  ScrapeRun,
  ScrapedPropertyRecord,
  SearchFilters,
} from "../lib/types";
import {
  clearRecords,
  CRAWLER_STORAGE_KEYS,
  IDLE_RUN,
  loadCrawlerState,
  reconcileInterruptedRun,
  saveCrawlerState,
  saveFilters,
  saveRecipe,
  saveRun,
} from "../storage/chromeStorage";
import {
  useThemePreference,
  type ThemePreference,
} from "./theme";

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
const RECORDS_PAGE_SIZE = 24;
const DASHBOARD_RUNNER_LOCK_NAME = "denicheur:crawler:dashboard-runner";

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
  const [recipe, setRecipe] = useState<IntelligenceRecipe>(createDefaultIntelligenceRecipe);
  const [thresholdDraft, setThresholdDraft] = useState("70");
  const [criterionWeightDrafts, setCriterionWeightDrafts] = useState<Record<string, string>>({});
  const [filtersDirty, setFiltersDirty] = useState(false);
  const [recipeDirty, setRecipeDirty] = useState(false);
  const [hydrationState, setHydrationState] = useState<"loading" | "ready" | "error">("loading");
  const [hydrationRetry, setHydrationRetry] = useState(0);
  const [loadError, setLoadError] = useState<unknown>();
  const initialResultsState = useMemo(readResultsViewState, []);
  const [decisionFilter, setDecisionFilter] = useState<"all" | ListingEvaluation["decision"]>(initialResultsState.decision);
  const [recordQuery, setRecordQuery] = useState(initialResultsState.query);
  const [resultsPage, setResultsPage] = useState(initialResultsState.page);
  const [intelligenceExpanded, setIntelligenceExpanded] = useState(false);
  const [savingFilters, setSavingFilters] = useState(false);
  const [savingRecipe, setSavingRecipe] = useState(false);
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
  const recipeDirtyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const reevaluationAbortRef = useRef<AbortController | undefined>(undefined);
  const isRunning = RUNNING_STATUSES.has(run.status);
  const isRunActive = isRunning || run.status === "paused-captcha";
  const canControlActiveRun = Boolean(runnerRef.current || reevaluationAbortRef.current);
  const requiresReset = run.status === "blocked-captcha" || run.status === "blocked-activity";
  const formPending = savingFilters || savingRecipe || reevaluationPending || startPending;
  const filterIssues = useMemo(() => validateSearchFilters(filters), [filters]);
  const filterIssueMessages = useMemo(
    () => new Map(filterIssues.map((issue) => [
      issue.field,
      translateFilterValidationIssue(issue, filters, t),
    ])),
    [filterIssues, filters, t],
  );
  const recipeDraft = useMemo(
    () => recipeFromDrafts(recipe, thresholdDraft, criterionWeightDrafts),
    [criterionWeightDrafts, recipe, thresholdDraft],
  );
  const recipeIssues = useMemo(
    () => validateIntelligenceRecipe(recipeDraft),
    [recipeDraft],
  );
  const recipeIssueMessages = useMemo(
    () => new Map(recipeIssues.map((issue) => [
      recipeIssueKey(issue.field, issue.criterionId),
      t(recipeValidationMessageId(issue.code), { max: MAX_INTELLIGENCE_CRITERIA }),
    ])),
    [recipeIssues, t],
  );
  const filteredRecords = useMemo(
    () => records.filter((record) => {
      if (decisionFilter !== "all" && record.evaluation?.decision !== decisionFilter) return false;
      return recordMatchesQuery(record, recordQuery, locale);
    }),
    [decisionFilter, locale, recordQuery, records],
  );
  const resultsPageCount = Math.max(1, Math.ceil(filteredRecords.length / RECORDS_PAGE_SIZE));
  const currentResultsPage = resolveResultsPage(
    resultsPage,
    resultsPageCount,
    hydrationState === "ready",
  );
  const visibleRecords = useMemo(() => {
    const offset = (currentResultsPage - 1) * RECORDS_PAGE_SIZE;
    return filteredRecords.slice(offset, offset + RECORDS_PAGE_SIZE);
  }, [currentResultsPage, filteredRecords]);
  useEffect(() => {
    let mounted = true;
    setHydrationState("loading");
    setLoadError(undefined);

    void loadCrawlerState()
      .then(async (snapshot) => {
        const hasLiveRunner = await hasLiveDashboardRunner(
          Boolean(runnerRef.current),
        );
        const recoveredRun = reconcileDashboardRun(snapshot.run, hasLiveRunner);
        if (recoveredRun !== snapshot.run) await saveRun(recoveredRun);
        if (!mounted) return;

        setFilters(snapshot.filters);
        setRun(recoveredRun);
        setRecords(snapshot.records);
        setRecipe(snapshot.recipe);
        setThresholdDraft(String(snapshot.recipe.threshold));
        setCriterionWeightDrafts(weightDraftsFromRecipe(snapshot.recipe));
        setFiltersDirtyState(false);
        setRecipeDirtyState(false);
        setDraftConflict(false);
        setIntelligenceExpanded(snapshot.recipe.enabled);
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
        !Object.keys(changes).some((key) => Object.values(CRAWLER_STORAGE_KEYS).includes(
          key as (typeof CRAWLER_STORAGE_KEYS)[keyof typeof CRAWLER_STORAGE_KEYS],
        ))
      ) {
        return;
      }

      void loadCrawlerState()
        .then((snapshot) => {
          if (!mounted) return;
          if (CRAWLER_STORAGE_KEYS.filters in changes) {
            if (filtersDirtyRef.current) {
              setDraftConflict(true);
            } else {
              setFilters(snapshot.filters);
            }
          }
          if (CRAWLER_STORAGE_KEYS.recipe in changes) {
            if (recipeDirtyRef.current) {
              setDraftConflict(true);
            } else {
              setRecipe(snapshot.recipe);
              setThresholdDraft(String(snapshot.recipe.threshold));
              setCriterionWeightDrafts(weightDraftsFromRecipe(snapshot.recipe));
            }
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
      reevaluationAbortRef.current?.abort();
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
    if (hydrationState !== "ready") return;
    if (resultsPage > resultsPageCount) setResultsPage(resultsPageCount);
  }, [hydrationState, resultsPage, resultsPageCount]);

  useEffect(() => {
    if (hydrationState !== "ready") return;
    const url = new URL(window.location.href);
    setOptionalSearchParam(url, "decision", decisionFilter === "all" ? "" : decisionFilter);
    setOptionalSearchParam(url, "q", recordQuery.trim());
    setOptionalSearchParam(url, "page", currentResultsPage === 1 ? "" : String(currentResultsPage));
    window.history.replaceState(null, "", url);
  }, [currentResultsPage, decisionFilter, hydrationState, recordQuery]);

  useEffect(() => {
    if (!filtersDirty && !recipeDirty) return;
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnAboutUnsavedChanges);
    return () => window.removeEventListener("beforeunload", warnAboutUnsavedChanges);
  }, [filtersDirty, recipeDirty]);

  function setFiltersDirtyState(nextDirty: boolean) {
    filtersDirtyRef.current = nextDirty;
    setFiltersDirty(nextDirty);
  }

  function setRecipeDirtyState(nextDirty: boolean) {
    recipeDirtyRef.current = nextDirty;
    setRecipeDirty(nextDirty);
  }

  function markFiltersDirty() {
    setFiltersDirtyState(true);
    setActionFeedback(undefined);
  }

  function markRecipeDirty() {
    setRecipeDirtyState(true);
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

  function patchRecipe(patch: Partial<IntelligenceRecipe>) {
    setRecipe((current) => ({ ...current, ...patch }));
    if (patch.enabled) setIntelligenceExpanded(true);
    markRecipeDirty();
  }

  function patchCriterion(id: string, patch: Partial<IntelligenceCriterion>) {
    setRecipe((current) => ({
      ...current,
      criteria: current.criteria.map((criterion) =>
        criterion.id === id ? { ...criterion, ...patch } : criterion,
      ),
    }));
    markRecipeDirty();
  }

  function addCriterion() {
    const criterion = createEmptyCriterion();
    setRecipe((current) => ({ ...current, criteria: [...current.criteria, criterion] }));
    setCriterionWeightDrafts((current) => ({ ...current, [criterion.id]: String(criterion.weight) }));
    markRecipeDirty();
    requestAnimationFrame(() => document.getElementById(`criterion-name-${criterion.id}`)?.focus());
  }

  function removeCriterion(id: string) {
    const index = recipe.criteria.findIndex((criterion) => criterion.id === id);
    if (!window.confirm(t("confirm.removeCriterion", { index: index + 1 }))) return;
    const nextFocusId = recipe.criteria[index + 1]?.id ?? recipe.criteria[index - 1]?.id;
    setRecipe((current) => ({
      ...current,
      criteria: current.criteria.filter((criterion) => criterion.id !== id),
    }));
    setCriterionWeightDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    markRecipeDirty();
    requestAnimationFrame(() => {
      if (nextFocusId) {
        document.getElementById(`criterion-name-${nextFocusId}`)?.focus();
      } else {
        document.getElementById("add-criterion")?.focus();
      }
    });
  }

  function patchThresholdDraft(value: string) {
    setThresholdDraft(value);
    markRecipeDirty();
  }

  function patchCriterionWeightDraft(id: string, value: string) {
    setCriterionWeightDrafts((current) => ({ ...current, [id]: value }));
    markRecipeDirty();
  }

  async function persistRecipeForUse(): Promise<IntelligenceRecipe> {
    const issues = validateIntelligenceRecipe(recipeDraft);
    if (issues.length > 0) {
      focusRecipeIssue(issues[0]);
      throw new Error(t(recipeValidationMessageId(issues[0].code), { max: MAX_INTELLIGENCE_CRITERIA }));
    }
    const versionedRecipe = recipeDirty
      ? { ...recipeDraft, version: recipeDraft.version + 1 }
      : recipeDraft;
    const nextRecipe = normalizeIntelligenceRecipe(versionedRecipe);
    setRecipeDirtyState(false);
    try {
      await saveRecipe(nextRecipe);
      setRecipe(nextRecipe);
      setThresholdDraft(String(nextRecipe.threshold));
      setCriterionWeightDrafts(weightDraftsFromRecipe(nextRecipe));
      setDraftConflict(false);
      return nextRecipe;
    } catch (caught) {
      setRecipeDirtyState(true);
      throw caught;
    }
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

  async function handleSaveRecipe() {
    setError(undefined);
    setSavingRecipe(true);
    setActionFeedback(t("action.saving"));
    try {
      await persistRecipeForUse();
      setActionFeedback(t("feedback.recipeSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setActionFeedback(undefined);
    } finally {
      setSavingRecipe(false);
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

  function focusFirstFilterIssue() {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  function focusRecipeIssue(issue: RecipeValidationIssue | undefined) {
    if (!issue) return;
    setIntelligenceExpanded(true);
    const id = recipeIssueControlId(issue);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
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
    reevaluationAbortRef.current?.abort();
    setError(undefined);
    setActionFeedback(t("action.starting"));

    try {
      await withDashboardRunnerLease(async () => {
        const recipeForRun = await persistRecipeForUse();
        const normalizedFilters = await persistFiltersForUse();
        const runnableFilters = normalizeSearchFilters({
          ...normalizedFilters,
          collectDetailPages: recipeForRun.enabled ? true : normalizedFilters.collectDetailPages,
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
        await runner.run(runnableFilters, recipeForRun, locale);
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
    reevaluationAbortRef.current?.abort();
  }

  function handleResume() {
    runnerRef.current?.resume();
  }

  async function handleReevaluate() {
    if (reevaluationPendingRef.current) return;
    reevaluationPendingRef.current = true;
    setReevaluationPending(true);
    setError(undefined);
    setActionFeedback(t("intelligence.reevaluating"));
    try {
      const recipeForRun = await persistRecipeForUse();
      if (!recipeForRun.enabled) throw extensionMessage("error.enableRecipe");
      const detailedRecords = records.filter((record) => record.status === "detailed");
      if (detailedRecords.length === 0) throw extensionMessage("error.noDetailedRecords");

      const reevaluationRunId = `reevaluation-${Date.now()}`;
      const abortController = new AbortController();
      reevaluationAbortRef.current = abortController;
      const evaluatingRun: ScrapeRun = {
        ...run,
        status: "evaluating",
        intelligenceStatus: "evaluating",
        intelligenceError: undefined,
        message: extensionMessage("run.reevaluating", { count: detailedRecords.length }),
      };
      setRun(evaluatingRun);
      await saveCrawlerState({ run: evaluatingRun });

      try {
        const evaluations = await evaluateDetailedRecordsInBatches(
          reevaluationRunId,
          recipeForRun,
          detailedRecords,
          { locale, signal: abortController.signal },
        );
        const nextRecords = mergeRecordEvaluations(records, evaluations);
        const nextRun = runWithEvaluations(evaluatingRun, evaluations);
        setRecords(nextRecords);
        setRun(nextRun);
        await saveCrawlerState({ run: nextRun, records: nextRecords });
      } catch (caught) {
        const intelligenceError = filterApiErrorDescriptor(caught);
        const nextRun: ScrapeRun = {
          ...evaluatingRun,
          status: "completed",
          intelligenceStatus: "failed",
          intelligenceError,
          message: extensionMessage("run.reevaluationFailed"),
        };
        setRun(nextRun);
        await saveCrawlerState({ run: nextRun });
        throw intelligenceError;
      } finally {
        reevaluationAbortRef.current = undefined;
      }
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
            {(filtersDirty || recipeDirty) && (
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
                <Chip tone={recipe.enabled ? "good" : "sea"}>
                  {recipe.enabled ? t("intelligence.enabled") : t("intelligence.disabled")}
                </Chip>
              </span>
            </summary>
            <fieldset
              className="intelligence-content"
              disabled={hydrationState !== "ready" || isRunActive || formPending}
              aria-labelledby="intelligence-title"
            >
              <legend className="sr-only">{t("intelligence.title")}</legend>
              <div className="intelligence-head">
                <p>{t("intelligence.description")}</p>
              <label className="toggle">
                <input
                  type="checkbox"
                  name="intelligence-enabled"
                  checked={recipe.enabled}
                  onChange={(event) => patchRecipe({ enabled: event.target.checked })}
                />
                <span className="track" />
                <span>{t("intelligence.enable")}</span>
              </label>
              </div>

            <div className="recipe-grid">
              <label className="field wide">
                <SectionLabel>{t("intelligence.recipeName")}</SectionLabel>
                <input
                  id="recipe-name"
                  className="input"
                  name="recipe-name"
                  autoComplete="off"
                  maxLength={160}
                  value={recipe.name}
                  aria-invalid={Boolean(recipeIssueMessages.get("name"))}
                  aria-describedby={recipeIssueMessages.get("name") ? "recipe-name-error" : undefined}
                  onChange={(event) => patchRecipe({ name: event.target.value })}
                />
                {recipeIssueMessages.get("name") && (
                  <small id="recipe-name-error" className="field-error">
                    {recipeIssueMessages.get("name")}
                  </small>
                )}
              </label>
              <NumberField
                label={t("intelligence.threshold")}
                name="relevance-threshold"
                value={thresholdDraft}
                max={100}
                error={recipeIssueMessages.get("threshold")}
                onChange={patchThresholdDraft}
              />
              <div className="recipe-version">
                <SectionLabel>{t("intelligence.version")}</SectionLabel>
                <strong>
                  v{formatNumber(recipe.version)}
                  {recipeDirty ? ` · ${t("intelligence.unsaved")}` : ""}
                </strong>
              </div>
            </div>

            {recipeIssueMessages.get("criteria") && (
              <p id="criteria-error" className="field-error" role="alert">
                {recipeIssueMessages.get("criteria")}
              </p>
            )}
            <div className="criteria-list" aria-describedby={recipeIssueMessages.get("criteria") ? "criteria-error" : undefined}>
              {recipe.criteria.length === 0 && (
                <p className="criteria-empty">{t("intelligence.emptyCriteria")}</p>
              )}
              {recipe.criteria.map((criterion, index) => (
                <article className="criterion-row" key={criterion.id}>
                  <div className="criterion-index">{index + 1}</div>
                  <div className="criterion-fields">
                    <input
                      id={`criterion-name-${criterion.id}`}
                      className="input"
                      name={`criterion-name-${criterion.id}`}
                      autoComplete="off"
                      maxLength={160}
                      value={criterion.name}
                      placeholder={t("intelligence.criterionName")}
                      aria-label={t("intelligence.criterionNameAria", { index: index + 1 })}
                      aria-invalid={Boolean(recipeIssueMessages.get(recipeIssueKey("criterion-name", criterion.id)))}
                      aria-describedby={recipeIssueMessages.get(recipeIssueKey("criterion-name", criterion.id)) ? `criterion-name-${criterion.id}-error` : undefined}
                      onChange={(event) => patchCriterion(criterion.id, { name: event.target.value })}
                    />
                    {recipeIssueMessages.get(recipeIssueKey("criterion-name", criterion.id)) && (
                      <small id={`criterion-name-${criterion.id}-error`} className="field-error">
                        {recipeIssueMessages.get(recipeIssueKey("criterion-name", criterion.id))}
                      </small>
                    )}
                    <textarea
                      id={`criterion-description-${criterion.id}`}
                      className="input criterion-description"
                      name={`criterion-description-${criterion.id}`}
                      value={criterion.description}
                      maxLength={2000}
                      placeholder={t("intelligence.criterionDescription")}
                      aria-label={t("intelligence.criterionDescriptionAria", { index: index + 1 })}
                      aria-invalid={Boolean(recipeIssueMessages.get(recipeIssueKey("criterion-description", criterion.id)))}
                      aria-describedby={recipeIssueMessages.get(recipeIssueKey("criterion-description", criterion.id)) ? `criterion-description-${criterion.id}-error` : undefined}
                      onChange={(event) => patchCriterion(criterion.id, { description: event.target.value })}
                    />
                    {recipeIssueMessages.get(recipeIssueKey("criterion-description", criterion.id)) && (
                      <small id={`criterion-description-${criterion.id}-error`} className="field-error">
                        {recipeIssueMessages.get(recipeIssueKey("criterion-description", criterion.id))}
                      </small>
                    )}
                    <div className="criterion-options">
                      <label>
                        <span>{t("intelligence.weight")}</span>
                        <input
                          id={`criterion-weight-${criterion.id}`}
                          className="input criterion-weight"
                          type="number"
                          name={`criterion-weight-${criterion.id}`}
                          autoComplete="off"
                          inputMode="numeric"
                          min={0}
                          max={100}
                          value={criterionWeightDrafts[criterion.id] ?? String(criterion.weight)}
                          aria-label={t("intelligence.weightAria", { index: index + 1 })}
                          aria-invalid={Boolean(recipeIssueMessages.get(recipeIssueKey("criterion-weight", criterion.id)))}
                          aria-describedby={recipeIssueMessages.get(recipeIssueKey("criterion-weight", criterion.id)) ? `criterion-weight-${criterion.id}-error` : undefined}
                          onChange={(event) => patchCriterionWeightDraft(criterion.id, event.target.value)}
                        />
                        {recipeIssueMessages.get(recipeIssueKey("criterion-weight", criterion.id)) && (
                          <small id={`criterion-weight-${criterion.id}-error`} className="field-error">
                            {recipeIssueMessages.get(recipeIssueKey("criterion-weight", criterion.id))}
                          </small>
                        )}
                      </label>
                      <label className="criterion-required">
                        <input
                          type="checkbox"
                          name={`criterion-required-${criterion.id}`}
                          checked={criterion.required}
                          onChange={(event) => patchCriterion(criterion.id, { required: event.target.checked })}
                        />
                        {t("intelligence.required")}
                      </label>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={t("intelligence.removeCriterion", { index: index + 1 })}
                    onClick={() => removeCriterion(criterion.id)}
                  >
                    <X size={14} />
                  </Button>
                </article>
              ))}
            </div>

            <div className="intelligence-actions">
              <Button id="add-criterion" type="button" size="sm" onClick={addCriterion} disabled={recipe.criteria.length >= 12}>
                <Plus size={14} />
                {t("intelligence.addCriterion")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={handleSaveRecipe} disabled={!recipeDirty || savingRecipe}>
                {savingRecipe ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
                {savingRecipe ? t("action.saving") : t("intelligence.saveRecipe")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleReevaluate}
                disabled={reevaluationPending || isRunActive || !recipe.enabled || records.every((record) => record.status !== "detailed")}
              >
                {reevaluationPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                {reevaluationPending ? t("intelligence.reevaluating") : t("intelligence.reevaluate")}
              </Button>
            </div>
            {recipe.enabled && <p className="intelligence-note">{t("intelligence.autoDetails")}</p>}
            </fieldset>
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
            {(recipe.enabled || run.evaluated > 0) && (
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

          {run.intelligenceStatus === "failed" && (
            <div className="inline-alert danger" role="alert">
              <AlertTriangle size={16} />
              <LocalizedMessageView
                value={run.intelligenceError}
                fallbackId="results.intelligenceFailed"
              />
            </div>
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
  };
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

function weightDraftsFromRecipe(recipe: IntelligenceRecipe): Record<string, string> {
  return Object.fromEntries(recipe.criteria.map((criterion) => [criterion.id, String(criterion.weight)]));
}

function recipeIssueKey(field: RecipeValidationIssue["field"], criterionId?: string): string {
  return criterionId ? `${field}:${criterionId}` : field;
}

function recipeValidationMessageId(
  code: RecipeValidationIssue["code"],
): ExtensionMessageId {
  const ids: Record<RecipeValidationIssue["code"], ExtensionMessageId> = {
    "name-required": "validation.recipeNameRequired",
    "name-too-long": "validation.recipeNameTooLong",
    "threshold-range": "validation.recipeThresholdRange",
    "criteria-required": "validation.recipeCriteriaRequired",
    "criteria-too-many": "validation.recipeCriteriaTooMany",
    "criterion-id-invalid": "validation.criterionIdInvalid",
    "criterion-name-required": "validation.criterionNameRequired",
    "criterion-name-too-long": "validation.criterionNameTooLong",
    "criterion-description-required": "validation.criterionDescriptionRequired",
    "criterion-description-too-long": "validation.criterionDescriptionTooLong",
    "criterion-weight-range": "validation.criterionWeightRange",
    "positive-weight-required": "validation.positiveWeightRequired",
  };
  return ids[code];
}

function recipeIssueControlId(issue: RecipeValidationIssue): string {
  if (issue.field === "name") return "recipe-name";
  if (issue.field === "threshold") return "relevance-threshold";
  if (issue.field === "criterion-name" && issue.criterionId) {
    return `criterion-name-${issue.criterionId}`;
  }
  if (issue.field === "criterion-description" && issue.criterionId) {
    return `criterion-description-${issue.criterionId}`;
  }
  if (issue.field === "criterion-weight" && issue.criterionId) {
    return `criterion-weight-${issue.criterionId}`;
  }
  return "add-criterion";
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
        throw new Error("Another dashboard already owns the crawler run.");
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

interface PropertyRecordCardProps {
  record: ScrapedPropertyRecord;
}

function PropertyRecordCard({ record }: PropertyRecordCardProps) {
  const { formatNumber, resolveText, t } = useExtensionI18n();
  const imageCount = record.imageUrls?.length ?? (record.imageUrl ? 1 : 0);
  const recordError = resolveText(record.error);

  return (
    <article className="record-card" role="listitem">
      <div className="record-main">
        <div
          className="image-fallback"
          role="img"
          aria-label={imageCount > 0
            ? t("record.imagesStored", { count: imageCount })
            : t("record.noImage")}
        >
          <Search size={22} />
        </div>
        <div>
          <div className="record-title-row">
            <h3>{record.title ?? t("record.titleUnavailable")}</h3>
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

      {record.evaluation && <EvaluationSummary evaluation={record.evaluation} />}

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

function runWithEvaluations(run: ScrapeRun, evaluations: ListingEvaluation[]): ScrapeRun {
  return {
    ...run,
    status: "completed",
    intelligenceStatus: "completed",
    intelligenceError: undefined,
    evaluated: evaluations.length,
    relevant: evaluations.filter((evaluation) => evaluation.decision === "relevant").length,
    notRelevant: evaluations.filter((evaluation) => evaluation.decision === "not-relevant").length,
    review: evaluations.filter((evaluation) => evaluation.decision === "review").length,
    message: extensionMessage("run.reevaluated", { count: evaluations.length }),
  };
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
