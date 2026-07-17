import { useEffect, useMemo, useRef } from "react";
import { ArrowDown, ArrowUp, Grid2X2, List, Star } from "lucide-react";
import { useProperties } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { Button, Chip, EmptyState, SectionLabel, Meter, ScoreBadge } from "@denicheur-breizh/design-system";
import { getPropertyTitle, scoreMessageIds } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import { bcp47Locales } from "../../intl/locales";
import type { MessageId } from "../../intl/messages";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { PropertyListing, ProviderName, ScoreKey } from "../../types";
import type { LocaleCode } from "../../intl/locales";
import {
  formatDecimal,
  formatDistanceKm,
  formatInteger,
  formatPercentage,
  formatPostedDays,
  formatPrice,
  formatPricePerM2,
  formatRooms,
  percentDelta,
} from "../../utils/format";
import { getPropertySortValue, type PropertySortKey } from "../../utils/propertySort";
import {
  enumUrlCodec,
  numberUrlCodec,
  stringArrayUrlCodec,
  stringUrlCodec,
  useUrlState,
} from "../../utils/useUrlState";
import { useMediaQuery } from "../shared/useMediaQuery";
import styles from "./PropertiesView.module.css";

type ViewMode = "table" | "cards";
interface Column {
  key: PropertySortKey;
  labelId: MessageId;
  align?: "left" | "right" | "center";
  width: number;
}

const columns: Column[] = [
  { key: "title", labelId: "properties.column.title", width: 280 },
  { key: "price", labelId: "properties.column.price", align: "right", width: 96 },
  { key: "surfaceM2", labelId: "properties.column.surface", align: "right", width: 66 },
  { key: "overall", labelId: "properties.column.overall", align: "right", width: 78 },
  { key: "coast", labelId: "properties.column.coast", align: "right", width: 70 },
  { key: "quiet", labelId: "properties.column.quiet", align: "right", width: 74 },
  { key: "value", labelId: "properties.column.value", align: "right", width: 76 },
  { key: "family", labelId: "properties.column.family", align: "right", width: 78 },
  { key: "transit", labelId: "properties.column.transit", align: "right", width: 68 },
  { key: "dpe", labelId: "property.dpe", align: "center", width: 58 },
  { key: "provider", labelId: "properties.column.provider", width: 110 },
  { key: "postedDaysAgo", labelId: "properties.column.posted", align: "right", width: 82 },
];

const providerOptions: ProviderName[] = ["SeLoger", "Bien'ici", "Leboncoin", "Ouest-France"];
const sortKeys = columns.map((column) => column.key);
const propertyProviderUrlOptions = {
  ...stringArrayUrlCodec(providerOptions),
  isDefault: (value: ProviderName[]) => sameMembers(value, providerOptions),
};
const propertyViewUrlOptions = {
  ...enumUrlCodec(["table", "cards"] as const),
};
const propertySortUrlOptions = {
  ...enumUrlCodec(sortKeys),
  isDefault: (value: PropertySortKey) => value === "overall",
};
const propertySortDirectionUrlOptions = {
  ...enumUrlCodec(["asc", "desc"] as const),
  isDefault: (value: "asc" | "desc") => value === "desc",
};
const propertyLimitUrlOptions = {
  parse: (value: string | null) => {
    const parsed = numberUrlCodec.parse(value);
    return parsed === undefined ? undefined : Math.min(500, Math.max(50, Math.round(parsed / 50) * 50));
  },
  serialize: numberUrlCodec.serialize,
  isDefault: (value: number) => value === 50,
};
const selectedPropertyUrlOptions = {
  ...stringUrlCodec,
  isDefault: (value: string) => value === "",
};

