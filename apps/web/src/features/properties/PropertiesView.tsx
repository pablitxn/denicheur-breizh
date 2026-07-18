import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Grid2X2, List } from "lucide-react";
import { Button, Chip, EmptyState, Meter, SectionLabel } from "@denicheur-breizh/design-system";
import { useListing, useListings } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { useAppIntl } from "../../intl/IntlContext";
import type { LocaleCode } from "../../intl/locales";
import type { ListingDecision, PropertyListing } from "../../types";
import { formatDecimal, formatInteger, formatPrice, formatRooms } from "../../utils/format";
import { enumUrlCodec, stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import { useMediaQuery } from "../shared/useMediaQuery";
import styles from "./PropertiesView.module.css";

type ViewMode = "table" | "cards";
type SortKey = "title" | "price" | "surface" | "score" | "source" | "updated";

const sortKeys = ["title", "price", "surface", "score", "source", "updated"] as const;
const emptyListings: PropertyListing[] = [];

export function PropertiesView() {
  const { locale, t } = useAppIntl();
  const isMobile = useMediaQuery("(max-width: 760px)");
  const shouldScrollToDetail = useMediaQuery("(max-width: 1120px)");
  const detailRef = useRef<HTMLElement | null>(null);
  const [viewMode, setViewMode] = useUrlState<ViewMode>("pmode", isMobile ? "cards" : "table", enumUrlCodec(["table", "cards"] as const));
  const [sortKey, setSortKey] = useUrlState<SortKey>("psort", "updated", enumUrlCodec(sortKeys));
  const [sortDirection, setSortDirection] = useUrlState<"asc" | "desc">("pdir", "desc", enumUrlCodec(["asc", "desc"] as const));
  const [selectedKey, setSelectedKey] = useUrlState("pid", "", stringUrlCodec);
  const [activeSources, setActiveSources] = useState<string[]>([]);
  const listingsQuery = useListings({ limit: 100 });
  const listings = listingsQuery.data?.items ?? emptyListings;
  const sources = useMemo(() => Array.from(new Set(listings.map((listing) => listing.source))).sort(), [listings]);

  useEffect(() => {
    setActiveSources((current) => {
      const next = current.filter((source) => sources.includes(source));
      return next.length === current.length && next.every((source, index) => source === current[index]) ? current : next;
    });
  }, [sources]);

  const sortedListings = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    return listings
      .filter((listing) => activeSources.length === 0 || activeSources.includes(listing.source))
      .sort((left, right) => compareListings(left, right, sortKey, locale) * direction);
  }, [activeSources, listings, locale, sortDirection, sortKey]);

  const selectedSummary = sortedListings.find((listing) => listing.key === selectedKey) ?? sortedListings[0];
  const detailQuery = useListing(selectedSummary?.source, selectedSummary?.externalId);
  const selected = detailQuery.data ?? selectedSummary;

  useEffect(() => {
    if (selectedSummary && selectedSummary.key !== selectedKey) setSelectedKey(selectedSummary.key);
  }, [selectedKey, selectedSummary, setSelectedKey]);

  const selectListing = (key: string) => {
    setSelectedKey(key);
    if (shouldScrollToDetail) {
      window.requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        detailRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      });
    }
  };

  const sortBy = (next: SortKey) => {
    if (next === sortKey) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortKey(next);
      setSortDirection(next === "title" || next === "source" ? "asc" : "desc");
    }
  };

  const toggleSource = (source: string) => {
    setActiveSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source]);
  };

  return (
    <section className={styles.view} aria-labelledby="properties-view-title">
      <header className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <h1 id="properties-view-title">{t("properties.title")}</h1>
          <span aria-live="polite">{t("properties.count", { count: sortedListings.length })}</span>
        </div>
        <div className={styles.providerFilters} role="group" aria-label={t("properties.filters")}>
          {sources.map((source) => (
            <Chip key={source} active={activeSources.length === 0 || activeSources.includes(source)} onClick={() => toggleSource(source)}>
              {source}
            </Chip>
          ))}
        </div>
        <div className={styles.toolbarRight} role="group" aria-label={t("properties.viewModes")}>
          <Button size="sm" variant={viewMode === "table" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("table")} aria-label={t("properties.table")} aria-pressed={viewMode === "table"}>
            <List size={14} aria-hidden="true" />
          </Button>
          <Button size="sm" variant={viewMode === "cards" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("cards")} aria-label={t("properties.cards")} aria-pressed={viewMode === "cards"}>
            <Grid2X2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.results}>
          {listingsQuery.error && <LoadState kind="error" onRetry={() => void listingsQuery.refetch()} />}
          {!listingsQuery.error && listingsQuery.isLoading && <EmptyState role="status">{t("properties.loading")}</EmptyState>}
          {!listingsQuery.error && !listingsQuery.isLoading && sortedListings.length === 0 && <EmptyState>{t("properties.empty")}</EmptyState>}
          {!listingsQuery.error && sortedListings.length > 0 && viewMode === "table" && (
            <ListingTable
              listings={sortedListings}
              selectedKey={selected?.key}
              locale={locale}
              sortKey={sortKey}
              sortDirection={sortDirection}
              onSort={sortBy}
              onSelect={selectListing}
            />
          )}
          {!listingsQuery.error && sortedListings.length > 0 && viewMode === "cards" && (
            <div className={styles.cardGrid}>
              {sortedListings.map((listing) => (
                <button
                  key={listing.key}
                  type="button"
                  className={[styles.propertyCard, listing.key === selected?.key ? styles.propertyCardActive : ""].join(" ")}
                  onClick={() => selectListing(listing.key)}
                  aria-pressed={listing.key === selected?.key}
                >
                  <div className={styles.visualWrap}>
                    <PropertyVisual property={listing} />
                    <span className={styles.cardProvider}>{listing.source}</span>
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>
                      <strong>{display(listing.title, t("common.unavailable"))}</strong>
                      <span>{formatOptionalPrice(listing.priceEuros, locale, t("common.unavailable"))}</span>
                    </div>
                    <p>{listing.location ?? t("common.unavailable")} · {formatOptionalSurface(listing.surfaceM2, locale, t("common.unavailable"))}</p>
                    <DecisionSummary evaluation={listing.evaluation} locale={locale} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        {selected && <ListingDetail detailRef={detailRef} listing={selected} loading={detailQuery.isFetching} />}
      </div>
    </section>
  );
}

function LoadState({ kind, onRetry }: { kind: "error"; onRetry: () => void }) {
  const { t } = useAppIntl();
  return (
    <EmptyState role="alert" data-kind={kind}>
      <div className={styles.stateContent}>
        <strong>{t("properties.error")}</strong>
        <Button onClick={onRetry}>{t("common.retry")}</Button>
      </div>
    </EmptyState>
  );
}

interface ListingTableProps {
  listings: PropertyListing[];
  selectedKey?: string;
  locale: LocaleCode;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onSelect: (key: string) => void;
}

function ListingTable({ listings, selectedKey, locale, sortKey, sortDirection, onSort, onSelect }: ListingTableProps) {
  const { t } = useAppIntl();
  const headers: Array<{ key: SortKey; label: string; align?: "left" | "right" }> = [
    { key: "title", label: t("properties.column.title") },
    { key: "price", label: t("properties.column.price"), align: "right" },
    { key: "surface", label: t("properties.column.surface"), align: "right" },
    { key: "score", label: t("properties.column.evaluation"), align: "right" },
    { key: "source", label: t("properties.column.provider") },
    { key: "updated", label: t("properties.column.updated") },
  ];

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} aria-label={t("properties.table")}>
        <thead><tr>{headers.map((header) => (
          <th key={header.key} style={{ textAlign: header.align ?? "left" }} aria-sort={sortKey === header.key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
            <button type="button" onClick={() => onSort(header.key)}>
              <span>{header.label}</span>
              {sortKey === header.key && (sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
            </button>
          </th>
        ))}</tr></thead>
        <tbody>{listings.map((listing) => (
          <tr key={listing.key} className={listing.key === selectedKey ? styles.selectedRow : ""}>
            <td>
              <button type="button" className={styles.titleCell} onClick={() => onSelect(listing.key)} aria-pressed={listing.key === selectedKey}>
                <PropertyVisual property={listing} size="sm" />
                <div><strong>{listing.title ?? t("common.unavailable")}</strong><span>{listing.externalId} · {listing.location ?? t("common.unavailable")}</span></div>
              </button>
            </td>
            <td className={styles.numeric}>{formatOptionalPrice(listing.priceEuros, locale, t("common.unavailable"))}</td>
            <td className={styles.numeric}>{formatOptionalSurface(listing.surfaceM2, locale, t("common.unavailable"))}</td>
            <td className={styles.numeric}>{formatEvaluationScore(listing.evaluation?.score, locale, t("common.unavailable"))}</td>
            <td><Chip>{listing.source}</Chip></td>
            <td>{formatOptionalDate(listing.scrapedAt, locale, t("common.unavailable"))}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ListingDetail({ listing, loading, detailRef }: { listing: PropertyListing; loading: boolean; detailRef: RefObject<HTMLElement | null> }) {
  const { locale, t } = useAppIntl();
  const evaluation = listing.evaluation;
  return (
    <aside ref={detailRef} className={styles.detail} aria-busy={loading}>
      <PropertyVisual property={listing} size="lg" />
      <div className={styles.detailBody}>
        <div className={styles.detailHeader}>
          <div>
            <strong>{formatOptionalPrice(listing.priceEuros, locale, t("common.unavailable"))}</strong>
            <h2>{listing.title ?? t("common.unavailable")}</h2>
            <p>{listing.location ?? t("common.unavailable")}</p>
          </div>
          <Chip>{listing.source}</Chip>
        </div>
        <div className={styles.detailFacts}>
          <span>{formatOptionalSurface(listing.surfaceM2, locale, t("common.unavailable"))}</span>
          <span>{listing.rooms === undefined ? t("common.unavailable") : formatRooms(listing.rooms, locale)}</span>
          <span>{t("property.dpe")} {listing.energyClass ?? t("common.unavailable")}</span>
          <span>{t("properties.ges")} {listing.gesClass ?? t("common.unavailable")}</span>
        </div>
        <a className={styles.sourceLink} href={listing.url} target="_blank" rel="noreferrer noopener">
          {t("properties.openSource")} <ExternalLink size={14} aria-hidden="true" />
        </a>

        <section className={styles.detailSection}>
          <SectionLabel>{t("properties.description")}</SectionLabel>
          <p className={styles.description}>{listing.description ?? t("common.unavailable")}</p>
        </section>

        <section className={styles.detailSection}>
          <SectionLabel>{t("properties.capture")}</SectionLabel>
          <dl className={styles.definitionList}>
            <div><dt>{t("properties.externalId")}</dt><dd>{listing.externalId}</dd></div>
            <div><dt>{t("properties.run")}</dt><dd>{listing.latestRun?.id ?? listing.runs[0]?.id ?? t("common.unavailable")}</dd></div>
            <div><dt>{t("common.status")}</dt><dd>{listing.status ?? t("common.unavailable")}</dd></div>
            <div><dt>{t("properties.seller")}</dt><dd>{listing.sellerName ?? listing.sellerType ?? t("common.unavailable")}</dd></div>
            {listing.coordinates && (
              <>
                <div><dt>{t("map.positionTitle")}</dt><dd>{t(`map.locationKind.${listing.coordinates.locationKind}`)}</dd></div>
                <div><dt>{t("map.coordinateProvenance")}</dt><dd>{listing.coordinates.provenance}</dd></div>
                <div><dt>{t("map.coordinateObservedAt")}</dt><dd>{formatOptionalDate(listing.coordinates.verifiedAt, locale, t("common.unavailable"))}</dd></div>
              </>
            )}
          </dl>
        </section>

        <section className={styles.detailSection}>
          <SectionLabel>{t("properties.evaluation")}</SectionLabel>
          {evaluation ? (
            <>
              <DecisionSummary evaluation={evaluation} locale={locale} />
              <p className={styles.description}>{evaluation.summary}</p>
              <div className={styles.breakdown}>
                {evaluation.criteria.map((criterion) => (
                  <article key={criterion.criterionId} className={styles.criterionRow}>
                    <div><strong>{criterion.criterionId}</strong><DecisionChip decision={criterion.verdict} /></div>
                    <p>{criterion.reason}</p>
                    {criterion.evidence.length > 0 && <ul>{criterion.evidence.map((item) => <li key={item}>{item}</li>)}</ul>}
                  </article>
                ))}
              </div>
              {evaluation.missingData.length > 0 && <p className={styles.missingData}>{t("properties.missingData")}: {evaluation.missingData.join(", ")}</p>}
            </>
          ) : <p>{t("properties.notEvaluated")}</p>}
        </section>

        {listing.features.length > 0 && <div className={styles.featureList}>{listing.features.map((feature) => <Chip key={feature}>{feature}</Chip>)}</div>}
      </div>
    </aside>
  );
}

function DecisionSummary({ evaluation, locale }: { evaluation?: PropertyListing["evaluation"]; locale: LocaleCode }) {
  const { t } = useAppIntl();
  if (!evaluation) return <span className={styles.unavailable}>{t("properties.notEvaluated")}</span>;
  return (
    <div className={styles.decisionSummary}>
      <DecisionChip decision={evaluation.decision} />
      <strong>{formatEvaluationScore(evaluation.score, locale, t("common.unavailable"))}</strong>
      {evaluation.score !== null && <Meter value={evaluation.score} max={100} tone={evaluation.decision === "relevant" ? "good" : evaluation.decision === "not-relevant" ? "danger" : "default"} />}
    </div>
  );
}

function DecisionChip({ decision }: { decision: ListingDecision | "pass" | "fail" | "unknown" }) {
  const { t } = useAppIntl();
  const tone = decision === "relevant" || decision === "pass" ? "good" : decision === "not-relevant" || decision === "fail" ? "danger" : "sunset";
  const key = `decision.${decision}` as Parameters<typeof t>[0];
  return <Chip active tone={tone}>{t(key)}</Chip>;
}

function compareListings(left: PropertyListing, right: PropertyListing, key: SortKey, locale: LocaleCode): number {
  const unavailableLast = (a: string | number | undefined | null, b: string | number | undefined | null) => {
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
    if (b === undefined || b === null) return -1;
    return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), locale);
  };
  if (key === "title") return unavailableLast(left.title, right.title);
  if (key === "price") return unavailableLast(left.priceEuros, right.priceEuros);
  if (key === "surface") return unavailableLast(left.surfaceM2, right.surfaceM2);
  if (key === "score") return unavailableLast(left.evaluation?.score, right.evaluation?.score);
  if (key === "source") return unavailableLast(left.source, right.source);
  return unavailableLast(left.scrapedAt, right.scrapedAt);
}

function display(value: string | undefined, unavailable: string): string { return value?.trim() || unavailable; }
function formatOptionalPrice(value: number | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined ? unavailable : formatPrice(value, locale); }
function formatOptionalSurface(value: number | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined ? unavailable : `${formatInteger(value, locale)}\u00a0m²`; }
function formatEvaluationScore(value: number | null | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined || value === null ? unavailable : `${formatDecimal(value, locale)} / 100`; }
function formatOptionalDate(value: string | undefined, locale: LocaleCode, unavailable: string): string {
  if (!value) return unavailable;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? unavailable : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
