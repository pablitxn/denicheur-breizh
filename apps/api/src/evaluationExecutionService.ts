import { createHash, randomUUID } from "node:crypto";

import type {
  EvaluationExecutionCreateRequest,
  EvaluationExecutionRecord,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import {
  createEvaluationExecutionBudget,
  DEFAULT_EVALUATION_BUDGET_POLICY,
  exceedsUsage,
  type EvaluationBudgetPolicy,
} from "./evaluationBudget.js";
import type {
  CreateEvaluationExecutionResult,
  DenicheurRepository,
} from "./repository.js";

export interface EvaluationExecutionQueue {
  kick(): void;
}

export class EvaluationExecutionService {
  private readonly budgetPolicy: EvaluationBudgetPolicy;

  constructor(
    private readonly repository: DenicheurRepository,
    private readonly queue: EvaluationExecutionQueue,
    budgetPolicy: EvaluationBudgetPolicy = DEFAULT_EVALUATION_BUDGET_POLICY,
  ) {
    this.budgetPolicy = budgetPolicy;
  }

  create(
    runId: string,
    request: EvaluationExecutionCreateRequest,
    idempotencyKey: string,
  ): CreateEvaluationExecutionResult {
    const normalizedRequest = {
      ...request,
      force: request.force === true,
    };
    const requestFingerprint = fingerprint({ action: "create", runId, request: normalizedRequest });
    const replay = this.repository.replayEvaluationExecution(idempotencyKey, requestFingerprint);
    if (replay) return replay;
    const listingIds = request.listingIds ?? this.repository.getRunListingIds(runId) ?? [];
    const budget = this.prepareBudget(runId, request, listingIds);
    const result = this.repository.createEvaluationExecution({
      id: randomUUID(),
      runId,
      request,
      listingIds,
      idempotencyKey,
      requestFingerprint,
      budget,
    });
    if (result.created) this.queue.kick();
    return result;
  }

  retry(executionId: string, idempotencyKey: string): CreateEvaluationExecutionResult {
    const original = this.repository.getEvaluationExecution(executionId);
    if (!original) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    if (original.status !== "failed" && original.status !== "partial" && original.status !== "cancelled") {
      throw new ApiError(
        409,
        "EVALUATION_EXECUTION_NOT_RETRYABLE",
        "Only failed, partial, or cancelled evaluation executions can be retried.",
      );
    }
    const request: EvaluationExecutionCreateRequest = {
      planId: original.planId,
      planVersion: original.planVersion,
      locale: original.locale,
      listingIds: original.listingIds,
      force: false,
      budget: {
        maxProviderCalls: original.budget.limit.providerCalls,
        maxInputTokens: original.budget.limit.inputTokens,
        maxOutputTokens: original.budget.limit.outputTokens,
        maxCostMicroUsd: original.budget.limit.costMicroUsd,
      },
    };
    const requestFingerprint = fingerprint({ action: "retry", executionId, request });
    const replay = this.repository.replayEvaluationExecution(idempotencyKey, requestFingerprint);
    if (replay) return replay;
    const budget = this.prepareBudget(original.runId, request, original.listingIds);
    const result = this.repository.createEvaluationExecution({
      id: randomUUID(),
      runId: original.runId,
      request,
      listingIds: original.listingIds,
      idempotencyKey,
      requestFingerprint,
      budget,
      retryOfExecutionId: original.id,
    });
    if (result.created) this.queue.kick();
    return result;
  }

  cancel(executionId: string): EvaluationExecutionRecord {
    const execution = this.repository.requestEvaluationExecutionCancellation(executionId);
    if (!execution) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    return execution;
  }

  private prepareBudget(
    runId: string,
    request: EvaluationExecutionCreateRequest,
    listingIds: readonly string[],
  ) {
    const plan = this.repository.getResolvedEvaluationPlan(request.planId, request.planVersion);
    if (!plan) {
      throw new ApiError(404, "EVALUATION_PLAN_NOT_FOUND", "The requested evaluation plan version does not exist.");
    }
    if (listingIds.length === 0) {
      throw new ApiError(409, "RUN_HAS_NO_LISTINGS", "The requested run has no listings to evaluate.");
    }
    const listings = this.repository.getListingsForEvaluation(runId, listingIds);
    if (!listings) {
      throw new ApiError(404, "LISTING_NOT_FOUND", "One or more listings do not belong to the requested run.");
    }
    const budget = createEvaluationExecutionBudget(request, listings, plan, this.budgetPolicy);
    if (exceedsUsage(budget.estimate, budget.limit)) {
      throw new ApiError(
        422,
        "EVALUATION_EXECUTION_BUDGET_EXCEEDED",
        "The requested evaluation execution exceeds the configured provider budget; reduce its listings or recipes.",
      );
    }
    return budget;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
