import {
  AlertTriangle,
  Brain,
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
  normalizeIntelligenceRecipe,
  recipeValidationError,
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
  IDLE_RUN,
  isCrawlerStorageKey,
  loadCrawlerState,
  reconcileInterruptedRun,
  saveCrawlerState,
  saveFilters,
  saveRecipe,
  saveRun,
} from "../storage/chromeStorage";

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
const MAX_RENDERED_RECORDS = 100;
const DASHBOARD_RUNNER_LOCK_NAME = "denicheur:crawler:dashboard-runner";

interface DashboardRunnerLockManager {
  query(): Promise<LockManagerSnapshot>;
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T>;
}

export function DashboardApp() {
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
  const [recipeDirty, setRecipeDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState<"all" | ListingEvaluation["decision"]>("all");
  const [error, setError] = useState<unknown>();
  const runnerRef = useRef<ScrapeRunner | undefined>(undefined);
  const startPendingRef = useRef(false);
  const reevaluationAbortRef = useRef<AbortController | undefined>(undefined);
  const isRunning = RUNNING_STATUSES.has(run.status);
  const isRunActive = isRunning || run.status === "paused-captcha";
  const canControlActiveRun = Boolean(runnerRef.current || reevaluationAbortRef.current);
  const requiresReset = run.status === "blocked-captcha" || run.status === "blocked-activity";
  const filterIssues = useMemo(() => validateSearchFilters(filters), [filters]);
  const visibleRecords = useMemo(
    () => records
      .filter((record) => decisionFilter === "all" || record.evaluation?.decision === decisionFilter)
      .slice(0, MAX_RENDERED_RECORDS),
    [decisionFilter, records],
  );
  useEffect(() => {
    let mounted = true;

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
        setHydrated(true);
      })
      .catch((caught) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setHydrated(true);
        }
      });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !Object.keys(changes).some(isCrawlerStorageKey)) {
        return;
      }

      void loadCrawlerState()
        .then((snapshot) => {
          if (!mounted) return;
          setFilters(snapshot.filters);
          setRun(snapshot.run);
          setRecords(snapshot.records);
          setRecipe(snapshot.recipe);
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
  }, []);

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

  function patchFilters(patch: Partial<SearchFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
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
  }

  function patchRecipe(patch: Partial<IntelligenceRecipe>) {
    setRecipe((current) => ({ ...current, ...patch }));
    setRecipeDirty(true);
  }

  function patchCriterion(id: string, patch: Partial<IntelligenceCriterion>) {
    setRecipe((current) => ({
      ...current,
      criteria: current.criteria.map((criterion) =>
        criterion.id === id ? { ...criterion, ...patch } : criterion,
      ),
    }));
    setRecipeDirty(true);
  }

  function addCriterion() {
    setRecipe((current) => ({ ...current, criteria: [...current.criteria, createEmptyCriterion()] }));
    setRecipeDirty(true);
  }

  function removeCriterion(id: string) {
    setRecipe((current) => ({
      ...current,
      criteria: current.criteria.filter((criterion) => criterion.id !== id),
    }));
    setRecipeDirty(true);
  }

  async function persistRecipeForUse(): Promise<IntelligenceRecipe> {
    const versionedRecipe = recipeDirty ? { ...recipe, version: recipe.version + 1 } : recipe;
    const validationError = recipeValidationError(versionedRecipe);
    if (validationError) throw new Error(validationError);
    const nextRecipe = normalizeIntelligenceRecipe(versionedRecipe);
    await saveRecipe(nextRecipe);
    setRecipe(nextRecipe);
    setRecipeDirty(false);
    return nextRecipe;
  }

  async function handleSaveRecipe() {
    setError(undefined);
    try {
      await persistRecipeForUse();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || startPendingRef.current || isRunActive) return;
    if (requiresReset) {
      setError(extensionMessage("validation.manualReset"));
      return;
    }
    if (filterIssues.length > 0) {
      setError(extensionMessage("validation.fixFilters"));
      return;
    }
    startPendingRef.current = true;
    runnerRef.current?.cancel();
    reevaluationAbortRef.current?.abort();
    setError(undefined);

    try {
      await withDashboardRunnerLease(async () => {
        const recipeForRun = await persistRecipeForUse();
        const normalizedFilters = normalizeSearchFilters({
          ...filters,
          collectDetailPages: recipeForRun.enabled ? true : filters.collectDetailPages,
        });
        await saveFilters(normalizedFilters);
        setFilters(normalizedFilters);
        const runner = new ScrapeRunner((snapshot) => {
          setRun(snapshot.run);
          setRecords(snapshot.records);
        });
        runnerRef.current = runner;
        await runner.run(normalizedFilters, recipeForRun, locale);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      runnerRef.current = undefined;
      startPendingRef.current = false;
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
    setError(undefined);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <div className="extension-page">
      <header className="extension-topbar">
        <div className="extension-brand">
          <span className="extension-mark">DB</span>
          <div>
            <h1>{t("app.dashboardTitle")}</h1>
            <p>{t("app.dashboardSubtitle")}</p>
          </div>
        </div>
        <div className="extension-toolbar-actions">
          <LocaleSelector />
          <div aria-live="polite">
            <StatusPill run={run} />
          </div>
        </div>
      </header>

      <main className="dashboard-layout">
        <form className="control-surface" onSubmit={handleStart}>
          <div className="surface-head">
            <div>
              <h2>{t("search.title")}</h2>
              <p>{t("search.description")}</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field">
              <SectionLabel>{t("search.mode")}</SectionLabel>
              <Select
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
              <SectionLabel>{t("search.types")}</SectionLabel>
              <div className="chip-row">
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

            <NumberField label={t("search.priceMin")} name="price-min" value={filters.priceMin} onChange={(value) => patchNumericFilter("priceMin", value)} />
            <NumberField label={t("search.priceMax")} name="price-max" value={filters.priceMax} onChange={(value) => patchNumericFilter("priceMax", value)} />
            <NumberField label={t("search.roomsMin")} name="rooms-min" value={filters.roomsMin} onChange={(value) => patchNumericFilter("roomsMin", value)} />
            <NumberField label={t("search.roomsMax")} name="rooms-max" value={filters.roomsMax} onChange={(value) => patchNumericFilter("roomsMax", value)} />
            <NumberField label={t("search.bedsMin")} name="beds-min" value={filters.bedroomsMin} onChange={(value) => patchNumericFilter("bedroomsMin", value)} />
            <NumberField label={t("search.bedsMax")} name="beds-max" value={filters.bedroomsMax} onChange={(value) => patchNumericFilter("bedroomsMax", value)} />
            <NumberField label={t("search.surfaceMin")} name="surface-min" value={filters.squareMin} onChange={(value) => patchNumericFilter("squareMin", value)} />
            <NumberField label={t("search.surfaceMax")} name="surface-max" value={filters.squareMax} onChange={(value) => patchNumericFilter("squareMax", value)} />

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

            <NumberField
              label={t("search.maxListings")}
              name="max-listings"
              value={filters.maxListings}
              min={1}
              max={MAX_LISTINGS_LIMIT}
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

            <NumberField label={t("search.delayMin")} name="delay-min-seconds" value={filters.minDelaySeconds} onChange={(value) => patchNumericFilter("minDelaySeconds", value)} />
            <NumberField label={t("search.delayMax")} name="delay-max-seconds" value={filters.maxDelaySeconds} onChange={(value) => patchNumericFilter("maxDelaySeconds", value)} />
            <NumberField label={t("search.pauseEvery")} name="pause-every" value={filters.pauseAfterDetails} onChange={(value) => patchNumericFilter("pauseAfterDetails", value)} />
            <NumberField label={t("search.cooldown")} name="cooldown-seconds" value={filters.cooldownSeconds} onChange={(value) => patchNumericFilter("cooldownSeconds", value)} />

          </div>

          <section className="intelligence-panel" aria-labelledby="intelligence-title">
            <div className="intelligence-head">
              <div>
                <div className="intelligence-title-row">
                  <Brain size={17} />
                  <h3 id="intelligence-title">{t("intelligence.title")}</h3>
                  <Chip tone={recipe.enabled ? "good" : "sea"}>
                    {recipe.enabled ? t("intelligence.enabled") : t("intelligence.disabled")}
                  </Chip>
                </div>
                <p>{t("intelligence.description")}</p>
              </div>
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
                  className="input"
                  name="recipe-name"
                  autoComplete="off"
                  maxLength={160}
                  value={recipe.name}
                  onChange={(event) => patchRecipe({ name: event.target.value })}
                />
              </label>
              <NumberField
                label={t("intelligence.threshold")}
                name="relevance-threshold"
                value={recipe.threshold}
                max={100}
                onChange={(value) => patchRecipe({ threshold: Number(value) })}
              />
              <div className="recipe-version">
                <SectionLabel>{t("intelligence.version")}</SectionLabel>
                <strong>
                  v{formatNumber(recipe.version)}
                  {recipeDirty ? ` · ${t("intelligence.unsaved")}` : ""}
                </strong>
              </div>
            </div>

            <div className="criteria-list">
              {recipe.criteria.length === 0 && (
                <p className="criteria-empty">{t("intelligence.emptyCriteria")}</p>
              )}
              {recipe.criteria.map((criterion, index) => (
                <article className="criterion-row" key={criterion.id}>
                  <div className="criterion-index">{index + 1}</div>
                  <div className="criterion-fields">
                    <input
                      className="input"
                      name={`criterion-name-${criterion.id}`}
                      autoComplete="off"
                      maxLength={160}
                      value={criterion.name}
                      placeholder={t("intelligence.criterionName")}
                      aria-label={t("intelligence.criterionNameAria", { index: index + 1 })}
                      onChange={(event) => patchCriterion(criterion.id, { name: event.target.value })}
                    />
                    <textarea
                      className="input criterion-description"
                      name={`criterion-description-${criterion.id}`}
                      value={criterion.description}
                      maxLength={2000}
                      placeholder={t("intelligence.criterionDescription")}
                      aria-label={t("intelligence.criterionDescriptionAria", { index: index + 1 })}
                      onChange={(event) => patchCriterion(criterion.id, { description: event.target.value })}
                    />
                    <div className="criterion-options">
                      <label>
                        <span>{t("intelligence.weight")}</span>
                        <input
                          className="input criterion-weight"
                          type="number"
                          min={0}
                          max={100}
                          value={criterion.weight}
                          aria-label={t("intelligence.weightAria", { index: index + 1 })}
                          onChange={(event) => patchCriterion(criterion.id, { weight: Number(event.target.value) })}
                        />
                      </label>
                      <label className="criterion-required">
                        <input
                          type="checkbox"
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
              <Button type="button" size="sm" onClick={addCriterion} disabled={recipe.criteria.length >= 12}>
                <Plus size={14} />
                {t("intelligence.addCriterion")}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={handleSaveRecipe} disabled={!recipeDirty}>
                <Save size={14} />
                {t("intelligence.saveRecipe")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleReevaluate}
                disabled={isRunActive || !recipe.enabled || records.every((record) => record.status !== "detailed")}
              >
                <RefreshCw size={14} />
                {t("intelligence.reevaluate")}
              </Button>
            </div>
            {recipe.enabled && <p className="intelligence-note">{t("intelligence.autoDetails")}</p>}
          </section>

          <div className="guardrail-panel">
            <AlertTriangle size={16} />
            <span>
              {t("guardrail.notice")}
            </span>
          </div>

          {filterIssues.length > 0 && (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} />
              <span>
                {filterIssues
                  .map((issue) => translateFilterValidationIssue(issue, filters, t))
                  .join(" ")}
              </span>
            </div>
          )}

          {run.filterWarnings.length > 0 && (
            <div className="inline-alert" role="status">
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
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} />
              <LocalizedMessageView value={error} />
            </div>
          )}

          <div className="action-row">
            <Button
              type="submit"
              variant="primary"
              disabled={!hydrated || isRunActive || requiresReset || filterIssues.length > 0}
            >
              {isRunning ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              {t("action.start")}
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
          </div>
        </form>

        <section className="results-surface">
          <div className="metrics-grid">
            <Metric label={t("metric.found")} value={run.found} />
            <Metric label={t("metric.pages")} value={run.pagesVisited} />
            <Metric label={filters.collectDetailPages ? t("metric.detailed") : t("metric.collected")} value={run.collected} />
            <Metric label={t("metric.evaluated")} value={run.evaluated} />
            <Metric label={t("metric.relevant")} value={run.relevant} />
            <Metric label={t("metric.notRelevant")} value={run.notRelevant} />
            <Metric label={t("metric.review")} value={run.review} />
            <Metric label={t("metric.stored")} value={records.length} />
          </div>

          {run.error && (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} />
              <LocalizedMessageView value={run.error} />
            </div>
          )}

          {run.intelligenceStatus === "failed" && (
            <div className="inline-alert" role="alert">
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
              <p><LocalizedMessageView value={run.message} fallbackId="results.localStorage" /></p>
            </div>
            <div className="results-actions">
              <Select
                aria-label={t("results.filterAria")}
                value={decisionFilter}
                onChange={(event) => setDecisionFilter(event.target.value as typeof decisionFilter)}
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
              </div>
            </EmptyState>
          ) : (
            <div className="records-grid">
              {visibleRecords.map((record) => (
                <PropertyRecordCard key={record.listingUrl} record={record} />
              ))}
            </div>
          )}
          {(records.length > visibleRecords.length || decisionFilter !== "all") && (
            <p className="records-limit">
              {t("results.showing", {
                visible: formatNumber(visibleRecords.length),
                total: formatNumber(records.length),
              })}
            </p>
          )}
        </section>
      </main>
    </div>
  );
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
  value?: number;
  min?: number;
  max?: number;
  onChange: (value: string) => void;
}

function NumberField({ label, name, value, min = 0, max, onChange }: NumberFieldProps) {
  return (
    <label className="field">
      <SectionLabel>{label}</SectionLabel>
      <input
        className="input"
        type="number"
        name={name}
        autoComplete="off"
        inputMode="numeric"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
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
    <article className="record-card">
      <div className="record-main">
        <div
          className="image-fallback"
          title={imageCount > 0
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
        <Fact label={t("record.surface")} value={record.surfaceM2 === undefined ? undefined : `${formatNumber(record.surfaceM2)} m²`} />
        <Fact label="DPE" value={record.energyClass} />
        <Fact label="GES" value={record.gesClass} />
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
      <small className="evaluation-meta">
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
