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
import { evaluateDetailedRecordsInBatches, mergeRecordEvaluations } from "../intelligence/filterApi";
import {
  createDefaultIntelligenceRecipe,
  createEmptyCriterion,
  normalizeIntelligenceRecipe,
  recipeValidationError,
} from "../intelligence/recipe";
import {
  buildLeboncoinSearchUrl,
  CATEGORY_OPTIONS,
  createDefaultSearchFilters,
  normalizeSearchFilters,
  OWNER_TYPE_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  SORT_OPTIONS,
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
  "collecting-search",
  "collecting-details",
  "evaluating",
  "paused-captcha",
]);
const MAX_RENDERED_RECORDS = 100;

export function DashboardApp() {
  const [filters, setFilters] = useState<SearchFilters>(createDefaultSearchFilters);
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [records, setRecords] = useState<ScrapedPropertyRecord[]>([]);
  const [recipe, setRecipe] = useState<IntelligenceRecipe>(createDefaultIntelligenceRecipe);
  const [recipeDirty, setRecipeDirty] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState<"all" | ListingEvaluation["decision"]>("all");
  const [error, setError] = useState<string>();
  const runnerRef = useRef<ScrapeRunner | undefined>(undefined);
  const reevaluationAbortRef = useRef<AbortController | undefined>(undefined);
  const isRunning = RUNNING_STATUSES.has(run.status);
  const canResume = run.status === "paused-captcha" && runnerRef.current?.paused;
  const visibleRecords = useMemo(
    () => records
      .filter((record) => decisionFilter === "all" || record.evaluation?.decision === decisionFilter)
      .slice(0, MAX_RENDERED_RECORDS),
    [decisionFilter, records],
  );
  const searchUrl = useMemo(() => {
    try {
      return buildLeboncoinSearchUrl(filters);
    } catch {
      return undefined;
    }
  }, [filters]);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.accent = "sea";
    document.documentElement.dataset.density = "compact";
  }, []);

  useEffect(() => {
    let mounted = true;

    void loadCrawlerState()
      .then(async (snapshot) => {
        const recoveredRun = (await isOnlyDashboardContext()) ? reconcileInterruptedRun(snapshot.run) : snapshot.run;
        if (recoveredRun !== snapshot.run) await saveRun(recoveredRun);
        if (!mounted) return;

        setFilters(snapshot.filters);
        setRun(recoveredRun);
        setRecords(snapshot.records);
        setRecipe(snapshot.recipe);
      })
      .catch((caught) => {
        if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
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
    runnerRef.current?.cancel();
    reevaluationAbortRef.current?.abort();
    setError(undefined);

    try {
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
      await runner.run(normalizedFilters, recipeForRun);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      runnerRef.current = undefined;
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
      if (!recipeForRun.enabled) throw new Error("Enable the intelligence recipe before reevaluating.");
      const detailedRecords = records.filter((record) => record.status === "detailed");
      if (detailedRecords.length === 0) throw new Error("No detailed records are available for reevaluation.");

      const reevaluationRunId = `reevaluation-${Date.now()}`;
      const abortController = new AbortController();
      reevaluationAbortRef.current = abortController;
      const evaluatingRun: ScrapeRun = {
        ...run,
        status: "evaluating",
        intelligenceStatus: "evaluating",
        intelligenceError: undefined,
        message: `Reevaluating ${detailedRecords.length} stored listings.`,
      };
      setRun(evaluatingRun);
      await saveCrawlerState({ run: evaluatingRun });

      try {
        const evaluations = await evaluateDetailedRecordsInBatches(
          reevaluationRunId,
          recipeForRun,
          detailedRecords,
          { signal: abortController.signal },
        );
        const nextRecords = mergeRecordEvaluations(records, evaluations);
        const nextRun = runWithEvaluations(evaluatingRun, evaluations);
        setRecords(nextRecords);
        setRun(nextRun);
        await saveCrawlerState({ run: nextRun, records: nextRecords });
      } catch (caught) {
        const nextRun: ScrapeRun = {
          ...evaluatingRun,
          status: "completed",
          intelligenceStatus: "failed",
          intelligenceError: caught instanceof Error ? caught.message : String(caught),
          message: "Stored listings were preserved. Intelligence reevaluation failed.",
        };
        setRun(nextRun);
        await saveCrawlerState({ run: nextRun });
        throw caught;
      } finally {
        reevaluationAbortRef.current = undefined;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleClear() {
    if (!window.confirm("Clear all locally stored crawler records?")) return;
    runnerRef.current?.cancel();
    try {
      await clearRecords();
      setRecords([]);
      setRun(IDLE_RUN);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function openSearchUrl() {
    if (!searchUrl) {
      setError("Search URL is invalid.");
      return;
    }

    try {
      await chrome.tabs.create({ url: searchUrl, active: true });
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
            <h1>Denicheur Breizh Crawler</h1>
            <p>LeBonCoin real-estate PoC</p>
          </div>
        </div>
        <div aria-live="polite">
          <StatusPill run={run} />
        </div>
      </header>

      <main className="dashboard-layout">
        <form className="control-surface" onSubmit={handleStart}>
          <div className="surface-head">
            <div>
              <h2>Search filters</h2>
              <p>{searchUrl ?? "Invalid search URL"}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" iconOnly onClick={openSearchUrl} aria-label="Open search URL">
              <ExternalLink size={15} />
            </Button>
          </div>

          <div className="form-grid">
            <label className="field wide">
              <SectionLabel>Source URL</SectionLabel>
              <input
                className="input"
                type="url"
                name="source-url"
                autoComplete="off"
                value={filters.rawSearchUrl}
                onChange={(event) => patchFilters({ rawSearchUrl: event.target.value })}
                placeholder="https://www.leboncoin.fr/recherche?category=9…"
              />
            </label>

            <label className="field">
              <SectionLabel>Mode</SectionLabel>
              <Select
                name="category"
                value={filters.category}
                onChange={(event) => patchFilters({ category: event.target.value as SearchFilters["category"] })}
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="field">
              <SectionLabel>Keywords</SectionLabel>
              <input
                className="input"
                name="keywords"
                autoComplete="off"
                value={filters.text}
                onChange={(event) => patchFilters({ text: event.target.value })}
                placeholder="maison vue mer…"
              />
            </label>

            <label className="field wide">
              <SectionLabel>Location token</SectionLabel>
              <input
                className="input"
                name="location-token"
                autoComplete="off"
                value={filters.locationToken}
                onChange={(event) => patchFilters({ locationToken: event.target.value })}
                placeholder="Quimper__47.996_-4.102_5000…"
              />
            </label>

            <div className="field wide">
              <SectionLabel>Types</SectionLabel>
              <div className="chip-row">
                {PROPERTY_TYPE_OPTIONS.map((option) => (
                  <Chip
                    key={option.value}
                    active={filters.propertyTypes.includes(option.value)}
                    onClick={() => togglePropertyType(option.value)}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </div>

            <NumberField label="Price min" value={filters.priceMin} onChange={(value) => patchNumericFilter("priceMin", value)} />
            <NumberField label="Price max" value={filters.priceMax} onChange={(value) => patchNumericFilter("priceMax", value)} />
            <NumberField label="Rooms min" value={filters.roomsMin} onChange={(value) => patchNumericFilter("roomsMin", value)} />
            <NumberField label="Rooms max" value={filters.roomsMax} onChange={(value) => patchNumericFilter("roomsMax", value)} />
            <NumberField label="Beds min" value={filters.bedroomsMin} onChange={(value) => patchNumericFilter("bedroomsMin", value)} />
            <NumberField label="Beds max" value={filters.bedroomsMax} onChange={(value) => patchNumericFilter("bedroomsMax", value)} />
            <NumberField label="Surface min" value={filters.squareMin} onChange={(value) => patchNumericFilter("squareMin", value)} />
            <NumberField label="Surface max" value={filters.squareMax} onChange={(value) => patchNumericFilter("squareMax", value)} />

            <label className="field">
              <SectionLabel>Seller</SectionLabel>
              <Select
                name="owner-type"
                value={filters.ownerType}
                onChange={(event) => patchFilters({ ownerType: event.target.value as SearchFilters["ownerType"] })}
              >
                {OWNER_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="field">
              <SectionLabel>Sort</SectionLabel>
              <Select
                name="sort"
                value={filters.sort}
                onChange={(event) => patchFilters({ sort: event.target.value as SearchFilters["sort"] })}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <NumberField label="Max listings" value={filters.maxListings} onChange={(value) => patchNumericFilter("maxListings", value)} />

            <label className="toggle close-toggle">
              <input
                type="checkbox"
                name="collect-detail-pages"
                checked={filters.collectDetailPages}
                onChange={(event) => patchFilters({ collectDetailPages: event.target.checked })}
              />
              <span className="track" />
              <span>Open detail tabs</span>
            </label>

            <NumberField label="Delay min sec" value={filters.minDelaySeconds} onChange={(value) => patchNumericFilter("minDelaySeconds", value)} />
            <NumberField label="Delay max sec" value={filters.maxDelaySeconds} onChange={(value) => patchNumericFilter("maxDelaySeconds", value)} />
            <NumberField label="Pause every" value={filters.pauseAfterDetails} onChange={(value) => patchNumericFilter("pauseAfterDetails", value)} />
            <NumberField label="Cooldown sec" value={filters.cooldownSeconds} onChange={(value) => patchNumericFilter("cooldownSeconds", value)} />

            <label className="toggle close-toggle">
              <input
                type="checkbox"
                name="close-detail-tabs"
                checked={filters.closeDetailTabs}
                onChange={(event) => patchFilters({ closeDetailTabs: event.target.checked })}
              />
              <span className="track" />
              <span>Close detail tabs</span>
            </label>
          </div>

          <section className="intelligence-panel" aria-labelledby="intelligence-title">
            <div className="intelligence-head">
              <div>
                <div className="intelligence-title-row">
                  <Brain size={17} />
                  <h3 id="intelligence-title">Intelligence filter</h3>
                  <Chip tone={recipe.enabled ? "good" : "sea"}>{recipe.enabled ? "enabled" : "disabled"}</Chip>
                </div>
                <p>Structured criteria are evaluated by the local API after detail collection.</p>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  name="intelligence-enabled"
                  checked={recipe.enabled}
                  onChange={(event) => patchRecipe({ enabled: event.target.checked })}
                />
                <span className="track" />
                <span>Enable</span>
              </label>
            </div>

            <div className="recipe-grid">
              <label className="field wide">
                <SectionLabel>Recipe name</SectionLabel>
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
                label="Relevance threshold"
                value={recipe.threshold}
                max={100}
                onChange={(value) => patchRecipe({ threshold: Number(value) })}
              />
              <div className="recipe-version">
                <SectionLabel>Version</SectionLabel>
                <strong>v{recipe.version}{recipeDirty ? " · unsaved" : ""}</strong>
              </div>
            </div>

            <div className="criteria-list">
              {recipe.criteria.length === 0 && (
                <p className="criteria-empty">Add a criterion to describe what makes a listing relevant to you.</p>
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
                      placeholder="Criterion name"
                      aria-label={`Criterion ${index + 1} name`}
                      onChange={(event) => patchCriterion(criterion.id, { name: event.target.value })}
                    />
                    <textarea
                      className="input criterion-description"
                      name={`criterion-description-${criterion.id}`}
                      value={criterion.description}
                      maxLength={2000}
                      placeholder="Explain the evidence that should pass this criterion"
                      aria-label={`Criterion ${index + 1} description`}
                      onChange={(event) => patchCriterion(criterion.id, { description: event.target.value })}
                    />
                    <div className="criterion-options">
                      <label>
                        <span>Weight</span>
                        <input
                          className="input criterion-weight"
                          type="number"
                          min={0}
                          max={100}
                          value={criterion.weight}
                          aria-label={`Criterion ${index + 1} weight`}
                          onChange={(event) => patchCriterion(criterion.id, { weight: Number(event.target.value) })}
                        />
                      </label>
                      <label className="criterion-required">
                        <input
                          type="checkbox"
                          checked={criterion.required}
                          onChange={(event) => patchCriterion(criterion.id, { required: event.target.checked })}
                        />
                        Required evidence
                      </label>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove criterion ${index + 1}`}
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
                Add criterion
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={handleSaveRecipe} disabled={!recipeDirty}>
                <Save size={14} />
                Save recipe
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleReevaluate}
                disabled={isRunning || !recipe.enabled || records.every((record) => record.status !== "detailed")}
              >
                <RefreshCw size={14} />
                Reevaluate stored
              </Button>
            </div>
            {recipe.enabled && <p className="intelligence-note">Detail collection will be enabled automatically.</p>}
          </section>

          <div className="guardrail-panel">
            <AlertTriangle size={16} />
            <span>
              Slow mode is the default. If LeBonCoin shows unusual activity, the run stops and the active tab is left for manual review.
            </span>
          </div>

          {error && (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          <div className="action-row">
            <Button type="submit" variant="primary" disabled={isRunning}>
              {isRunning ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              Start crawl
            </Button>
            <Button type="button" variant="default" onClick={handleResume} disabled={!canResume}>
              <RefreshCw size={16} />
              Resume
            </Button>
            <Button type="button" variant="ghost" onClick={handleCancel} disabled={!isRunning}>
              <Square size={16} />
              Cancel
            </Button>
          </div>
        </form>

        <section className="results-surface">
          <div className="metrics-grid">
            <Metric label="Found" value={run.found} />
            <Metric label={filters.collectDetailPages ? "Detailed" : "Collected"} value={run.collected} />
            <Metric label="Evaluated" value={run.evaluated} />
            <Metric label="Relevant" value={run.relevant} />
            <Metric label="Not relevant" value={run.notRelevant} />
            <Metric label="Review" value={run.review} />
            <Metric label="Stored" value={records.length} />
          </div>

          {run.intelligenceStatus === "failed" && (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} />
              <span>{run.intelligenceError ?? "Intelligence evaluation failed. Your scraped records were preserved."}</span>
            </div>
          )}

          <div className="results-head">
            <div>
              <h2>Records</h2>
              <p>{run.message ?? "Local extension storage"}</p>
            </div>
            <div className="results-actions">
              <Select
                aria-label="Filter records by intelligence decision"
                value={decisionFilter}
                onChange={(event) => setDecisionFilter(event.target.value as typeof decisionFilter)}
              >
                <option value="all">All decisions</option>
                <option value="relevant">Relevant</option>
                <option value="not-relevant">Not relevant</option>
                <option value="review">Review</option>
              </Select>
              <Button type="button" size="sm" variant="danger" onClick={handleClear} disabled={records.length === 0 || isRunning}>
                <Trash2 size={15} />
                Clear
              </Button>
            </div>
          </div>

          {visibleRecords.length === 0 ? (
            <EmptyState>
              <div className="empty-copy">
                <Database size={24} />
                <span>{records.length === 0 ? "No records yet" : "No records match this decision"}</span>
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
              Showing {visibleRecords.length} matching records from {records.length} stored records.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

async function isOnlyDashboardContext(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
      documentUrls: [chrome.runtime.getURL("dashboard.html")],
    });
    return contexts.length <= 1;
  } catch {
    return false;
  }
}

interface NumberFieldProps {
  label: string;
  value?: number;
  max?: number;
  onChange: (value: string) => void;
}

function NumberField({ label, value, max, onChange }: NumberFieldProps) {
  return (
    <label className="field">
      <SectionLabel>{label}</SectionLabel>
      <input
        className="input"
        type="number"
        name={label.toLowerCase().replace(/\s+/g, "-")}
        autoComplete="off"
        inputMode="numeric"
        min={0}
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
  const tone =
    run.status === "completed"
      ? "good"
      : run.status === "failed" || run.status === "blocked-activity"
        ? "danger"
        : run.status === "paused-captcha"
          ? "sunset"
          : "sea";

  return (
    <Chip tone={tone}>
      <span className="status-dot" />
      {run.status}
    </Chip>
  );
}

interface MetricProps {
  label: string;
  value: number;
}

function Metric({ label, value }: MetricProps) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

interface PropertyRecordCardProps {
  record: ScrapedPropertyRecord;
}

function PropertyRecordCard({ record }: PropertyRecordCardProps) {
  return (
    <article className="record-card">
      <div className="record-main">
        {record.imageUrl ? (
          <img
            src={record.imageUrl}
            alt=""
            width={96}
            height={72}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="image-fallback">
            <Search size={22} />
          </div>
        )}
        <div>
          <div className="record-title-row">
            <h3>{record.title}</h3>
            <a className="btn sm icon" href={record.listingUrl} target="_blank" rel="noreferrer" aria-label="Open listing">
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="record-price">{record.priceText ?? "No price"}</div>
          <div className="record-location">{record.location ?? "Location pending"}</div>
        </div>
      </div>

      <div className="record-facts">
        <Fact label="Type" value={record.propertyType} />
        <Fact label="Rooms" value={formatNumber(record.rooms)} />
        <Fact label="Beds" value={formatNumber(record.bedrooms)} />
        <Fact label="Surface" value={record.surfaceM2 ? `${record.surfaceM2} m²` : undefined} />
        <Fact label="DPE" value={record.energyClass} />
        <Fact label="GES" value={record.gesClass} />
      </div>

      {record.description && <p className="record-description">{record.description}</p>}

      {record.evaluation && <EvaluationSummary evaluation={record.evaluation} />}

      <div className="record-footer">
        <Chip tone={record.status === "failed" ? "danger" : record.status === "detailed" ? "good" : "sea"}>
          {record.status}
        </Chip>
        {record.features.slice(0, 4).map((feature) => (
          <Chip key={feature}>{feature}</Chip>
        ))}
        {record.error && <span className="record-error">{record.error}</span>}
      </div>
    </article>
  );
}

interface FactProps {
  label: string;
  value?: string;
}

function Fact({ label, value }: FactProps) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

interface EvaluationSummaryProps {
  evaluation: ListingEvaluation;
}

function EvaluationSummary({ evaluation }: EvaluationSummaryProps) {
  const tone = evaluation.decision === "relevant" ? "good" : evaluation.decision === "review" ? "sunset" : "danger";
  return (
    <section className="evaluation-summary" aria-label="Intelligence evaluation">
      <div className="evaluation-head">
        <Chip tone={tone}>{evaluation.decision}</Chip>
        <strong>{evaluation.score === null ? "No score" : `${Math.round(evaluation.score)} / 100`}</strong>
      </div>
      <p>{evaluation.summary}</p>
      <details>
        <summary>Evidence by criterion</summary>
        <div className="evaluation-criteria">
          {evaluation.criteria.map((criterion) => (
            <div key={criterion.criterionId} className={`criterion-result ${criterion.verdict}`}>
              <strong>{criterion.verdict}</strong>
              <span>{criterion.reason}</span>
              {criterion.evidence.length > 0 && <small>{criterion.evidence.join(" · ")}</small>}
            </div>
          ))}
        </div>
      </details>
      {evaluation.missingData.length > 0 && (
        <small className="missing-data">Missing: {evaluation.missingData.join(", ")}</small>
      )}
      <small className="evaluation-meta">
        Recipe v{evaluation.recipeVersion} · {evaluation.evaluator.model} · {new Date(evaluation.evaluatedAt).toLocaleString()}
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
    message: `Reevaluated ${evaluations.length} stored listings.`,
  };
}

function formatNumber(value?: number): string | undefined {
  return value === undefined ? undefined : String(value);
}
