import { useEffect, useMemo } from "react";
import {
  BatteryCharging,
  ChartNoAxesCombined,
  CloudRain,
  School,
  Sparkles,
  Train,
  VolumeX,
  Waves,
  type LucideIcon,
} from "lucide-react";
import { useScorings } from "../../api/hooks";
import { Button, Chip, EmptyState, SectionLabel, ScoreBadge } from "@denicheur-breizh/design-system";
import { localizeScoring, localizeScoringGroup } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { ScoringMetric } from "../../types";
import { formatDecimal } from "../../utils/format";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./ScoringsView.module.css";

const iconMap: Record<string, LucideIcon> = {
  waves: Waves,
  "volume-x": VolumeX,
  "chart-no-axes-combined": ChartNoAxesCombined,
  school: School,
  train: Train,
  "battery-charging": BatteryCharging,
  "cloud-rain": CloudRain,
  sparkles: Sparkles,
};

export function ScoringsView() {
  const { locale, t } = useAppIntl();
  const { data: scorings = [], isLoading, error, refetch } = useScorings();
  const [requestedGroup, setGroup] = useUrlState("sgroup", "all", {
    ...stringUrlCodec,
    isDefault: (value) => value === "all",
  });
  const [activeId, setActiveId] = useUrlState("sid", "coast", {
    ...stringUrlCodec,
    isDefault: (value) => value === "coast",
  });

  const groups = useMemo(() => ["all", ...Array.from(new Set(scorings.map((scoring) => scoring.group)))], [scorings]);
  const group = groups.includes(requestedGroup) ? requestedGroup : "all";
  const filteredRaw = group === "all" ? scorings : scorings.filter((scoring) => scoring.group === group);
  const filtered = useMemo(() => filteredRaw.map((scoring) => localizeScoring(scoring, locale)), [filteredRaw, locale]);
  const selectedRaw = filteredRaw.find((scoring) => scoring.id === activeId) ?? filteredRaw[0];
  const selected = selectedRaw ? localizeScoring(selectedRaw, locale) : undefined;

  useEffect(() => {
    if (!isLoading && !error && requestedGroup !== group) setGroup(group);
  }, [error, group, isLoading, requestedGroup, setGroup]);

  useEffect(() => {
    if (selectedRaw && selectedRaw.id !== activeId) setActiveId(selectedRaw.id);
  }, [activeId, selectedRaw, setActiveId]);

  return (
    <section className={styles.view} aria-labelledby="scorings-view-title">
      <aside className={styles.groups}>
        <div className={styles.panelIntro}>
          <SectionLabel>{t("scorings.library")}</SectionLabel>
          <h1 id="scorings-view-title">{t("scorings.title")}</h1>
          <span>{t("scorings.blocks", { count: scorings.length })}</span>
        </div>
        <nav className={styles.groupList} aria-label={t("scorings.groups")}>
          {groups.map((item) => (
            <button
              key={item}
              className={group === item ? styles.groupActive : ""}
              type="button"
              onClick={() => setGroup(item)}
              aria-pressed={group === item}
            >
              <span>{item === "all" ? t("scorings.all") : localizeScoringGroup(item, locale)}</span>
              <b>{item === "all" ? scorings.length : scorings.filter((scoring) => scoring.group === item).length}</b>
            </button>
          ))}
        </nav>
      </aside>

      <div className={styles.index}>
        <header className={styles.indexHeader}>
          <SectionLabel>{group === "all" ? t("scorings.allScorings") : localizeScoringGroup(group, locale)}</SectionLabel>
          <span>{filtered.length}</span>
        </header>
        {error && (
          <EmptyState role="alert">
            <div className={styles.stateContent}>
              <strong>{t("scorings.error")}</strong>
              <Button onClick={() => void refetch()}>{t("common.retry")}</Button>
            </div>
          </EmptyState>
        )}
        {!error && isLoading && <EmptyState role="status">{t("scorings.loading")}</EmptyState>}
        {!error && !isLoading && filtered.length === 0 && <EmptyState>{t("scorings.empty")}</EmptyState>}
        {!error && !isLoading && filtered.length > 0 && (
          <div className={styles.metricList}>
            {filtered.map((scoring) => (
              <MetricListItem
                key={scoring.id}
                scoring={scoring}
                active={selected?.id === scoring.id}
                onClick={() => setActiveId(scoring.id)}
              />
            ))}
          </div>
        )}
      </div>

      <article className={styles.docs}>
        {selected ? <ScoringDocs scoring={selected} /> : <EmptyState>{t("scorings.empty")}</EmptyState>}
      </article>
    </section>
  );
}

