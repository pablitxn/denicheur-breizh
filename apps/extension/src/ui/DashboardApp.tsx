import {
  AlertTriangle,
  Database,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, EmptyState, SectionLabel, Select } from "@denicheur-breizh/design-system";
import { ScrapeRunner } from "../automation/scrapeRunner";
import {
  buildLeboncoinSearchUrl,
  CATEGORY_OPTIONS,
  createDefaultSearchFilters,
  normalizeSearchFilters,
  OWNER_TYPE_OPTIONS,
  PROPERTY_TYPE_OPTIONS,
  SORT_OPTIONS,
} from "../lib/leboncoinSearch";
import type { ScrapeRun, ScrapedPropertyRecord, SearchFilters } from "../lib/types";
import {
  clearRecords,
  IDLE_RUN,
  isCrawlerStorageKey,
  loadCrawlerState,
  reconcileInterruptedRun,
  saveFilters,
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
  "paused-captcha",
]);
const MAX_RENDERED_RECORDS = 100;

export function DashboardApp() {
  const [filters, setFilters] = useState<SearchFilters>(createDefaultSearchFilters);
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [records, setRecords] = useState<ScrapedPropertyRecord[]>([]);
  const [error, setError] = useState<string>();
  const runnerRef = useRef<ScrapeRunner | undefined>(undefined);
  const isRunning = RUNNING_STATUSES.has(run.status);
  const canResume = run.status === "paused-captcha" && runnerRef.current?.paused;
  const visibleRecords = records.slice(0, MAX_RENDERED_RECORDS);
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

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runnerRef.current?.cancel();
    setError(undefined);

    const normalizedFilters = normalizeSearchFilters(filters);

    try {
      await saveFilters(normalizedFilters);
      setFilters(normalizedFilters);
      const runner = new ScrapeRunner((snapshot) => {
        setRun(snapshot.run);
        setRecords(snapshot.records);
      });
      runnerRef.current = runner;
      await runner.run(normalizedFilters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      runnerRef.current = undefined;
    }
  }

  function handleCancel() {
    runnerRef.current?.cancel();
  }

  function handleResume() {
    runnerRef.current?.resume();
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
            <Metric label="Target" value={run.target} />
            <Metric label="Stored" value={records.length} />
          </div>

          <div className="results-head">
            <div>
              <h2>Records</h2>
              <p>{run.message ?? "Local extension storage"}</p>
            </div>
            <Button type="button" size="sm" variant="danger" onClick={handleClear} disabled={records.length === 0}>
              <Trash2 size={15} />
              Clear
            </Button>
          </div>

          {records.length === 0 ? (
            <EmptyState>
              <div className="empty-copy">
                <Database size={24} />
                <span>No records yet</span>
              </div>
            </EmptyState>
          ) : (
            <div className="records-grid">
              {visibleRecords.map((record) => (
                <PropertyRecordCard key={record.listingUrl} record={record} />
              ))}
            </div>
          )}
          {records.length > visibleRecords.length && (
            <p className="records-limit">Showing the newest {visibleRecords.length} of {records.length} stored records.</p>
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

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: number;
  onChange: (value: string) => void;
}) {
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
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function StatusPill({ run }: { run: ScrapeRun }) {
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PropertyRecordCard({ record }: { record: ScrapedPropertyRecord }) {
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

function Fact({ label, value }: { label: string; value?: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value ?? "-"}</strong>
    </div>
  );
}

function formatNumber(value?: number): string | undefined {
  return value === undefined ? undefined : String(value);
}
