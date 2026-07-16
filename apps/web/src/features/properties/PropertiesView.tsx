import { useMemo, useState, type KeyboardEvent } from "react";
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
export function PropertiesView() {
  const { locale, t } = useAppIntl();
  const selectedPropertyId = useWorkspaceStore((state) => state.selectedPropertyId);
  const setSelectedPropertyId = useWorkspaceStore((state) => state.setSelectedPropertyId);
  const shortlisted = useWorkspaceStore((state) => state.shortlistedPropertyIds);
  const toggleShortlist = useWorkspaceStore((state) => state.toggleShortlist);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [activeProviders, setActiveProviders] = useState<ProviderName[]>(providerOptions);
  const [sortKey, setSortKey] = useState<PropertySortKey>("overall");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const { data: properties = [], isLoading, error } = useProperties();

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

  const selectedProperty = sortedProperties.find((property) => property.id === selectedPropertyId) ?? sortedProperties[0];

  const sortBy = (key: PropertySortKey) => {
    if (key === sortKey) {
      setSortDir((current) => (current === -1 ? 1 : -1));
    } else {
      setSortKey(key);
      setSortDir(-1);
    }
  };

  const toggleProvider = (provider: ProviderName) => {
    setActiveProviders((current) => (current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider]));
  };

  const selectWithKeyboard = (event: KeyboardEvent<HTMLElement>, propertyId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelectedPropertyId(propertyId);
  };

  return (
    <section className={styles.view}>
      <header className={styles.toolbar}>
        <div className={styles.providerFilters}>
          {providerOptions.map((provider) => (
            <Chip key={provider} active={activeProviders.includes(provider)} onClick={() => toggleProvider(provider)}>
              {provider}
            </Chip>
          ))}
        </div>

        <div className={styles.toolbarRight}>
          <span>{t("properties.count", { count: sortedProperties.length })}</span>
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
          {error && <EmptyState role="alert">{t("properties.error")}</EmptyState>}
          {!error && isLoading && <EmptyState role="status">{t("properties.loading")}</EmptyState>}
          {!error && !isLoading && sortedProperties.length === 0 && <EmptyState>{t("properties.empty")}</EmptyState>}
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
                  {sortedProperties.map((property) => (
                    <tr
                      key={property.id}
                      className={property.id === selectedProperty?.id ? styles.selectedRow : ""}
                      onClick={() => setSelectedPropertyId(property.id)}
                      onKeyDown={(event) => selectWithKeyboard(event, property.id)}
                      tabIndex={0}
                      aria-selected={property.id === selectedProperty?.id}
                    >
                      {columns.map((column) => (
                        <td key={column.key} style={{ textAlign: column.align ?? "left" }}>
                          <Cell property={property} column={column} shortlisted={shortlisted.includes(property.id)} locale={locale} />
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
              {sortedProperties.map((property) => (
                <article
                  key={property.id}
                  className={[styles.propertyCard, property.id === selectedProperty?.id ? styles.propertyCardActive : ""].join(" ")}
                  onClick={() => setSelectedPropertyId(property.id)}
                  onKeyDown={(event) => selectWithKeyboard(event, property.id)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={property.id === selectedProperty?.id}
                >
                  <div className={styles.visualWrap}>
                    <PropertyVisual property={property} />
                    <span className={styles.cardProvider}>{property.provider}</span>
                    <span className={styles.cardScore}>
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
                      <strong>{getPropertyTitle(property, locale)}</strong>
                      <span>{formatPrice(property.price, locale)}</span>
                    </div>
                    <p>
                      {property.locality} · {formatInteger(property.surfaceM2, locale)} m² · {formatRooms(property.rooms, locale)} · {t("property.dpe")} {property.dpe}
                    </p>
                    <Meter value={property.scores.overall} />
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        {selectedProperty && (
          <aside className={styles.detail}>
            <PropertyVisual property={selectedProperty} size="lg" />
            <div className={styles.detailBody}>
              <div className={styles.detailHeader}>
                <div>
                  <strong>{formatPrice(selectedProperty.price, locale)}</strong>
                  <h1>{getPropertyTitle(selectedProperty, locale)}</h1>
                  <p>{selectedProperty.address}</p>
                </div>
                <Chip>{selectedProperty.provider}</Chip>
              </div>

              <div className={styles.detailFacts}>
                <span>{formatInteger(selectedProperty.surfaceM2, locale)} m²</span>
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
                <Comparison locale={locale} label={t("properties.pricePerM2")} value={formatPricePerM2(selectedProperty.price, selectedProperty.surfaceM2, locale)} delta={percentDelta(selectedProperty.price / selectedProperty.surfaceM2, selectedProperty.diagnostics.irisMedianPrice)} />
                <Comparison locale={locale} label={t("properties.comparableSales")} value={formatInteger(selectedProperty.diagnostics.comparableSales, locale)} delta={12} />
                <Comparison locale={locale} label={t("properties.coastalDistance")} value={formatDistanceKm(selectedProperty.diagnostics.coastalDistanceKm, locale)} delta={-18} />
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

function Cell({ property, column, shortlisted, locale }: { property: PropertyListing; column: Column; shortlisted: boolean; locale: LocaleCode }) {
  const { t } = useAppIntl();

  if (column.key === "title") {
    return (
      <div className={styles.titleCell}>
        <PropertyVisual property={property} size="sm" />
        <div>
          <strong>{getPropertyTitle(property, locale)}</strong>
          <span>
            {shortlisted && <Star size={11} fill="currentColor" />} {property.locality} · {formatRooms(property.rooms, locale)}
          </span>
        </div>
      </div>
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

function Comparison({ label, value, delta, locale }: { label: string; value: string; delta: number; locale: LocaleCode }) {
  const positive = delta >= 0;
  return (
    <div className={styles.comparison}>
      <span>{label}</span>
      <b>{value}</b>
      <em className={positive ? styles.deltaGood : styles.deltaWeak}>{formatPercentage(delta, locale)}</em>
    </div>
  );
}
