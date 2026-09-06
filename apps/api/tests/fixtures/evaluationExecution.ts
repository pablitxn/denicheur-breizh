import type { EvaluationExecutionListingResult } from "../../src/contracts.js";
import type { DenicheurRepository } from "../../src/repository.js";

export const EXECUTION_NOW = "2026-09-06T10:00:00.000Z";

export function seedExecution(repository: DenicheurRepository, count = 3, id = "execution") {
  const listingIds = Array.from({ length: count }, (_, index) => `leboncoin:${index}`);
  repository.ingest({
    run: { id: "run", source: "leboncoin", status: "completed" },
    listings: listingIds.map((_, index) => ({ source: "leboncoin", externalId: String(index),
      url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${index}`, status: "detailed", scrapedAt: EXECUTION_NOW })),
  });
  if (!repository.getRecipe("recipe", 1)) repository.saveRecipe("recipe", {
    name: "Synthetic", threshold: 50,
    criteria: [{ id: "garden", name: "Garden", description: "Has garden", weight: 1, required: false }],
  });
  if (!repository.getEvaluationPlan("plan", 1)) repository.saveEvaluationPlan("plan", {
    name: "Synthetic", operator: "all", recipes: [{ recipeId: "recipe", recipeVersion: 1 }],
  });
  repository.createEvaluationExecution({
    id, runId: "run", request: { planId: "plan", planVersion: 1, locale: "fr", listingIds }, listingIds,
    idempotencyKey: `${id}-key`, requestFingerprint: `${id}-fingerprint`,
    budget: {
      limit: { providerCalls: 100, inputTokens: 1_000_000, outputTokens: 1_000_000, costMicroUsd: 3_000_000 },
      estimate: { providerCalls: 1, inputTokens: 1000, outputTokens: 1000, costMicroUsd: 100 },
      consumed: { providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    },
  });
  return listingIds;
}

export function executionResult(index: number, decision: EvaluationExecutionListingResult["decision"] = "relevant", failed = false, executionId = "execution"): EvaluationExecutionListingResult {
  return {
    executionId, listingId: `leboncoin:${index}`, planId: "plan", planVersion: 1,
    decision, score: decision === "review" ? null : 80, summary: "Synthetic result", evaluatedAt: EXECUTION_NOW,
    steps: [failed ? { recipeId: "recipe", recipeVersion: 1, status: "failed",
      error: { code: "SYNTHETIC", requestId: "synthetic", stage: "provider", retryable: false },
    } : { recipeId: "recipe", recipeVersion: 1, status: "skipped" }],
  };
}
