import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationExecutionCreateRequest,
  EvaluationExecutionRecord,
  ListingRecord,
  ResolvedEvaluationPlanVersion,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import type { EvaluationBudgetPolicy } from "../src/evaluationBudget.js";
import { calculateCostMicroUsd } from "../src/evaluationBudget.js";
import { EvaluationExecutionService } from "../src/evaluationExecutionService.js";
import { DenicheurRepository, type CreateEvaluationExecutionInput } from "../src/repository.js";

const NOW = "2026-08-11T10:00:00.000Z";

describe("evaluation execution budget preflight", () => {
  it("saturates an exact micro-USD calculation that exceeds the safe integer range", () => {
    expect(calculateCostMicroUsd(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      {
        inputPriceMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER,
        outputPriceMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER,
      },
    )).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects an image-fallback worst case before persisting or kicking the worker", () => {
    const listing = createListingWithImage();
    const persistExecution = vi.fn();
    const repository = {
      replayEvaluationExecution: vi.fn(() => undefined),
      getRunListingIds: vi.fn(() => [listing.id]),
      getResolvedEvaluationPlan: vi.fn(() => createResolvedPlan()),
      getListingsForEvaluation: vi.fn(() => [listing]),
      createEvaluationExecution: persistExecution,
    } as unknown as DenicheurRepository;
    const kick = vi.fn();
    const service = new EvaluationExecutionService(repository, { kick });
    const request: EvaluationExecutionCreateRequest = {
      planId: "plan-1",
      planVersion: 1,
      locale: "fr",
      budget: { maxProviderCalls: 3 },
    };

    const error = captureApiError(() => service.create("run-1", request, "idempotency-budget-1"));

    expect(error).toMatchObject({
      statusCode: 422,
      code: "EVALUATION_EXECUTION_BUDGET_EXCEEDED",
    });
    expect(persistExecution).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("keeps retry within the original effective limits while allowing current policy to reduce them", () => {
    const listing = createListing();
    const original = createFailedExecution(listing.id);
    const persistExecution = vi.fn((_input: CreateEvaluationExecutionInput) => ({ execution: original, created: true }));
    const repository = {
      getEvaluationExecution: vi.fn(() => original),
      replayEvaluationExecution: vi.fn(() => undefined),
      getResolvedEvaluationPlan: vi.fn(() => createResolvedPlan()),
      getListingsForEvaluation: vi.fn(() => [listing]),
      createEvaluationExecution: persistExecution,
    } as unknown as DenicheurRepository;
    const policy: EvaluationBudgetPolicy = {
      maxProviderCalls: 5,
      maxInputTokens: 200_000,
      maxOutputTokens: 40_000,
      maxCostMicroUsd: 500_000,
      inputPriceMicroUsdPerMillionTokens: 0,
      outputPriceMicroUsdPerMillionTokens: 0,
    };
    const service = new EvaluationExecutionService(repository, { kick: vi.fn() }, policy);

    service.retry(original.id, "idempotency-retry-budget-1");

    const persisted = persistExecution.mock.calls[0]![0];
    expect(persisted.request.budget).toEqual({
      maxProviderCalls: 7,
      maxInputTokens: 100_000,
      maxOutputTokens: 50_000,
      maxCostMicroUsd: 200_000,
    });
    expect(persisted.budget.limit).toEqual({
      providerCalls: 5,
      inputTokens: 100_000,
      outputTokens: 40_000,
      costMicroUsd: 200_000,
    });
  });
});

describe("durable provider-call budget", () => {
  it("persists actual overage truth and rejects every later reservation", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      repository.ingest({
        run: { id: "run-budget", source: "leboncoin", status: "completed" },
        listings: [{
          source: "leboncoin",
          externalId: "listing-budget",
          url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-budget",
          status: "detailed",
          scrapedAt: NOW,
        }],
      });
      const recipe = repository.saveRecipe("recipe-budget", {
        name: "Budget recipe",
        threshold: 70,
        criteria: [{
          id: "garden",
          name: "Garden",
          description: "The listing must explicitly mention a garden.",
          weight: 1,
          required: false,
        }],
      });
      const plan = repository.saveEvaluationPlan("plan-budget", {
        name: "Budget plan",
        operator: "all",
        recipes: [{ recipeId: recipe.id, recipeVersion: recipe.version }],
      });
      repository.createEvaluationExecution({
        id: "execution-budget",
        runId: "run-budget",
        request: {
          planId: plan.id,
          planVersion: plan.version,
          locale: "fr",
          listingIds: ["leboncoin:listing-budget"],
        },
        listingIds: ["leboncoin:listing-budget"],
        idempotencyKey: "budget-reservation-key",
        requestFingerprint: "budget-reservation-fingerprint",
        budget: {
          limit: { providerCalls: 2, inputTokens: 1_000, outputTokens: 1_000, costMicroUsd: 1_000 },
          estimate: { providerCalls: 1, inputTokens: 500, outputTokens: 500, costMicroUsd: 500 },
          consumed: { providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
        },
      });
      repository.claimNextEvaluationExecution("worker-budget", 60_000);
      const reservation = repository.reserveEvaluationProviderCall("execution-budget", "worker-budget", {
        providerCalls: 1,
        inputTokens: 600,
        outputTokens: 600,
        costMicroUsd: 600,
      });

      repository.settleEvaluationProviderCall("execution-budget", "worker-budget", reservation, {
        providerCalls: 1,
        inputTokens: 1_200,
        outputTokens: 100,
        costMicroUsd: 700,
      });
      repository.settleEvaluationProviderCall("execution-budget", "worker-budget", reservation, {
        providerCalls: 1,
        inputTokens: 1,
        outputTokens: 1,
        costMicroUsd: 1,
      });

      expect(repository.getEvaluationExecution("execution-budget")?.budget.consumed).toEqual({
        providerCalls: 1,
        inputTokens: 1_200,
        outputTokens: 100,
        costMicroUsd: 700,
      });
      expect(captureApiError(() => repository.reserveEvaluationProviderCall(
        "execution-budget",
        "worker-budget",
        { providerCalls: 1, inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
      ))).toMatchObject({ statusCode: 429, code: "EVALUATION_EXECUTION_BUDGET_EXHAUSTED" });
    } finally {
      repository.close();
    }
  });
});

function createListingWithImage(): ListingRecord {
  return {
    ...createListing(),
    imageUrls: ["https://img.leboncoin.fr/image-budget-fixture.jpg"],
  };
}

function createListing(): ListingRecord {
  return {
    source: "leboncoin",
    externalId: "listing-1",
    id: "leboncoin:listing-1",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
    status: "detailed",
    scrapedAt: NOW,
    lastRunId: "run-1",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    updatedAt: NOW,
  };
}

function createFailedExecution(listingId: string): EvaluationExecutionRecord {
  return {
    id: "execution-original",
    runId: "run-1",
    planId: "plan-1",
    planVersion: 1,
    locale: "fr",
    status: "failed",
    listingIds: [listingId],
    force: false,
    createdAt: NOW,
    completedAt: NOW,
    counters: { total: 1, processed: 1, relevant: 0, notRelevant: 0, review: 1, failed: 1 },
    budget: {
      limit: { providerCalls: 7, inputTokens: 100_000, outputTokens: 50_000, costMicroUsd: 200_000 },
      estimate: { providerCalls: 2, inputTokens: 10_000, outputTokens: 4_000, costMicroUsd: 0 },
      consumed: { providerCalls: 2, inputTokens: 5_000, outputTokens: 2_000, costMicroUsd: 0 },
    },
    error: "Provider failed.",
  };
}

function createResolvedPlan(): ResolvedEvaluationPlanVersion {
  return {
    id: "plan-1",
    version: 1,
    name: "Budget plan",
    operator: "all",
    recipes: [{
      recipeId: "recipe-1",
      recipeVersion: 1,
      recipe: {
        id: "recipe-1",
        version: 1,
        name: "Budget recipe",
        threshold: 70,
        criteria: [{
          id: "garden",
          name: "Garden",
          description: "The listing must explicitly mention a garden.",
          weight: 1,
          required: false,
        }],
        active: true,
        createdAt: NOW,
      },
    }],
    combinerVersion: "tri-state-v1",
    isDefault: true,
    createdAt: NOW,
  };
}

function captureApiError(action: () => unknown): ApiError {
  try {
    action();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("Expected an ApiError.");
}
