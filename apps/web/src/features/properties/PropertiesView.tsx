import { useEffect, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, Grid2X2, List, X } from "lucide-react";
import { Button, Chip, EmptyState, Meter, SectionLabel, Select } from "@denicheur-breizh/design-system";
import { useListing, useListings, useListingsMetadata } from "../../api/hooks";
import { isExpiredCursor } from "../../api/denicheurApi";
import { queryKeys } from "../../api/queryKeys";
import { PropertyVisual } from "../../components/PropertyVisual";
import { useAppIntl } from "../../intl/IntlContext";
import type { LocaleCode } from "../../intl/locales";
import type { ListingDecision, ListingFilters, PaginatedListings, PropertyListing } from "../../types";
import { formatDecimal, formatInteger, formatPrice, formatRooms } from "../../utils/format";
import { enumUrlCodec, stringArrayUrlCodec, stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import { useMediaQuery } from "../shared/useMediaQuery";
import styles from "./PropertiesView.module.css";

type ViewMode = "table" | "cards";
type SortKey = "title" | "price" | "surface" | "score" | "source" | "updated";

const sortKeys = ["title", "price", "surface", "score", "source", "updated"] as const;
const emptyListings: PropertyListing[] = [];
const emptySources: string[] = [];
const pageSize = 50;
const serverSort: Record<SortKey, ListingFilters["sort"]> = {
  title: "title", price: "priceEuros", surface: "surfaceM2", score: "score", source: "source", updated: "updatedAt",
};

export function PropertiesView() {
  const { locale, t } = useAppIntl();
  const queryClient = useQueryClient();
  const isMobile = useMediaQuery("(max-width: 760px)");
  const shouldScrollToDetail = useMediaQuery("(max-width: 1120px)");
  const detailRef = useRef<HTMLElement | null>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);
  const [viewMode, setViewMode] = useUrlState<ViewMode>("pmode", isMobile ? "cards" : "table", enumUrlCodec(["table", "cards"] as const));
  const [sortKey, setSortKey] = useUrlState<SortKey>("psort", "updated", enumUrlCodec(sortKeys));
  const [sortDirection, setSortDirection] = useUrlState<"asc" | "desc">("pdir", "desc", enumUrlCodec(["asc", "desc"] as const));
  const [selectedKey, setSelectedKey] = useUrlState("pid", "", stringUrlCodec);
  const [activeSources, setActiveSources] = useUrlState("psources", emptySources, stringArrayUrlCodec());
  const signature = JSON.stringify([activeSources, sortKey, sortDirection]);
  const [pagination, setPagination] = useState<{ signature: string; cursors: Array<string | undefined>; index: number; revision?: string }>({ signature, cursors: [undefined], index: 0 });
  const currentPage = pagination.signature === signature ? pagination.index : 0;
  const cursor = pagination.signature === signature ? pagination.cursors[currentPage] : undefined;
  const metadataQuery = useListingsMetadata();
  const listingFilters: ListingFilters = { limit: pageSize, sources: activeSources, sort: serverSort[sortKey], order: sortDirection, cursor };
  const listingsQuery = useListings(listingFilters);
  const lastPage = useRef<{ data: PaginatedListings; index: number } | undefined>(undefined);
  useEffect(() => {
    if (listingsQuery.data && !listingsQuery.isPlaceholderData) lastPage.current = { data: listingsQuery.data, index: currentPage };
  }, [listingsQuery.data, listingsQuery.isPlaceholderData, currentPage]);
  const pageData = listingsQuery.data ?? (listingsQuery.error ? lastPage.current?.data : undefined);
  const displayedPage = listingsQuery.isPlaceholderData || !listingsQuery.data ? lastPage.current?.index ?? currentPage : currentPage;
  const listings = pageData?.items ?? emptyListings;
  const sources = metadataQuery.data?.sources ?? [];
  const sortedListings = listings;
  const observedRevision = useRef<string | undefined>(undefined);
  const revision = metadataQuery.data?.revision;
  const hasNewResults = currentPage > 0 && revision !== undefined && pagination.revision !== revision;

  useEffect(() => {
    if (pagination.signature !== signature) setPagination({ signature, cursors: [undefined], index: 0 });
  }, [pagination.signature, signature]);

  useEffect(() => {
    if (currentPage === 0 && revision !== undefined && observedRevision.current !== undefined && observedRevision.current !== revision) void listingsQuery.refetch();
    observedRevision.current = revision;
  }, [currentPage, revision, listingsQuery.refetch]);

  const selectedSummary = sortedListings.find((listing) => listing.key === selectedKey);
  const separator = selectedKey.indexOf(":");
  const detailSource = selectedSummary?.source ?? (separator > 0 ? selectedKey.slice(0, separator) : undefined);
  const detailId = selectedSummary?.externalId ?? (separator > 0 ? selectedKey.slice(separator + 1) : undefined);
  const detailQuery = useListing(detailSource, detailId);
  const selected = detailQuery.data ?? selectedSummary;

  const detailOpen = Boolean(selected || (detailSource && detailId));

  const closeDetail = () => {
    setSelectedKey("");
    selectionTriggerRef.current?.focus({ preventScroll: true });
  };

  const selectListing = (key: string) => {
    selectionTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

  const restart = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.listings.list({ ...listingFilters, cursor: undefined }), exact: true, refetchType: "all" });
    setPagination({ signature, cursors: [undefined], index: 0, revision });
    void metadataQuery.refetch();
  };
  const nextPage = () => {
    if (!listingsQuery.data?.nextCursor || listingsQuery.isPlaceholderData) return;
    const cursors = pagination.signature === signature ? pagination.cursors.slice(0, currentPage + 1) : [undefined];
    setPagination({ signature, cursors: [...cursors, listingsQuery.data.nextCursor], index: currentPage + 1, revision: currentPage === 0 ? revision : pagination.revision });
  };

  return (
    <section className={styles.view} aria-labelledby="properties-view-title">
      <header className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <h1 id="properties-view-title">{t("properties.title")}</h1>
          <span aria-live="polite">{t("properties.count", { count: pageData?.total ?? 0 })}</span>
        </div>
        <div className={styles.providerFilters} role="group" aria-label={t("properties.filters")}>
          <Chip active={activeSources.length === 0} onClick={() => setActiveSources([])}>{t("catalog.allSources")}</Chip>
          {sources.map(({ source, count }) => (
            <Chip key={source} active={activeSources.includes(source)} onClick={() => toggleSource(source)}>
              {source} <span className={styles.sourceCount}>{formatInteger(count, locale)}</span>
            </Chip>
          ))}
        </div>
        <div className={styles.toolbarRight} role="group" aria-label={t("properties.viewModes")}>
          {viewMode === "cards" && <Select aria-label={t("catalog.sort")} value={`${sortKey}:${sortDirection}`} onChange={(event) => {
            const [key, direction] = event.target.value.split(":");
            setSortKey(key as SortKey); setSortDirection(direction as "asc" | "desc");
          }}>
            {sortKeys.flatMap((key) => (["asc", "desc"] as const).map((direction) => <option key={`${key}:${direction}`} value={`${key}:${direction}`}>
              {t(`properties.column.${key === "price" ? "price" : key === "source" ? "provider" : key === "score" ? "evaluation" : key}`)} · {t(`catalog.${direction}`)}
            </option>))}
          </Select>}
          <Button size="sm" variant={viewMode === "table" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("table")} aria-label={t("properties.table")} aria-pressed={viewMode === "table"}>
            <List size={14} aria-hidden="true" />
          </Button>
          <Button size="sm" variant={viewMode === "cards" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("cards")} aria-label={t("properties.cards")} aria-pressed={viewMode === "cards"}>
            <Grid2X2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </header>

      <nav className={styles.pageBar} aria-label={t("catalog.pagination")}>
        <span role="status">{listingsQuery.isPlaceholderData ? t("properties.loading") : t("catalog.range", { start: sortedListings.length ? displayedPage * pageSize + 1 : 0, end: displayedPage * pageSize + sortedListings.length, total: pageData?.total ?? 0 })}</span>
        <div className={styles.pageActions}>
          <Button size="sm" variant="ghost" disabled={listingsQuery.isFetching} onClick={restart}>{t(hasNewResults ? "catalog.newResults" : "catalog.refresh")}</Button>
          <Button size="sm" disabled={currentPage === 0 || listingsQuery.isFetching} onClick={() => setPagination((page) => ({ ...page, index: Math.max(0, page.index - 1) }))}>{t("catalog.previous")}</Button>
          <Button size="sm" disabled={!listingsQuery.data?.nextCursor || listingsQuery.isFetching} onClick={nextPage}>{t("catalog.next")}</Button>
        </div>
      </nav>

      <div className={[styles.body, detailOpen ? styles.bodyWithDetail : ""].join(" ")}>
        <div className={styles.results} aria-busy={listingsQuery.isPlaceholderData}>
          {metadataQuery.error && <RetryNotice message={t("catalog.metadataError")} retrying={metadataQuery.isFetching} onRetry={() => void metadataQuery.refetch()} />}
          {listingsQuery.error && (pageData ? (
            <RetryNotice message={t(isExpiredCursor(listingsQuery.error) ? "catalog.expired" : "properties.refreshError")} retrying={listingsQuery.isFetching} onRetry={isExpiredCursor(listingsQuery.error) ? restart : () => void listingsQuery.refetch()} />
          ) : <LoadState kind="error" retrying={listingsQuery.isFetching} onRetry={isExpiredCursor(listingsQuery.error) ? restart : () => void listingsQuery.refetch()} />)}
          {!listingsQuery.error && listingsQuery.isLoading && <EmptyState role="status">{t("properties.loading")}</EmptyState>}
          {!listingsQuery.error && !listingsQuery.isLoading && sortedListings.length === 0 && <EmptyState>{t("properties.empty")}</EmptyState>}
          {sortedListings.length > 0 && viewMode === "table" && (
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
          {sortedListings.length > 0 && viewMode === "cards" && (
            <div className={styles.cardGrid}>
              {sortedListings.map((listing) => (
                <article
                  key={listing.key}
                  className={[styles.propertyCard, listing.key === selected?.key ? styles.propertyCardActive : ""].join(" ")}
                >
                  <div className={styles.visualWrap}>
                    <PropertyVisual property={listing} navigation />
                    <span className={styles.cardProvider}>{listing.source}</span>
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>
                      <strong>{display(listing.title, t("common.unavailable"))}</strong>
                      <span className={listing.priceEuros === undefined ? styles.cardPriceUnavailable : undefined}>{formatOptionalPrice(listing.priceEuros, locale, t("common.unavailable"))}</span>
                    </div>
                    <p>{listing.location ?? t("common.unavailable")} · {formatOptionalSurface(listing.surfaceM2, locale, t("common.unavailable"))}</p>
                    <DecisionSummary evaluation={listing.evaluation} locale={locale} />
                  </div>
                  <button
                    type="button"
                    className={styles.cardSelect}
                    onClick={() => selectListing(listing.key)}
                    aria-label={t("properties.select", {
                      title: display(listing.title, t("common.unavailable")),
                    })}
                    aria-pressed={listing.key === selected?.key}
                  />
                </article>
              ))}
            </div>
          )}
        </div>
        {selected && <ListingDetail detailRef={detailRef} listing={selected} loading={detailQuery.isFetching} error={Boolean(detailQuery.error)} onRetry={() => void detailQuery.refetch()} onClose={closeDetail} />}
        {!selected && detailSource && detailId && <aside ref={detailRef} className={styles.detail} aria-busy={detailQuery.isFetching}>
          <DetailPanelHeader onClose={closeDetail} />
          {detailQuery.error
            ? <RetryNotice message={t("properties.detailError")} retrying={detailQuery.isFetching} onRetry={() => void detailQuery.refetch()} />
            : <EmptyState role="status">{t("common.loading")}</EmptyState>}
        </aside>}
      </div>
    </section>
  );
}

function LoadState({ kind, retrying, onRetry }: { kind: "error"; retrying: boolean; onRetry: () => void }) {
  const { t } = useAppIntl();
  return (
    <EmptyState role="alert" data-kind={kind}>
      <div className={styles.stateContent}>
        <strong>{t("properties.error")}</strong>
        <Button disabled={retrying} onClick={onRetry}>{t("common.retry")}</Button>
      </div>
    </EmptyState>
  );
}

function RetryNotice({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  const { t } = useAppIntl();
  return (
    <div className={styles.retryNotice} role="alert">
      <p>{message}</p>
      <Button size="sm" disabled={retrying} onClick={onRetry}>{t("common.retry")}</Button>
    </div>
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
            <td className={styles.numeric}>{listing.evaluation ? formatEvaluationScore(listing.evaluation.score, locale, t("common.unavailable")) : t("properties.notEvaluated")}</td>
            <td><Chip>{listing.source}</Chip></td>
            <td>{formatOptionalDate(listing.updatedAt ?? listing.scrapedAt, locale, t("common.unavailable"))}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function DetailPanelHeader({ onClose }: { onClose: () => void }) {
  const { t } = useAppIntl();
  return (
    <div className={styles.detailToolbar}>
      <SectionLabel>{t("properties.detailTitle")}</SectionLabel>
      <Button variant="ghost" iconOnly onClick={onClose} aria-label={t("properties.closeDetail")} title={t("properties.closeDetail")}>
        <X size={18} aria-hidden="true" />
      </Button>
    </div>
  );
}

function ListingDetail({ listing, loading, error, onRetry, onClose, detailRef }: { listing: PropertyListing; loading: boolean; error: boolean; onRetry: () => void; onClose: () => void; detailRef: RefObject<HTMLElement | null> }) {
  const { locale, t } = useAppIntl();
  const evaluation = listing.evaluation;
  return (
    <aside ref={detailRef} className={styles.detail} aria-busy={loading}>
      <DetailPanelHeader onClose={onClose} />
      <PropertyVisual key={listing.key} property={listing} size="lg" navigation />
      <div className={styles.detailBody}>
        {error && <RetryNotice message={t("properties.detailError")} retrying={loading} onRetry={onRetry} />}
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

function display(value: string | undefined, unavailable: string): string { return value?.trim() || unavailable; }
function formatOptionalPrice(value: number | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined ? unavailable : formatPrice(value, locale); }
function formatOptionalSurface(value: number | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined ? unavailable : `${formatInteger(value, locale)}\u00a0m²`; }
function formatEvaluationScore(value: number | null | undefined, locale: LocaleCode, unavailable: string): string { return value === undefined || value === null ? unavailable : `${formatDecimal(value, locale)} / 100`; }
function formatOptionalDate(value: string | undefined, locale: LocaleCode, unavailable: string): string {
  if (!value) return unavailable;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? unavailable : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