function MetricListItem({ scoring, active, onClick }: { scoring: ScoringMetric; active: boolean; onClick: () => void }) {
  const Icon = iconMap[scoring.icon] ?? Sparkles;

  return (
    <button
      type="button"
      className={[styles.metricItem, active ? styles.metricItemActive : ""].join(" ")}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={styles.metricIcon}>
        <Icon size={18} />
      </span>
      <span className={styles.metricCopy}>
        <strong>{scoring.name}</strong>
        <small>{scoring.short}</small>
      </span>
    </button>
  );
}

function ScoringDocs({ scoring }: { scoring: ScoringMetric }) {
  const { locale, t } = useAppIntl();
  const Icon = iconMap[scoring.icon] ?? Sparkles;

  return (
    <div className={styles.docBody}>
      <header className={styles.docHeader}>
        <div className={styles.docIcon}>
          <Icon size={28} />
        </div>
        <div>
          <div className={styles.tagRow}>
            <Chip>{scoring.group}</Chip>
            {scoring.tags.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
            {!scoring.builtIn && <Chip active>{t("common.custom")}</Chip>}
          </div>
          <h2>{scoring.name}</h2>
        </div>
      </header>

      <p className={styles.lede}>{scoring.short}</p>

      <section className={styles.rangeBox}>
        <div className={styles.boxHeader}>
          <SectionLabel>{t("scorings.valueRange")}</SectionLabel>
          <span>{formatDecimal(0, locale)} - {formatDecimal(10, locale)}</span>
        </div>
        <div className={styles.rangeBar} />
        <div className={styles.rangeLabels}>
          <span>{t("scorings.insufficient")}</span>
          <span>{t("scorings.median")}</span>
          <span>{t("scorings.excellent")}</span>
        </div>
      </section>

      <section className={styles.docSection}>
        <h3>{t("scorings.formula")}</h3>
        <pre>{scoring.formula}</pre>
      </section>

      <section className={styles.docSection}>
        <h3>{t("scorings.inputs")}</h3>
        <ul>
          {scoring.inputs.map((input) => (
            <li key={input}>
              <span />
              {input}
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.examples}>
        <div>
          <div className={styles.boxHeader}>
            <SectionLabel>{t("scorings.goodScore")}</SectionLabel>
            <ScoreBadge
              value={8.6}
              displayValue={formatDecimal(8.6, locale)}
              label={t("score.valueAria", {
                name: t("scorings.goodScore"),
                value: formatDecimal(8.6, locale),
              })}
            />
          </div>
          <p>{scoring.sample.good}</p>
        </div>
        <div>
          <div className={styles.boxHeader}>
            <SectionLabel>{t("scorings.weakScore")}</SectionLabel>
            <ScoreBadge
              value={3.2}
              displayValue={formatDecimal(3.2, locale)}
              label={t("score.valueAria", {
                name: t("scorings.weakScore"),
                value: formatDecimal(3.2, locale),
              })}
            />
          </div>
          <p>{scoring.sample.weak}</p>
        </div>
      </section>

      <footer className={styles.docFooter}>
        <div>
          <SectionLabel>{t("common.source")}</SectionLabel>
          <span>{scoring.tags.join(", ")}</span>
        </div>
        <div>
          <SectionLabel>{t("scorings.freshness")}</SectionLabel>
          <span>{t("common.monthly")}</span>
        </div>
        <div>
          <SectionLabel>{t("common.status")}</SectionLabel>
          <span>{scoring.builtIn ? t("common.operational") : t("common.draft")}</span>
        </div>
      </footer>
    </div>
  );
}
