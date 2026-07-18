import { useEffect, useMemo } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, MinusCircle, Sparkles } from "lucide-react";
import { Button, Chip, EmptyState, Meter, SectionLabel } from "@denicheur-breizh/design-system";
import { useActiveRecipe, useListings, useRecipes } from "../../api/hooks";
import { useAppIntl } from "../../intl/IntlContext";
import type { IntelligenceCriterion, ListingDecision, PropertyListing } from "../../types";
import { formatDecimal } from "../../utils/format";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./ScoringsView.module.css";

type DecisionFilter = "all" | ListingDecision | "unevaluated";

export function ScoringsView() {
  const { t } = useAppIntl();
  const listingsQuery = useListings({ limit: 100 });
  const recipesQuery = useRecipes();
  const activeRecipeQuery = useActiveRecipe();
  const listings = listingsQuery.data?.items ?? [];
  const recipes = recipesQuery.data ?? [];
  const [decision, setDecision] = useUrlState<DecisionFilter>("sdecision", "all", {
    ...stringUrlCodec,
    parse: (value) => value && ["all", "relevant", "not-relevant", "review", "unevaluated"].includes(value) ? value as DecisionFilter : undefined,
  });
  const [selectedKey, setSelectedKey] = useUrlState("sid", "", stringUrlCodec);
  const filtered = listings.filter((listing) => decision === "all"
    || (decision === "unevaluated" ? !listing.evaluation : listing.evaluation?.decision === decision));
  const selected = filtered.find((listing) => listing.key === selectedKey) ?? filtered[0];

  useEffect(() => {
    if (selected && selected.key !== selectedKey) setSelectedKey(selected.key);
    if (!selected && selectedKey) setSelectedKey("");
  }, [selected, selectedKey, setSelectedKey]);

  const counts = useMemo(() => ({
    relevant: listings.filter((item) => item.evaluation?.decision === "relevant").length,
    "not-relevant": listings.filter((item) => item.evaluation?.decision === "not-relevant").length,
    review: listings.filter((item) => item.evaluation?.decision === "review").length,
    unevaluated: listings.filter((item) => !item.evaluation).length,
  }), [listings]);
  const criteria = useMemo(() => criteriaCoverage(listings, recipes.flatMap((recipe) => recipe.criteria)), [listings, recipes]);
  const error = listingsQuery.error || recipesQuery.error || activeRecipeQuery.error;
  const loading = listingsQuery.isLoading || recipesQuery.isLoading || activeRecipeQuery.isLoading;

  if (error) return <ScoringState kind="error" retry={() => void Promise.all([listingsQuery.refetch(), recipesQuery.refetch(), activeRecipeQuery.refetch()])} />;
  if (loading) return <ScoringState kind="loading" />;

  return (
    <section className={styles.view} aria-labelledby="scorings-view-title">
      <aside className={styles.groups}>
        <div className={styles.panelIntro}>
          <SectionLabel>{t("scorings.evaluations")}</SectionLabel>
          <h1 id="scorings-view-title">{t("scorings.title")}</h1>
          <span>{t("scorings.listingCount", { count: listings.length })}</span>
        </div>
        <nav className={styles.groupList} aria-label={t("scorings.decisionFilters")}>
          {(["all", "relevant", "not-relevant", "review", "unevaluated"] as const).map((item) => (
            <button key={item} className={decision === item ? styles.groupActive : ""} type="button" onClick={() => setDecision(item)} aria-pressed={decision === item}>
              <span>{item === "all" ? t("scorings.all") : t(`decision.${item}` as Parameters<typeof t>[0])}</span>
              <b>{item === "all" ? listings.length : counts[item]}</b>
            </button>
          ))}
        </nav>
        <div className={styles.coveragePanel}>
          <SectionLabel>{t("scorings.activeRecipe")}</SectionLabel>
          {activeRecipeQuery.data ? <><strong>{activeRecipeQuery.data.name}</strong><span>v{activeRecipeQuery.data.version} · {activeRecipeQuery.data.threshold}/100</span></> : <span>{t("builder.noActiveRecipe")}</span>}
        </div>
      </aside>

      <div className={styles.index}>
        <header className={styles.indexHeader}><SectionLabel>{t("scorings.results")}</SectionLabel><span>{filtered.length}</span></header>
        {filtered.length === 0 ? <EmptyState>{t("scorings.empty")}</EmptyState> : (
          <div className={styles.metricList}>
            {filtered.map((listing) => <EvaluationListItem key={listing.key} listing={listing} active={selected?.key === listing.key} onClick={() => setSelectedKey(listing.key)} />)}
          </div>
        )}
      </div>

      <article className={styles.docs}>
        <div className={styles.docBody}>
          <section className={styles.summaryGrid} aria-label={t("scorings.coverageSummary")}>
            <SummaryCard label={t("decision.relevant")} value={counts.relevant} tone="good" />
            <SummaryCard label={t("decision.not-relevant")} value={counts["not-relevant"]} tone="danger" />
            <SummaryCard label={t("decision.review")} value={counts.review} tone="sunset" />
            <SummaryCard label={t("decision.unevaluated")} value={counts.unevaluated} />
          </section>

          <section className={styles.coverageSection}>
            <div className={styles.boxHeader}><SectionLabel>{t("scorings.criteriaCoverage")}</SectionLabel><span>{criteria.length}</span></div>
            {criteria.length === 0 ? <p>{t("scorings.noCriteriaEvidence")}</p> : criteria.map((item) => (
              <div key={item.id} className={styles.criterionCoverage}>
                <div><strong>{item.name}</strong><span>{t("scorings.covered", { count: item.evaluated, total: item.total })}</span></div>
                <Meter value={item.evaluated} max={Math.max(item.total, 1)} tone={item.evaluated === item.total ? "good" : "default"} />
              </div>
            ))}
          </section>

          {selected ? <EvaluationDocs listing={selected} /> : <EmptyState>{t("scorings.empty")}</EmptyState>}
        </div>
      </article>
    </section>
  );
}

