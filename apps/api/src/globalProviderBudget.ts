import { randomUUID } from "node:crypto";

import { ApiError } from "./errors.js";
import {
  calculateCostMicroUsd,
  estimateProviderCallReservation,
  type EvaluationBudgetPolicy,
} from "./evaluationBudget.js";
import type {
  ProviderCallBudget,
  ProviderCallReservationHandle,
  ProviderCallReservationRequest,
  ProviderCallUsage,
} from "./filterService.js";
import type { EvaluationExecutionResourceUsage } from "./contracts.js";

export interface GlobalProviderBudgetPolicy extends EvaluationBudgetPolicy {
  readonly windowMs: number;
}

export interface GlobalProviderCallReservation {
  readonly id: string;
  readonly createdAt: string;
  readonly usage: EvaluationExecutionResourceUsage;
}

export interface GlobalProviderBudgetStore {
  tryReserveGlobalProviderCall(
    reservation: GlobalProviderCallReservation,
    cutoff: string,
    limit: EvaluationExecutionResourceUsage,
  ): boolean;
  settleGlobalProviderCall(
    id: string,
    usage: EvaluationExecutionResourceUsage,
    settledAt: string,
    cutoff: string,
  ): void;
  releaseGlobalProviderCall(id: string, cutoff: string): void;
  getGlobalProviderUsage(cutoff: string): EvaluationExecutionResourceUsage;
}

/**
 * Deployment-wide provider budget for synchronous and durable evaluations.
 * Production supports one API replica and persists every reservation in the
 * repository so an API restart cannot reopen the active rolling window.
 */
export class GlobalProviderBudget implements ProviderCallBudget {
  constructor(
    private readonly policy: GlobalProviderBudgetPolicy,
    private readonly store: GlobalProviderBudgetStore,
    private readonly now: () => number = Date.now,
  ) {
    assertGlobalProviderBudgetPolicy(policy);
  }

  reserve(request: ProviderCallReservationRequest): ProviderCallReservationHandle {
    const reserved = estimateProviderCallReservation(
      request.serializedRequest,
      request.imageCount,
      request.maxOutputTokens,
      this.policy,
    );
    const now = this.now();
    const id = randomUUID();
    const admitted = this.store.tryReserveGlobalProviderCall({
      id,
      createdAt: new Date(now).toISOString(),
      usage: reserved,
    }, this.cutoff(now), globalLimit(this.policy));
    if (!admitted) {
      throw new ApiError(
        429,
        "OPENAI_GLOBAL_BUDGET_EXHAUSTED",
        "The OpenAI provider budget for the current window is exhausted.",
        { retryable: true },
      );
    }

    return { id };
  }

  settle(handle: ProviderCallReservationHandle, usage: ProviderCallUsage): void {
    if (!isSafeUsage(usage)) return;
    const costMicroUsd = calculateCostMicroUsd(usage.inputTokens, usage.outputTokens, this.policy);
    if (!Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0) return;
    const now = this.now();
    this.store.settleGlobalProviderCall(handle.id, {
      providerCalls: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicroUsd,
    }, new Date(now).toISOString(), this.cutoff(now));
  }

  release(handle: ProviderCallReservationHandle): void {
    this.store.releaseGlobalProviderCall(handle.id, this.cutoff(this.now()));
  }

  usage(): EvaluationExecutionResourceUsage {
    return this.store.getGlobalProviderUsage(this.cutoff(this.now()));
  }

  private cutoff(now: number): string {
    return new Date(now - this.policy.windowMs).toISOString();
  }
}

function isSafeUsage(usage: ProviderCallUsage): boolean {
  return [usage.inputTokens, usage.outputTokens]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

function globalLimit(policy: GlobalProviderBudgetPolicy): EvaluationExecutionResourceUsage {
  return {
    providerCalls: policy.maxProviderCalls,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens,
    costMicroUsd: policy.maxCostMicroUsd,
  };
}

function assertGlobalProviderBudgetPolicy(policy: GlobalProviderBudgetPolicy): void {
  const positive = [
    policy.maxProviderCalls,
    policy.maxInputTokens,
    policy.maxOutputTokens,
    policy.maxCostMicroUsd,
    policy.windowMs,
  ];
  const nonNegative = [
    policy.inputPriceMicroUsdPerMillionTokens,
    policy.outputPriceMicroUsdPerMillionTokens,
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Global provider budget limits must be safe positive integers.");
  }
  if (nonNegative.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Global provider prices must be safe non-negative integers.");
  }
}
