import {
  MAX_LISTINGS_PER_REQUEST,
  type EvaluationExecutionBudget,
  type EvaluationExecutionCreateRequest,
  type EvaluationExecutionResourceUsage,
  type ListingRecord,
  type ResolvedEvaluationPlanVersion,
} from "./contracts.js";

const PROVIDER_BATCH_SIZE = 3;
const MAX_REPAIR_CALLS_PER_WORKER_BATCH = 6;
const REQUEST_OVERHEAD_TOKENS = 2_000;
const LOW_DETAIL_IMAGE_TOKEN_RESERVATION = 1_024;

export interface EvaluationBudgetPolicy {
  readonly maxProviderCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicroUsd: number;
  readonly inputPriceMicroUsdPerMillionTokens: number;
  readonly outputPriceMicroUsdPerMillionTokens: number;
}

export const DEFAULT_EVALUATION_BUDGET_POLICY: EvaluationBudgetPolicy = {
  maxProviderCalls: 200,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 1_000_000,
  maxCostMicroUsd: 3_000_000,
  inputPriceMicroUsdPerMillionTokens: 0,
  outputPriceMicroUsdPerMillionTokens: 0,
};

export function createEvaluationExecutionBudget(
  request: EvaluationExecutionCreateRequest,
  listings: readonly ListingRecord[],
  plan: ResolvedEvaluationPlanVersion,
  policy: EvaluationBudgetPolicy,
): EvaluationExecutionBudget {
  assertEvaluationBudgetPolicy(policy);
  const serverLimit = usage({
    providerCalls: policy.maxProviderCalls,
    inputTokens: policy.maxInputTokens,
    outputTokens: policy.maxOutputTokens,
    costMicroUsd: policy.maxCostMicroUsd,
  });
  const requested = request.budget;
  const limit = usage({
    providerCalls: Math.min(serverLimit.providerCalls, requested?.maxProviderCalls ?? serverLimit.providerCalls),
    inputTokens: Math.min(serverLimit.inputTokens, requested?.maxInputTokens ?? serverLimit.inputTokens),
    outputTokens: Math.min(serverLimit.outputTokens, requested?.maxOutputTokens ?? serverLimit.outputTokens),
    costMicroUsd: Math.min(serverLimit.costMicroUsd, requested?.maxCostMicroUsd ?? serverLimit.costMicroUsd),
  });
  const estimate = estimateEvaluationExecutionUsage(listings, plan, policy);
  return { limit, estimate, consumed: zeroUsage() };
}

export function estimateEvaluationExecutionUsage(
  listings: readonly ListingRecord[],
  plan: ResolvedEvaluationPlanVersion,
  policy: Pick<
    EvaluationBudgetPolicy,
    "inputPriceMicroUsdPerMillionTokens" | "outputPriceMicroUsdPerMillionTokens"
  >,
): EvaluationExecutionResourceUsage {
  let providerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const reference of plan.recipes) {
    for (const workerBatch of chunks(listings, MAX_LISTINGS_PER_REQUEST)) {
      const repairCandidates = [...workerBatch]
        .sort((left, right) => estimateListingTokens(right) - estimateListingTokens(left))
        .slice(0, Math.min(MAX_REPAIR_CALLS_PER_WORKER_BATCH, workerBatch.length));
      const calls = [
        ...chunks(workerBatch, PROVIDER_BATCH_SIZE),
        ...repairCandidates.map((listing) => [listing] as const),
      ];
      for (const callListings of calls) {
        const fallbackMultiplier = callListings.some((listing) => (listing.imageUrls?.length ?? 0) > 0) ? 2 : 1;
        providerCalls += fallbackMultiplier;
        inputTokens += estimateProviderInputTokens(reference.recipe, callListings) * fallbackMultiplier;
        outputTokens += maxOutputTokensForShape(callListings.length, reference.recipe.criteria.length)
          * fallbackMultiplier;
      }
    }
  }

  return usage({
    providerCalls,
    inputTokens,
    outputTokens,
    costMicroUsd: calculateCostMicroUsd(inputTokens, outputTokens, policy),
  });
}