function EvaluationListItem({ listing, active, onClick }: { listing: PropertyListing; active: boolean; onClick: () => void }) {
  const { locale, t } = useAppIntl();
  const evaluation = listing.evaluation;
  const Icon = evaluation?.decision === "relevant" ? CheckCircle2 : evaluation?.decision === "not-relevant" ? MinusCircle : evaluation ? CircleHelp : AlertCircle;
  return (
    <button type="button" className={[styles.metricItem, active ? styles.metricItemActive : ""].join(" ")} onClick={onClick} aria-pressed={active}>
      <span className={styles.metricIcon}><Icon size={18} aria-hidden="true" /></span>
      <span className={styles.metricCopy}>
        <strong>{listing.title ?? listing.externalId}</strong>
        <small>{evaluation ? `${t(`decision.${evaluation.decision}` as Parameters<typeof t>[0])} · ${evaluation.score === null ? t("common.unavailable") : `${formatDecimal(evaluation.score, locale)} / 100`}` : t("decision.unevaluated")}</small>
      </span>
    </button>
  );
}

function EvaluationDocs({ listing }: { listing: PropertyListing }) {
  const { locale, t } = useAppIntl();
  const evaluation = listing.evaluation;
  if (!evaluation) return <section className={styles.evaluationDocs}><h2>{listing.title ?? listing.externalId}</h2><EmptyState>{t("properties.notEvaluated")}</EmptyState></section>;
  return (
    <section className={styles.evaluationDocs}>
      <header className={styles.docHeader}>
        <div className={styles.docIcon}><Sparkles size={28} aria-hidden="true" /></div>
        <div><div className={styles.tagRow}><DecisionChip decision={evaluation.decision} /><Chip>{evaluation.recipeId} · v{evaluation.recipeVersion}</Chip></div><h2>{listing.title ?? listing.externalId}</h2></div>
      </header>
      <div className={styles.scoreSummary}><strong>{evaluation.score === null ? t("common.unavailable") : `${formatDecimal(evaluation.score, locale)} / 100`}</strong>{evaluation.score !== null && <Meter value={evaluation.score} max={100} />}</div>
      <p className={styles.lede}>{evaluation.summary}</p>
      <div className={styles.criteriaResults}>
        {evaluation.criteria.map((criterion) => (
          <article key={criterion.criterionId}>
            <div className={styles.boxHeader}><strong>{criterion.criterionId}</strong><Chip tone={criterion.verdict === "pass" ? "good" : criterion.verdict === "fail" ? "danger" : "sunset"}>{t(`decision.${criterion.verdict}` as Parameters<typeof t>[0])}</Chip></div>
            <p>{criterion.reason}</p>
            {criterion.evidence.length > 0 ? <ul>{criterion.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul> : <span className={styles.muted}>{t("scorings.noEvidence")}</span>}
          </article>
        ))}
      </div>
      <footer className={styles.docFooter}>
        <div><SectionLabel>{t("properties.run")}</SectionLabel><span>{evaluation.runId}</span></div>
        <div><SectionLabel>{t("scorings.missingData")}</SectionLabel><span>{evaluation.missingData.length ? evaluation.missingData.join(", ") : t("scorings.none")}</span></div>
        <div><SectionLabel>{t("scorings.evaluatedAt")}</SectionLabel><span>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(evaluation.evaluatedAt))}</span></div>
        <div><SectionLabel>{t("scorings.model")}</SectionLabel><span>{evaluation.evaluator?.model ?? t("common.unavailable")}</span></div>
      </footer>
    </section>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: "good" | "danger" | "sunset" }) {
  return <div className={styles.summaryCard}><Chip tone={tone}>{label}</Chip><strong>{value}</strong></div>;
}

function DecisionChip({ decision }: { decision: ListingDecision }) {
  const { t } = useAppIntl();
  return <Chip active tone={decision === "relevant" ? "good" : decision === "not-relevant" ? "danger" : "sunset"}>{t(`decision.${decision}` as Parameters<typeof t>[0])}</Chip>;
}

function ScoringState({ kind, retry }: { kind: "loading" | "error"; retry?: () => void }) {
  const { t } = useAppIntl();
  return <EmptyState role={kind === "error" ? "alert" : "status"}><div className={styles.stateContent}><strong>{t(kind === "error" ? "scorings.error" : "scorings.loading")}</strong>{retry && <Button onClick={retry}>{t("common.retry")}</Button>}</div></EmptyState>;
}

function criteriaCoverage(listings: PropertyListing[], configured: IntelligenceCriterion[]) {
  const names = new Map(configured.map((criterion) => [criterion.id, criterion.name]));
  const ids = new Set<string>(configured.map((criterion) => criterion.id));
  listings.forEach((listing) => listing.evaluation?.criteria.forEach((criterion) => ids.add(criterion.criterionId)));
  const evaluatedListings = listings.filter((listing) => listing.evaluation);
  return Array.from(ids).map((id) => ({
    id,
    name: names.get(id) ?? id,
    evaluated: evaluatedListings.filter((listing) => listing.evaluation?.criteria.some((criterion) => criterion.criterionId === id && criterion.verdict !== "unknown")).length,
    total: evaluatedListings.length,
  }));
}
