import { describe, expect, it } from "vitest";

import type { ListingDecision, Locale } from "../src/contracts.js";
import { combineEvaluationExecutionListing } from "../src/evaluationCombiner.js";
import type { StoredExecutionStep } from "../src/repository.js";

const EVALUATED_AT = new Date("2026-07-19T10:00:00.000Z");
const EVALUATOR = { provider: "openai" as const, model: "gpt-test", version: "3.0.0" };

describe("combineEvaluationExecutionListing", () => {
  it("applies ALL dominance and the minimum complete score", () => {
    const result = combine("all", "en", [success("relevant", 90), success("not-relevant", 30)]);

    expect(result).toMatchObject({ decision: "not-relevant", score: 30 });
    expect(result.summary).toBe("ALL: not relevant. 1 relevant, 1 not relevant, 0 review, 0 error.");
  });

  it("applies ANY dominance while making an incomplete score null", () => {
    const result = combine("any", "fr", [success("relevant", 80), failure()]);

    expect(result).toMatchObject({ decision: "relevant", score: null });
    expect(result.summary).toBe("AU MOINS UNE: pertinent. 1 pertinent, 0 non pertinent, 0 a revoir, 1 erreur.");
  });

  it("returns review for an unknown branch that has no dominant decision", () => {
    expect(combine("all", "es", [success("relevant", 90), success("review", null)])).toMatchObject({
      decision: "review",
      score: null,
      summary: "TODAS: a revisar. 1 relevante, 0 no relevante, 1 a revisar, 0 error.",
    });
    expect(combine("any", "en", [success("not-relevant", 10), failure()]).decision).toBe("review");
  });
});

function combine(
  operator: "all" | "any",
  locale: Locale,
  steps: readonly StoredExecutionStep[],
) {
  return combineEvaluationExecutionListing({
    executionId: "execution-1",
    listingId: "leboncoin:2876543210",
    planId: "plan-1",
    planVersion: 1,
    locale,
    operator,
    steps,
    evaluatedAt: EVALUATED_AT,
  });
}

function success(decision: ListingDecision, score: number | null): StoredExecutionStep {
  return {
    recipeId: `recipe-${decision}`,
    recipeVersion: 1,
    status: "succeeded",
    evaluator: EVALUATOR,
    evaluation: {
      listingId: "leboncoin:2876543210",
      decision,
      score,
      summary: "Step result.",
      criteria: [{
        criterionId: "garden",
        verdict: decision === "relevant" ? "pass" : decision === "not-relevant" ? "fail" : "unknown",
        reason: "Deterministic test result.",
        evidence: decision === "review" ? [] : ["Garden"],
      }],
      missingData: [],
      evaluatedAt: EVALUATED_AT.toISOString(),
    },
  };
}

function failure(): StoredExecutionStep {
  return {
    recipeId: "recipe-failed",
    recipeVersion: 1,
    status: "failed",
    error: {
      code: "EVALUATION_FAILED",
      stage: "provider",
      retryable: true,
      requestId: "request-1",
    },
  };
}