export function estimateProviderCallReservation(
  serializedRequest: unknown,
  imageCount: number,
  maxOutputTokens: number,
  policy: Pick<
    EvaluationBudgetPolicy,
    "inputPriceMicroUsdPerMillionTokens" | "outputPriceMicroUsdPerMillionTokens"
  >,
): EvaluationExecutionResourceUsage {
  const inputTokens = serializedTokenUpperBound(serializedRequest)
    + REQUEST_OVERHEAD_TOKENS
    + (imageCount * LOW_DETAIL_IMAGE_TOKEN_RESERVATION);
  return usage({
    providerCalls: 1,
    inputTokens,
    outputTokens: maxOutputTokens,
    costMicroUsd: calculateCostMicroUsd(inputTokens, maxOutputTokens, policy),
  });
}

export function maxOutputTokensForShape(listingCount: number, criterionCount: number): number {
  const calculated = 1_000 + (listingCount * (400 + (criterionCount * 250)));
  return Math.max(1_500, Math.min(12_000, calculated));
}

export function calculateCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  policy: Pick<
    EvaluationBudgetPolicy,
    "inputPriceMicroUsdPerMillionTokens" | "outputPriceMicroUsdPerMillionTokens"
  >,
): number {
  const values = [
    inputTokens,
    outputTokens,
    policy.inputPriceMicroUsdPerMillionTokens,
    policy.outputPriceMicroUsdPerMillionTokens,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("Provider usage and prices must be safe non-negative integers.");
  }
  const divisor = 1_000_000n;
  const numerator = (BigInt(inputTokens) * BigInt(policy.inputPriceMicroUsdPerMillionTokens))
    + (BigInt(outputTokens) * BigInt(policy.outputPriceMicroUsdPerMillionTokens));
  const cost = (numerator + divisor - 1n) / divisor;
  return cost > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(cost);
}

export function zeroUsage(): EvaluationExecutionResourceUsage {
  return usage({ providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
}

export function addUsage(
  left: EvaluationExecutionResourceUsage,
  right: EvaluationExecutionResourceUsage,
): EvaluationExecutionResourceUsage {
  return usage({
    providerCalls: left.providerCalls + right.providerCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costMicroUsd: left.costMicroUsd + right.costMicroUsd,
  });
}

export function subtractUsage(
  left: EvaluationExecutionResourceUsage,
  right: EvaluationExecutionResourceUsage,
): EvaluationExecutionResourceUsage {
  return usage({
    providerCalls: Math.max(0, left.providerCalls - right.providerCalls),
    inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    costMicroUsd: Math.max(0, left.costMicroUsd - right.costMicroUsd),
  });
}

export function exceedsUsage(
  candidate: EvaluationExecutionResourceUsage,
  limit: EvaluationExecutionResourceUsage,
): boolean {
  return candidate.providerCalls > limit.providerCalls
    || candidate.inputTokens > limit.inputTokens
    || candidate.outputTokens > limit.outputTokens
    || candidate.costMicroUsd > limit.costMicroUsd;
}

function estimateProviderInputTokens(recipe: unknown, listings: readonly ListingRecord[]): number {
  return serializedTokenUpperBound({ recipe, listings })
    + REQUEST_OVERHEAD_TOKENS
    + listings.reduce((total, listing) => total + ((listing.imageUrls?.length ?? 0)
      * LOW_DETAIL_IMAGE_TOKEN_RESERVATION), 0);
}

function estimateListingTokens(listing: ListingRecord): number {
  return serializedTokenUpperBound(listing)
    + ((listing.imageUrls?.length ?? 0) * LOW_DETAIL_IMAGE_TOKEN_RESERVATION);
}

function serializedTokenUpperBound(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function usage(value: EvaluationExecutionResourceUsage): EvaluationExecutionResourceUsage {
  return {
    providerCalls: Math.max(0, Math.ceil(value.providerCalls)),
    inputTokens: Math.max(0, Math.ceil(value.inputTokens)),
    outputTokens: Math.max(0, Math.ceil(value.outputTokens)),
    costMicroUsd: Math.max(0, Math.ceil(value.costMicroUsd)),
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function assertEvaluationBudgetPolicy(policy: EvaluationBudgetPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0 || (name.startsWith("max") && value === 0)) {
      throw new Error(`Evaluation budget policy ${name} must be a safe positive integer.`);
    }
  }
}
