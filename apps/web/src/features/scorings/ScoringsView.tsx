import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Clock3,
  MinusCircle,
  Play,
  RefreshCw,
  Sparkles,
  Square,
} from "lucide-react";
import { Button, Chip, EmptyState, Meter, SectionLabel } from "@denicheur-breizh/design-system";
import {
  createIdempotencyKey,
  isExecutionTerminal,
  useCancelEvaluationExecution,
  useDefaultEvaluationPlan,
  useEvaluationExecution,
  useEvaluationExecutionResults,
  useEvaluationExecutions,
  useEvaluationPlans,
  useListings,
  useRecipes,
  useRetryEvaluationExecution,
  useRun,
  useRuns,
  useStartEvaluationExecution,
} from "../../api/hooks";
import { useAppIntl } from "../../intl/IntlContext";
import type {
  EvaluationExecution,
  EvaluationExecutionResult,
  EvaluationExecutionStepResult,
  EvaluationPlan,
  IntelligenceRecipe,
  ListingDecision,
} from "../../types";
import { formatDecimal } from "../../utils/format";
import { enumUrlCodec, stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./ScoringsView.module.css";

type DecisionFilter = "all" | ListingDecision;
const decisionCodec = enumUrlCodec<DecisionFilter>(["all", "relevant", "not-relevant", "review"]);

export function ScoringsView() {
  const { locale, t } = useAppIntl();
  const plansQuery = useEvaluationPlans();
  const defaultPlanQuery = useDefaultEvaluationPlan();
  const recipesQuery = useRecipes();
  const runsQuery = useRuns();
  const executionsQuery = useEvaluationExecutions();
  const plans = plansQuery.data ?? [];
  const recipes = recipesQuery.data ?? [];
  const completedRuns = (runsQuery.data?.items ?? []).filter((run) => run.status === "completed");
  const executions = executionsQuery.data?.items ?? [];
  const [planKey, setPlanKey] = useUrlState("spid", "", stringUrlCodec);
  const selectedPlan = plans.find((plan) => evaluationPlanKey(plan) === planKey)
    ?? plans.find((plan) => plan.isDefault)
    ?? defaultPlanQuery.data
    ?? plans[0];
  const planExecutions = selectedPlan
    ? executions.filter((execution) => execution.planId === selectedPlan.id && execution.planVersion === selectedPlan.version)
    : [];
  const [executionId, setExecutionId] = useUrlState("seid", "", stringUrlCodec);
  const selectedExecutionId = executionId || planExecutions[0]?.id;
  const listedExecution = planExecutions.find((candidate) => candidate.id === selectedExecutionId);
  const executionQuery = useEvaluationExecution(selectedExecutionId);
  const execution = executionQuery.data ?? listedExecution;
  const resultsQuery = useEvaluationExecutionResults(execution?.id, execution?.status);
  const results = resultsQuery.data?.items ?? [];
  const [runId, setRunId] = useUrlState("srun", "", stringUrlCodec);
  const selectedRun = completedRuns.find((run) => run.id === runId) ?? completedRuns[0];
  const runDetailQuery = useRun(selectedRun?.id);
  const hasDetailedSnapshots = (runDetailQuery.data?.detailedListingCount ?? 0) > 0;
  const listingsQuery = useListings(execution ? { runId: execution.runId, limit: 100 } : undefined);
  const listingNames = useMemo(() => new Map(
    (listingsQuery.data?.items ?? []).map((listing) => [listing.key, listing.title ?? listing.externalId]),
  ), [listingsQuery.data?.items]);
  const [decision, setDecision] = useUrlState<DecisionFilter>("sdecision", "all", decisionCodec);
  const filteredResults = results.filter((result) => decision === "all" || result.decision === decision);
  const [listingId, setListingId] = useUrlState("sid", "", stringUrlCodec);
  const selectedResult = filteredResults.find((result) => result.listingId === listingId) ?? filteredResults[0];
  const [force, setForce] = useState(false);
  const startExecution = useStartEvaluationExecution();
  const retryExecution = useRetryEvaluationExecution();
  const cancelExecution = useCancelEvaluationExecution();

  useEffect(() => {
    if (selectedPlan && planKey !== evaluationPlanKey(selectedPlan)) setPlanKey(evaluationPlanKey(selectedPlan));
  }, [planKey, selectedPlan, setPlanKey]);

  useEffect(() => {
    if (!executionId && planExecutions[0]) setExecutionId(planExecutions[0].id);
  }, [executionId, planExecutions, setExecutionId]);

  useEffect(() => {
    if (selectedRun && runId !== selectedRun.id) setRunId(selectedRun.id);
  }, [runId, selectedRun, setRunId]);

  useEffect(() => {
    if (selectedResult && listingId !== selectedResult.listingId) setListingId(selectedResult.listingId);
    if (!selectedResult && listingId) setListingId("");
  }, [listingId, selectedResult, setListingId]);

  const loading = plansQuery.isLoading || defaultPlanQuery.isLoading || recipesQuery.isLoading || runsQuery.isLoading || executionsQuery.isLoading;
  const error = plansQuery.error || defaultPlanQuery.error || recipesQuery.error || runsQuery.error || executionsQuery.error;
  if (loading) return <ScoringState copy={t("scorings.loading")} />;
  if (error) return <ScoringState copy={t("scorings.error")} retry={() => void Promise.all([plansQuery.refetch(), defaultPlanQuery.refetch(), recipesQuery.refetch(), runsQuery.refetch(), executionsQuery.refetch()])} />;

  const launch = () => {
    if (!selectedPlan || !selectedRun || !hasDetailedSnapshots) return;
    startExecution.mutate({
      runId: selectedRun.id,
      planId: selectedPlan.id,
      planVersion: selectedPlan.version,
      locale,
      force,
      idempotencyKey: createIdempotencyKey(),
    }, { onSuccess: (created) => setExecutionId(created.id) });
  };

  const retry = () => {
    if (!execution) return;
    retryExecution.mutate({ id: execution.id, idempotencyKey: createIdempotencyKey() }, {
      onSuccess: (created) => setExecutionId(created.id),
    });
  };

  const selectPlan = (value: string) => {
    setPlanKey(value);
    setExecutionId("");
    setListingId("");
  };

  const counts = decisionCounts(results);
  return (
    <section className={styles.view} aria-labelledby="scorings-view-title">
      <aside className={styles.controlPanel}>
        <div className={styles.panelHeader}>
          <SectionLabel>{t("scorings.evaluations")}</SectionLabel>
          <h1 id="scorings-view-title">{t("scorings.title")}</h1>
          <span>{t("scorings.executionCount", { count: executions.length })}</span>
        </div>

        <section className={styles.controlSection}>
          <label><SectionLabel>{t("scorings.planVersion")}</SectionLabel><select value={selectedPlan ? evaluationPlanKey(selectedPlan) : ""} onChange={(event) => selectPlan(event.target.value)} disabled={plans.length === 0}><option value="">{t("scorings.noPlan")}</option>{groupPlanOptions(plans).map((family) => <optgroup key={family.id} label={family.name}>{family.versions.map((plan) => <option key={evaluationPlanKey(plan)} value={evaluationPlanKey(plan)}>{plan.name} · v{plan.version}{plan.isDefault ? ` · ${t("scorings.default")}` : ""}</option>)}</optgroup>)}</select></label>
          {selectedPlan && <div className={styles.planSummary}><span><strong>{t(`builder.operator.${selectedPlan.operator}`)}</strong><small>{selectedPlan.recipes.map((reference) => `${reference.recipeId}@v${reference.recipeVersion}`).join(" · ")}</small></span>{selectedPlan.isDefault && <Chip active tone="good">{t("scorings.default")}</Chip>}</div>}
        </section>

        <section className={styles.controlSection}>
          <label><SectionLabel>{t("scorings.completedRun")}</SectionLabel><select value={selectedRun?.id ?? ""} onChange={(event) => setRunId(event.target.value)} disabled={completedRuns.length === 0}><option value="">{t("scorings.noCompletedRuns")}</option>{completedRuns.map((run) => <option key={run.id} value={run.id}>{run.id} · {formatDate(run.finishedAt ?? run.updatedAt, locale)}</option>)}</select></label>
          <label className={styles.forceToggle}><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />{t("scorings.force")}</label>
          <Button variant="primary" onClick={launch} disabled={!selectedPlan || !selectedRun || !hasDetailedSnapshots || runDetailQuery.isLoading || startExecution.isPending}><Play size={14} aria-hidden="true" />{startExecution.isPending ? t("scorings.starting") : t("scorings.start")}</Button>
          {selectedRun && !runDetailQuery.isLoading && !hasDetailedSnapshots && <p className={styles.error} role="alert">{t("scorings.noDetailedSnapshots")}</p>}
          {runDetailQuery.isError && <p className={styles.error} role="alert">{t("scorings.runDetailError")}</p>}
          {startExecution.isError && <p className={styles.error} role="alert">{t("scorings.startError")}</p>}
        </section>

        <section className={styles.executionShelf}>
          <SectionLabel>{t("scorings.executions")}</SectionLabel>
          {planExecutions.length === 0 ? <p>{t("scorings.noExecutions")}</p> : planExecutions.map((item) => <button type="button" key={item.id} className={execution?.id === item.id ? styles.executionActive : ""} onClick={() => setExecutionId(item.id)}><ExecutionStatusIcon status={item.status} /><span><strong>{formatDate(item.createdAt, locale)}</strong><small>{t(`scorings.status.${item.status}`)} · {item.counters.processed}/{item.counters.total}</small></span></button>)}
        </section>
      </aside>

      <div className={styles.resultIndex}>
        <header className={styles.executionHeader}>
          <div><SectionLabel>{t("scorings.currentExecution")}</SectionLabel><strong>{execution?.id ?? t("scorings.noExecutions")}</strong></div>
          {execution && <div className={styles.executionActions}><Chip tone={executionTone(execution.status)}>{t(`scorings.status.${execution.status}`)}</Chip>{!isExecutionTerminal(execution.status) && <Button size="sm" onClick={() => cancelExecution.mutate(execution.id)} disabled={cancelExecution.isPending}><Square size={13} aria-hidden="true" />{t("scorings.cancel")}</Button>}{(execution.status === "failed" || execution.status === "partial" || execution.status === "cancelled") && <Button size="sm" onClick={retry} disabled={retryExecution.isPending}><RefreshCw size={13} aria-hidden="true" />{t("common.retry")}</Button>}</div>}
        </header>

        {execution && <ExecutionProgress execution={execution} />}
        {(executionQuery.error || resultsQuery.error || cancelExecution.isError || retryExecution.isError) && <p className={styles.error} role="alert">{t("scorings.executionError")}</p>}
        <nav className={styles.decisionFilters} aria-label={t("scorings.decisionFilters")}>{(["all", "relevant", "not-relevant", "review"] as const).map((item) => <button type="button" key={item} className={decision === item ? styles.filterActive : ""} aria-pressed={decision === item} onClick={() => setDecision(item)}><span>{item === "all" ? t("scorings.all") : t(`decision.${item}`)}</span><b>{item === "all" ? results.length : counts[item]}</b></button>)}</nav>

        <div className={styles.resultList}>
          {filteredResults.length === 0 ? <EmptyState>{execution && !isExecutionTerminal(execution.status) ? t("scorings.awaitingResults") : t("scorings.empty")}</EmptyState> : filteredResults.map((result) => <ResultListItem key={result.listingId} result={result} title={listingNames.get(result.listingId)} active={selectedResult?.listingId === result.listingId} onClick={() => setListingId(result.listingId)} />)}
        </div>
      </div>

      <article className={styles.resultDetail}>
        {selectedResult ? <ExecutionResultDetail result={selectedResult} recipes={recipes} title={listingNames.get(selectedResult.listingId)} /> : <EmptyState>{t("scorings.empty")}</EmptyState>}
      </article>
    </section>
  );
}

function ExecutionProgress({ execution }: { execution: EvaluationExecution }) {
  const { t } = useAppIntl();
  const counters = execution.counters;
  return <section className={styles.progress} aria-label={t("scorings.progress")}> <div><span>{t("scorings.processed", { count: counters.processed, total: counters.total })}</span><strong>{counters.total ? `${Math.round((counters.processed / counters.total) * 100)}%` : "0%"}</strong></div><Meter value={counters.processed} max={Math.max(counters.total, 1)} /><div className={styles.counterGrid}><Counter label={t("decision.relevant")} value={counters.relevant} /><Counter label={t("decision.not-relevant")} value={counters.notRelevant} /><Counter label={t("decision.review")} value={counters.review} /><Counter label={t("scorings.failed")} value={counters.failed} /></div></section>;
}

function ResultListItem({ result, title, active, onClick }: { result: EvaluationExecutionResult; title?: string; active: boolean; onClick: () => void }) {
  const { locale, t } = useAppIntl();
  const Icon = decisionIcon(result.decision);
  return <button type="button" className={active ? styles.resultActive : ""} onClick={onClick} aria-pressed={active}><Icon size={17} aria-hidden="true" /><span><strong>{title ?? result.listingId}</strong><small>{t(`decision.${result.decision}`)} · {result.score === null ? t("common.unavailable") : `${formatDecimal(result.score, locale)} / 100`}</small></span></button>;
}

function ExecutionResultDetail({ result, recipes, title }: { result: EvaluationExecutionResult; recipes: IntelligenceRecipe[]; title?: string }) {
  const { locale, t } = useAppIntl();
  return <div className={styles.detailScroll}>
    <header className={styles.detailHeader}><span className={styles.detailIcon}><Sparkles size={25} aria-hidden="true" /></span><div><div className={styles.tagRow}><DecisionChip decision={result.decision} /><Chip>{result.planId} · v{result.planVersion}</Chip></div><h2>{title ?? result.listingId}</h2></div></header>
    <section className={styles.aggregate}><SectionLabel>{t("scorings.aggregate")}</SectionLabel><strong>{result.score === null ? t("common.unavailable") : `${formatDecimal(result.score, locale)} / 100`}</strong>{result.score !== null && <Meter value={result.score} max={100} />}<p>{result.summary}</p></section>
    <section className={styles.steps}><div className={styles.sectionHeading}><div><SectionLabel>{t("scorings.recipeBreakdown")}</SectionLabel><h3>{t("scorings.stepCount", { count: result.steps.length })}</h3></div></div>{result.steps.map((step) => <RecipeStep key={`${step.recipeId}:${step.recipeVersion}`} step={step} recipe={recipes.find((candidate) => candidate.id === step.recipeId && candidate.version === step.recipeVersion)} />)}</section>
    <footer className={styles.detailFooter}><div><SectionLabel>{t("scorings.executionId")}</SectionLabel><span>{result.executionId}</span></div><div><SectionLabel>{t("scorings.evaluatedAt")}</SectionLabel><span>{formatDate(result.evaluatedAt, locale)}</span></div></footer>
  </div>;
}

function RecipeStep({ step, recipe }: { step: EvaluationExecutionStepResult; recipe?: IntelligenceRecipe }) {
  const { locale, t } = useAppIntl();
  const namespace = `${step.recipeId}@v${step.recipeVersion}`;
  return <article className={styles.stepCard}>
    <header><span><strong>{recipe?.name ?? step.recipeId}</strong><small>{namespace}</small></span><Chip tone={step.status === "failed" ? "danger" : step.status === "skipped" ? "sunset" : "good"}>{t(`scorings.step.${step.status}`)}</Chip></header>
    {step.status === "succeeded" || step.status === "cached" ? <>
      <div className={styles.stepDecision}><DecisionChip decision={step.evaluation.decision} /><strong>{step.evaluation.score === null ? t("common.unavailable") : `${formatDecimal(step.evaluation.score, locale)} / 100`}</strong></div>
      <p>{step.evaluation.summary}</p>
      <div className={styles.missing}><SectionLabel>{t("scorings.model")}</SectionLabel><span>{step.evaluator.model} · {step.evaluator.version}</span></div>
      <div className={styles.criteria}>{step.evaluation.criteria.map((criterion) => <article key={`${namespace}/${criterion.criterionId}`}><header><code>{namespace}/{criterion.criterionId}</code><Chip tone={criterion.verdict === "pass" ? "good" : criterion.verdict === "fail" ? "danger" : "sunset"}>{t(`decision.${criterion.verdict}`)}</Chip></header><p>{criterion.reason}</p>{criterion.evidence.length ? <ul>{criterion.evidence.map((evidence, index) => <li key={`${index}-${evidence}`}>{evidence}</li>)}</ul> : <span className={styles.muted}>{t("scorings.noEvidence")}</span>}</article>)}</div>
      {step.evaluation.missingData.length > 0 && <div className={styles.missing}><SectionLabel>{t("scorings.missingData")}</SectionLabel><span>{step.evaluation.missingData.join(", ")}</span></div>}
    </> : <p className={styles.stepError}>{step.status === "failed" ? formatStepError(step.error) : t("scorings.skipped")}</p>}
  </article>;
}

function DecisionChip({ decision }: { decision: ListingDecision }) {
  const { t } = useAppIntl();
  return <Chip active tone={decision === "relevant" ? "good" : decision === "not-relevant" ? "danger" : "sunset"}>{t(`decision.${decision}`)}</Chip>;
}

function Counter({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function ScoringState({ copy, retry }: { copy: string; retry?: () => void }) {
  const { t } = useAppIntl();
  return <EmptyState role={retry ? "alert" : "status"}><div className={styles.state}><h1>{t("scorings.title")}</h1><p>{copy}</p>{retry && <Button onClick={retry}>{t("common.retry")}</Button>}</div></EmptyState>;
}

function ExecutionStatusIcon({ status }: { status: EvaluationExecution["status"] }) {
  const Icon = status === "completed" ? CheckCircle2 : status === "failed" || status === "cancelled" ? AlertCircle : status === "partial" ? CircleHelp : Clock3;
  return <Icon size={15} aria-hidden="true" />;
}

function decisionIcon(decision: ListingDecision) {
  return decision === "relevant" ? CheckCircle2 : decision === "not-relevant" ? MinusCircle : CircleHelp;
}

function decisionCounts(results: EvaluationExecutionResult[]) {
  return {
    relevant: results.filter((result) => result.decision === "relevant").length,
    "not-relevant": results.filter((result) => result.decision === "not-relevant").length,
    review: results.filter((result) => result.decision === "review").length,
  };
}

function executionTone(status: EvaluationExecution["status"]): "good" | "danger" | "sunset" | undefined {
  if (status === "completed") return "good";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "partial") return "sunset";
  return undefined;
}

function evaluationPlanKey(plan: Pick<EvaluationPlan, "id" | "version">): string {
  return `${plan.id}:${plan.version}`;
}

function groupPlanOptions(plans: EvaluationPlan[]) {
  const groups = new Map<string, EvaluationPlan[]>();
  plans.forEach((plan) => groups.set(plan.id, [...(groups.get(plan.id) ?? []), plan]));
  return Array.from(groups, ([id, versions]) => ({ id, name: versions[0]?.name ?? id, versions: versions.sort((left, right) => right.version - left.version) }));
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatStepError(error: unknown): string {
  if (!error || typeof error !== "object") return "Evaluation failed";
  const candidate = error as Record<string, unknown>;
  return [candidate.code, candidate.stage].filter((value): value is string => typeof value === "string").join(" · ") || "Evaluation failed";
}
