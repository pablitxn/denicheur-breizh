import type {
  CriterionEvaluation,
  FilterListingInput,
  FilterListingsRequest,
  FilterListingsResponse,
  ListingDecision,
  MissingDataField,
} from "./contracts.js";
import { MISSING_DATA_FIELDS } from "./contracts.js";
import type { ModelEvaluationBatch } from "./modelOutput.js";

export interface EvaluationContext {
  readonly requestId: string;
}

export interface ModelEvaluationProvider {
  readonly model: string;
  readonly version: string;
  evaluate(request: FilterListingsRequest, context: EvaluationContext): Promise<ModelEvaluationBatch>;
}

export class FilterListingsService {
  constructor(
    private readonly evaluator: ModelEvaluationProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async filter(request: FilterListingsRequest, context: EvaluationContext): Promise<FilterListingsResponse> {
    const modelBatch = await this.evaluator.evaluate(request, context);
    return buildFilterResponse(request, modelBatch, this.evaluator.model, this.evaluator.version, this.now());
  }
}

export function buildFilterResponse(
  request: FilterListingsRequest,
  modelBatch: ModelEvaluationBatch,
  model: string,
  evaluatorVersion: string,
  evaluatedAt: Date,
): FilterListingsResponse {
  const criteriaById = new Map(request.recipe.criteria.map((criterion) => [criterion.id, criterion]));
  const listingsById = new Map(request.listings.map((listing) => [listing.id, listing]));
  const timestamp = evaluatedAt.toISOString();

  const results = modelBatch.results.map((modelResult) => {
    const listing = listingsById.get(modelResult.listingId);

    if (!listing) {
      throw new Error("Model output was not validated before scoring.");
    }

    let passedWeight = 0;
    let evaluableWeight = 0;
    let hasRequiredUnknown = false;

    for (const evaluation of modelResult.criteria) {
      const criterion = criteriaById.get(evaluation.criterionId);

      if (!criterion) {
        throw new Error("Model output was not validated before scoring.");
      }

      if (evaluation.verdict === "unknown") {
        hasRequiredUnknown ||= criterion.required;
        continue;
      }

      if (criterion.weight > 0) {
        evaluableWeight += criterion.weight;
        if (evaluation.verdict === "pass") passedWeight += criterion.weight;
      }
    }

    const score = evaluableWeight > 0 ? roundScore((passedWeight / evaluableWeight) * 100) : null;
    const decision = decide(score, hasRequiredUnknown, request.recipe.threshold);

    return {
      listingId: modelResult.listingId,
      decision,
      score,
      summary: modelResult.summary,
      criteria: modelResult.criteria as CriterionEvaluation[],
      missingData: missingFields(listing),
      evaluatedAt: timestamp,
    };
  });

  return {
    runId: request.runId,
    locale: request.locale,
    recipeId: request.recipe.id,
    recipeVersion: request.recipe.version,
    evaluator: {
      provider: "openai",
      model,
      version: evaluatorVersion,
    },
    results,
  };
}

function decide(score: number | null, hasRequiredUnknown: boolean, threshold: number): ListingDecision {
  if (score === null || hasRequiredUnknown) return "review";
  return score >= threshold ? "relevant" : "not-relevant";
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

function missingFields(listing: FilterListingInput): MissingDataField[] {
  return MISSING_DATA_FIELDS.filter((field) => {
    const value = listing[field];
    return value === undefined || (Array.isArray(value) && value.length === 0);
  });
}
