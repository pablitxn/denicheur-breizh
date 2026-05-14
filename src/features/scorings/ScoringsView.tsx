import { useMemo, useState } from "react";
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
import { Button, Chip, EmptyState, FieldLabel, ScoreBadge } from "../../components/ui";
import { localizeScoring, localizeScoringGroup } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { ScoringMetric } from "../../types";
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
  const { data: scorings = [], isLoading, error } = useScorings();
  const [group, setGroup] = useState("all");
  const [activeId, setActiveId] = useState("coast");

  const groups = useMemo(() => ["all", ...Array.from(new Set(scorings.map((scoring) => scoring.group)))], [scorings]);
  const filteredRaw = group === "all" ? scorings : scorings.filter((scoring) => scoring.group === group);
  const filtered = useMemo(() => filteredRaw.map((scoring) => localizeScoring(scoring, locale)), [filteredRaw, locale]);
  const selectedRaw = scorings.find((scoring) => scoring.id === activeId) ?? filteredRaw[0] ?? scorings[0];
  const selected = selectedRaw ? localizeScoring(selectedRaw, locale) : undefined;

  return (
    <section className={styles.view}>
      <aside className={styles.groups}>
        <div className={styles.panelIntro}>
          <FieldLabel>{t("scorings.library")}</FieldLabel>
          <strong>{t("scorings.blocks", { count: scorings.length })}</strong>
        </div>
        <nav className={styles.groupList} aria-label={t("scorings.groups")}>
          {groups.map((item) => (
            <button
              key={item}
              className={group === item ? styles.groupActive : ""}
              type="button"
              onClick={() => setGroup(item)}
            >
              <span>{item === "all" ? t("scorings.all") : localizeScoringGroup(item, locale)}</span>
              <b>{item === "all" ? scorings.length : scorings.filter((scoring) => scoring.group === item).length}</b>
            </button>
          ))}
        </nav>
        <div className={styles.groupFooter}>
          <Button size="sm">{t("scorings.new")}</Button>
        </div>
      </aside>

      <div className={styles.index}>
        <header className={styles.indexHeader}>
          <FieldLabel>{group === "all" ? t("scorings.allScorings") : localizeScoringGroup(group, locale)}</FieldLabel>
          <span>{filtered.length}</span>
        </header>
        {error && <EmptyState>{t("scorings.error")}</EmptyState>}
        {!error && isLoading && <EmptyState>{t("scorings.loading")}</EmptyState>}
        {!error && !isLoading && (
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
    <button type="button" className={[styles.metricItem, active ? styles.metricItemActive : ""].join(" ")} onClick={onClick}>
      <span className={styles.metricIcon}>
        <Icon size={18} />
      </span>
      <span className={styles.metricCopy}>
        <strong>{scoring.name}</strong>
        <small>{scoring.short}</small>
      </span>
      <em>{scoring.group.slice(0, 3).toLowerCase()}</em>
    </button>
  );
}

function ScoringDocs({ scoring }: { scoring: ScoringMetric }) {
  const { t } = useAppIntl();
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
          <h1>{scoring.name}</h1>
        </div>
      </header>

      <p className={styles.lede}>{scoring.short}</p>

      <section className={styles.rangeBox}>
        <div className={styles.boxHeader}>
          <FieldLabel>{t("scorings.valueRange")}</FieldLabel>
          <span>0.0 - 10.0</span>
        </div>
        <div className={styles.rangeBar} />
        <div className={styles.rangeLabels}>
          <span>{t("scorings.insufficient")}</span>
          <span>{t("scorings.median")}</span>
          <span>{t("scorings.excellent")}</span>
        </div>
      </section>

      <section className={styles.docSection}>
        <h2>{t("scorings.formula")}</h2>
        <pre>{scoring.formula}</pre>
      </section>

      <section className={styles.docSection}>
        <h2>{t("scorings.inputs")}</h2>
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
            <FieldLabel>{t("scorings.goodScore")}</FieldLabel>
            <ScoreBadge value={8.6} />
          </div>
          <p>{scoring.sample.good}</p>
        </div>
        <div>
          <div className={styles.boxHeader}>
            <FieldLabel>{t("scorings.weakScore")}</FieldLabel>
            <ScoreBadge value={3.2} />
          </div>
          <p>{scoring.sample.weak}</p>
        </div>
      </section>

      <footer className={styles.docFooter}>
        <div>
          <FieldLabel>{t("common.source")}</FieldLabel>
          <span>{scoring.tags.join(", ")}</span>
        </div>
        <div>
          <FieldLabel>{t("scorings.freshness")}</FieldLabel>
          <span>{t("common.monthly")}</span>
        </div>
        <div>
          <FieldLabel>{t("common.status")}</FieldLabel>
          <span>{scoring.builtIn ? t("common.operational") : t("common.draft")}</span>
        </div>
      </footer>
    </div>
  );
}