export function PropertiesView() {
  const { locale, t } = useAppIntl();
  const storedSelectedPropertyId = useWorkspaceStore((state) => state.selectedPropertyId);
  const setSelectedPropertyId = useWorkspaceStore((state) => state.setSelectedPropertyId);
  const shortlisted = useWorkspaceStore((state) => state.shortlistedPropertyIds);
  const toggleShortlist = useWorkspaceStore((state) => state.toggleShortlist);
  const isMobile = useMediaQuery("(max-width: 760px)");
  const shouldScrollToDetail = useMediaQuery("(max-width: 1120px)");
  const detailRef = useRef<HTMLElement | null>(null);
  const [viewMode, setViewMode] = useUrlState<ViewMode>(
    "pmode",
    isMobile ? "cards" : "table",
    propertyViewUrlOptions,
  );
  const [activeProviders, setActiveProviders] = useUrlState(
    "pprov",
    providerOptions,
    propertyProviderUrlOptions,
  );
  const [sortKey, setSortKey] = useUrlState<PropertySortKey>("psort", "overall", propertySortUrlOptions);
  const [sortDirection, setSortDirection] = useUrlState<"asc" | "desc">(
    "pdir",
    "desc",
    propertySortDirectionUrlOptions,
  );
  const [visibleLimit, setVisibleLimit] = useUrlState("plim", 50, propertyLimitUrlOptions);
  const [urlSelectedPropertyId, setUrlSelectedPropertyId] = useUrlState(
    "pid",
    storedSelectedPropertyId,
    selectedPropertyUrlOptions,
  );
  const { data: properties = [], isLoading, error, refetch } = useProperties();
  const sortDir = sortDirection === "asc" ? 1 : -1;

  const sortedProperties = useMemo(() => {
    return [...properties]
      .filter((property) => activeProviders.includes(property.provider))
      .sort((a, b) => {
        if (sortKey === "title") {
          return sortDir * getPropertyTitle(a, locale).localeCompare(getPropertyTitle(b, locale), bcp47Locales[locale]);
        }
        const av = getPropertySortValue(a, sortKey);
        const bv = getPropertySortValue(b, sortKey);
        if (typeof av === "number" && typeof bv === "number") return sortDir * (av - bv);
        return sortDir * String(av).localeCompare(String(bv));
      });
  }, [activeProviders, locale, properties, sortDir, sortKey]);

  const visibleProperties = sortedProperties.slice(0, visibleLimit);
  const selectedProperty =
    sortedProperties.find((property) => property.id === urlSelectedPropertyId) ?? sortedProperties[0];

  useEffect(() => {
    if (!selectedProperty) return;
    if (storedSelectedPropertyId !== selectedProperty.id) setSelectedPropertyId(selectedProperty.id);
    if (urlSelectedPropertyId !== selectedProperty.id) setUrlSelectedPropertyId(selectedProperty.id);
  }, [
    selectedProperty,
    setSelectedPropertyId,
    setUrlSelectedPropertyId,
    storedSelectedPropertyId,
    urlSelectedPropertyId,
  ]);

  const sortBy = (key: PropertySortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDirection(key === "title" ? "asc" : "desc");
    }
  };

  const toggleProvider = (provider: ProviderName) => {
    setActiveProviders((current) => (current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider]));
  };

  const selectProperty = (propertyId: string) => {
    setSelectedPropertyId(propertyId);
    setUrlSelectedPropertyId(propertyId);
    if (shouldScrollToDetail) {
      window.requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        detailRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      });
    }
  };

  const resetFilters = () => {
    setActiveProviders(providerOptions);
    setVisibleLimit(50);
  };

  return (
    <section className={styles.view} aria-labelledby="properties-view-title">
      <header className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <h1 id="properties-view-title">{t("properties.title")}</h1>
          <span aria-live="polite">{t("properties.count", { count: sortedProperties.length })}</span>
        </div>
        <div className={styles.providerFilters} role="group" aria-label={t("properties.filters")}>
          {providerOptions.map((provider) => (
            <Chip key={provider} active={activeProviders.includes(provider)} onClick={() => toggleProvider(provider)}>
              {provider}
            </Chip>
          ))}
        </div>

        <div className={styles.toolbarRight} role="group" aria-label={t("properties.viewModes")}>
          <Button size="sm" variant={viewMode === "table" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("table")} aria-label={t("properties.table")} aria-pressed={viewMode === "table"}>
            <List size={14} />
          </Button>
          <Button size="sm" variant={viewMode === "cards" ? "default" : "ghost"} iconOnly onClick={() => setViewMode("cards")} aria-label={t("properties.cards")} aria-pressed={viewMode === "cards"}>
            <Grid2X2 size={14} />
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.results}>
          {error && (
            <EmptyState role="alert">
              <div className={styles.stateContent}>
                <strong>{t("properties.error")}</strong>
                <Button onClick={() => void refetch()}>{t("common.retry")}</Button>
              </div>
            </EmptyState>
          )}
          {!error && isLoading && <EmptyState role="status">{t("properties.loading")}</EmptyState>}
          {!error && !isLoading && sortedProperties.length === 0 && (
            <EmptyState>
              <div className={styles.stateContent}>
                <strong>{t("properties.empty")}</strong>
                <Button onClick={resetFilters}>{t("common.reset")}</Button>
              </div>
            </EmptyState>
          )}
          {!error && !isLoading && sortedProperties.length > 0 && viewMode === "table" && (
            <div className={styles.tableWrap}>
              <table className={styles.table} aria-label={t("properties.table")}>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        style={{ minWidth: column.width, textAlign: column.align ?? "left" }}
                        aria-sort={sortKey === column.key ? (sortDir === -1 ? "descending" : "ascending") : "none"}
                      >
                        <button type="button" onClick={() => sortBy(column.key)}>
                          <span>{t(column.labelId)}</span>
                          {sortKey === column.key && (sortDir === -1 ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleProperties.map((property) => (
                    <tr
                      key={property.id}
                      className={property.id === selectedProperty?.id ? styles.selectedRow : ""}
                    >
                      {columns.map((column) => (
                        <td key={column.key} style={{ textAlign: column.align ?? "left" }}>
                          <Cell
                            property={property}
                            column={column}
                            shortlisted={shortlisted.includes(property.id)}
                            selected={property.id === selectedProperty?.id}
                            locale={locale}
                            onSelect={() => selectProperty(property.id)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!error && !isLoading && sortedProperties.length > 0 && viewMode === "cards" && (
            <div className={styles.cardGrid}>
              {visibleProperties.map((property) => (
                <button
                  key={property.id}
                  type="button"
                  className={[styles.propertyCard, property.id === selectedProperty?.id ? styles.propertyCardActive : ""].join(" ")}
                  onClick={() => selectProperty(property.id)}
                  aria-pressed={property.id === selectedProperty?.id}
                  aria-labelledby={`property-card-${property.id}-title`}
                  aria-describedby={`property-card-${property.id}-price property-card-${property.id}-facts property-card-${property.id}-score`}
                >
                  <div className={styles.visualWrap}>
                    <PropertyVisual property={property} />
                    <span className={styles.cardProvider}>{property.provider}</span>
                    <span id={`property-card-${property.id}-score`} className={styles.cardScore}>
                      <ScoreBadge
                        value={property.scores.overall}
                        displayValue={formatDecimal(property.scores.overall, locale)}
                        label={t("score.valueAria", {
                          name: t("score.overall"),
                          value: formatDecimal(property.scores.overall, locale),
                        })}
                      />
                    </span>
                  </div>
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>
                      <strong id={`property-card-${property.id}-title`}>{getPropertyTitle(property, locale)}</strong>
                      <span id={`property-card-${property.id}-price`}>{formatPrice(property.price, locale)}</span>
                    </div>
                    <p id={`property-card-${property.id}-facts`}>
                      {property.locality} · {formatInteger(property.surfaceM2, locale)}&nbsp;m² · {formatRooms(property.rooms, locale)} · {t("property.dpe")} {property.dpe}
                    </p>
                    <Meter value={property.scores.overall} />
                  </div>
                </button>
              ))}
            </div>
          )}
          {!error && !isLoading && visibleProperties.length < sortedProperties.length && (
            <div className={styles.loadMore}>
              <span>{t("properties.showing", { count: visibleProperties.length, total: sortedProperties.length })}</span>
              <Button onClick={() => setVisibleLimit((current) => current + 50)}>{t("properties.showMore")}</Button>
            </div>
          )}
        </div>

        {selectedProperty && (
          <aside ref={detailRef} className={styles.detail}>
            <PropertyVisual property={selectedProperty} size="lg" />
            <div className={styles.detailBody}>
              <div className={styles.detailHeader}>
                <div>
                  <strong>{formatPrice(selectedProperty.price, locale)}</strong>
                  <h2>{getPropertyTitle(selectedProperty, locale)}</h2>
                  <p>{selectedProperty.address}</p>
                </div>
                <Chip>{selectedProperty.provider}</Chip>
              </div>

              <div className={styles.detailFacts}>
                <span>{formatInteger(selectedProperty.surfaceM2, locale)}&nbsp;m²</span>
                <span>{formatRooms(selectedProperty.rooms, locale)}</span>
                <span>{formatPricePerM2(selectedProperty.price, selectedProperty.surfaceM2, locale)}</span>
                <span>{t("property.dpe")} {selectedProperty.dpe}</span>
              </div>

              <div className={styles.breakdown}>
                <SectionLabel>{t("properties.scoringDetail")}</SectionLabel>
                {[
                  [scoreMessageIds.overall, selectedProperty.scores.overall],
                  [scoreMessageIds.coast, selectedProperty.scores.coast],
                  [scoreMessageIds.quiet, selectedProperty.scores.quiet],
                  [scoreMessageIds.value, selectedProperty.scores.value],
                  [scoreMessageIds.family, selectedProperty.scores.family],
                  [scoreMessageIds.transit, selectedProperty.scores.transit],
                ].map(([label, value]) => (
                  <div key={label} className={styles.metricRow}>
                    <span>{t(label as MessageId)}</span>
                    <b>{formatDecimal(Number(value), locale)}</b>
                    <Meter value={Number(value)} />
                  </div>
                ))}
              </div>

              <div className={styles.marketBox}>
                <SectionLabel>{t("properties.marketCompare")}</SectionLabel>
                <Comparison
                  locale={locale}
                  label={t("properties.pricePerM2")}
                  value={formatPricePerM2(selectedProperty.price, selectedProperty.surfaceM2, locale)}
                  delta={percentDelta(
                    selectedProperty.price / selectedProperty.surfaceM2,
                    selectedProperty.diagnostics.irisMedianPrice,
                  )}
                  favorableWhen="lower"
                />
                <Comparison
                  locale={locale}
                  label={t("properties.comparableSales")}
                  value={formatInteger(selectedProperty.diagnostics.comparableSales, locale)}
                  delta={12}
                  favorableWhen="higher"
                />
                <Comparison
                  locale={locale}
                  label={t("properties.coastalDistance")}
                  value={formatDistanceKm(selectedProperty.diagnostics.coastalDistanceKm, locale)}
                  delta={-18}
                  favorableWhen="lower"
                />
              </div>

              <div className={styles.detailActions}>
                <Button onClick={() => toggleShortlist(selectedProperty.id)}>
                  <Star size={15} />
                  {shortlisted.includes(selectedProperty.id) ? t("properties.shortlisted") : t("properties.shortlist")}
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}

function Cell({
  property,
  column,
  shortlisted,
  selected,
  locale,
  onSelect,
}: {
  property: PropertyListing;
  column: Column;
  shortlisted: boolean;
  selected: boolean;
  locale: LocaleCode;
  onSelect: () => void;
}) {
  const { t } = useAppIntl();

  if (column.key === "title") {
    return (
      <button
        type="button"
        className={styles.titleCell}
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={t("properties.select", { title: getPropertyTitle(property, locale) })}
      >
        <PropertyVisual property={property} size="sm" />
        <div>
          <strong>{getPropertyTitle(property, locale)}</strong>
          <span>
            {shortlisted && <Star size={11} fill="currentColor" />} {property.locality} · {formatRooms(property.rooms, locale)}
          </span>
        </div>
      </button>
    );
  }

  if (column.key === "price") return <span className={styles.numeric}>{formatPrice(property.price, locale)}</span>;
  if (column.key === "surfaceM2") return <span className={styles.numeric}>{formatInteger(property.surfaceM2, locale)}</span>;
  if (column.key === "provider") return <Chip>{property.provider}</Chip>;
  if (column.key === "postedDaysAgo") return <span className={styles.numeric}>{formatPostedDays(property.postedDaysAgo, locale)}</span>;
  if (column.key === "dpe") return <Chip active>{property.dpe}</Chip>;
  const scoreKey = column.key === "overall" ? "overall" : column.key as ScoreKey;
  const scoreValue = scoreKey === "overall" ? property.scores.overall : property.scores[scoreKey];
  const displayValue = formatDecimal(scoreValue, locale);

  return (
    <ScoreBadge
      value={scoreValue}
      displayValue={displayValue}
      label={t("score.valueAria", { name: t(scoreMessageIds[scoreKey]), value: displayValue })}
    />
  );
}

function Comparison({
  label,
  value,
  delta,
  locale,
  favorableWhen,
}: {
  label: string;
  value: string;
  delta: number;
  locale: LocaleCode;
  favorableWhen: "higher" | "lower";
}) {
  const favorable = favorableWhen === "higher" ? delta >= 0 : delta <= 0;
  return (
    <div className={styles.comparison}>
      <span>{label}</span>
      <b>{value}</b>
      <em className={favorable ? styles.deltaGood : styles.deltaWeak}>{formatPercentage(delta, locale)}</em>
    </div>
  );
}

function sameMembers<T extends string>(left: T[], right: T[]) {
  return left.length === right.length && left.every((item) => right.includes(item));
}
