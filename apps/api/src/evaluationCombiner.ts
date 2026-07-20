import {
  evaluationExecutionListingResultSchema,
  type EvaluationExecutionListingResult,
  type EvaluationExecutionStepResult,
  type EvaluationPlanOperator,
  type Locale,
  type ListingDecision,
} from "./contracts.js";
import type { StoredExecutionStep } from "./repository.js";

export interface CombineEvaluationExecutionInput {
  readonly executionId: string;
  readonly listingId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly locale: Locale;
  readonly operator: EvaluationPlanOperator;
  readonly steps: readonly StoredExecutionStep[];
  readonly evaluatedAt: Date;
}

export function combineEvaluationExecutionListing(
  input: CombineEvaluationExecutionInput,
): EvaluationExecutionListingResult {
  const steps = input.steps.map(toPublicStep);
  const decisions = steps.map(stepDecision);
  const decision = combineDecision(input.operator, decisions);
  const scores = steps.map((step) => (
    step.status === "succeeded" || step.status === "cached" ? step.evaluation.score : null
  ));
  const score = scores.every((candidate): candidate is number => candidate !== null)
    ? input.operator === "all"
      ? Math.min(...scores)
      : Math.max(...scores)
    : null;

  return evaluationExecutionListingResultSchema.parse({
    executionId: input.executionId,
    listingId: input.listingId,
    planId: input.planId,
    planVersion: input.planVersion,
    decision,
    score,
    summary: localizedSummary(input.locale, input.operator, decision, steps),
    evaluatedAt: input.evaluatedAt.toISOString(),
    steps,
  });
}

function toPublicStep(step: StoredExecutionStep): EvaluationExecutionStepResult {
  if (step.status === "succeeded" || step.status === "cached") {
    return {
      recipeId: step.recipeId,
      recipeVersion: step.recipeVersion,
      status: step.status,
      evaluation: step.evaluation,
      evaluator: step.evaluator,
    };
  }
  if (step.status === "failed") {
    return {
      recipeId: step.recipeId,
      recipeVersion: step.recipeVersion,
      status: "failed",
      error: step.error,
    };
  }
  return {
    recipeId: step.recipeId,
    recipeVersion: step.recipeVersion,
    status: "skipped",
  };
}

function localizedSummary(
  locale: Locale,
  operator: EvaluationPlanOperator,
  decision: ListingDecision,
  steps: readonly EvaluationExecutionStepResult[],
): string {
  const relevant = steps.filter((step) => (
    step.status === "succeeded" || step.status === "cached"
  ) && step.evaluation.decision === "relevant").length;
  const notRelevant = steps.filter((step) => (
    step.status === "succeeded" || step.status === "cached"
  ) && step.evaluation.decision === "not-relevant").length;
  const review = steps.filter((step) => (
    step.status === "succeeded" || step.status === "cached"
  ) && step.evaluation.decision === "review").length;
  const error = steps.length - relevant - notRelevant - review;
  const translations = {
    fr: {
      operator: operator === "all" ? "TOUTES" : "AU MOINS UNE",
      decision: decision === "relevant" ? "pertinent" : decision === "not-relevant" ? "non pertinent" : "a revoir",
      relevant: "pertinent",
      notRelevant: "non pertinent",
      review: "a revoir",
      error: "erreur",
    },
    es: {
      operator: operator === "all" ? "TODAS" : "AL MENOS UNA",
      decision: decision === "relevant" ? "relevante" : decision === "not-relevant" ? "no relevante" : "a revisar",
      relevant: "relevante",
      notRelevant: "no relevante",
      review: "a revisar",
      error: "error",
    },
    en: {
      operator: operator === "all" ? "ALL" : "ANY",
      decision: decision === "relevant" ? "relevant" : decision === "not-relevant" ? "not relevant" : "review",
      relevant: "relevant",
      notRelevant: "not relevant",
      review: "review",
      error: "error",
    },
  } as const;
  const text = translations[locale];
  return `${text.operator}: ${text.decision}. ${relevant} ${text.relevant}, ${notRelevant} ${text.notRelevant}, ${review} ${text.review}, ${error} ${text.error}.`;
}

function stepDecision(step: EvaluationExecutionStepResult): ListingDecision | "unknown" {
  if (step.status === "failed" || step.status === "skipped") return "unknown";
  return step.evaluation.decision === "review" ? "unknown" : step.evaluation.decision;
}

function combineDecision(
  operator: EvaluationPlanOperator,
  decisions: readonly (ListingDecision | "unknown")[],
): ListingDecision {
  if (operator === "all") {
    if (decisions.includes("not-relevant")) return "not-relevant";
    return decisions.every((decision) => decision === "relevant") ? "relevant" : "review";
  }
  if (decisions.includes("relevant")) return "relevant";
  return decisions.every((decision) => decision === "not-relevant") ? "not-relevant" : "review";
}
