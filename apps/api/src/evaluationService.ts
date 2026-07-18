import {
  MAX_EVALUATION_IMAGE_URLS,
  type EvaluationRequest,
  type FilterListingInput,
  type FilterListingsResponse,
  type ListingEvaluationRecord,
  type ListingEvaluationResult,
  type ListingRecord,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import type { EvaluationContext, FilterListingsService } from "./filterService.js";
import type { DenicheurRepository } from "./repository.js";

export class StoredEvaluationService {
  constructor(
    private readonly repository: DenicheurRepository,
    private readonly filterService: Pick<FilterListingsService, "filter">,
  ) {}

  async evaluate(
    runId: string,
    request: EvaluationRequest,
    context: EvaluationContext,
  ): Promise<FilterListingsResponse> {
    if (!this.repository.getRun(runId)) {
      throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    }

    const recipe = this.repository.getRecipe(request.recipeId, request.recipeVersion);
    if (!recipe) {
      throw new ApiError(404, "RECIPE_NOT_FOUND", "The requested recipe version does not exist.");
    }

    const listings = this.repository.getListingsForEvaluation(runId, request.listingIds);
    if (!listings) {
      throw new ApiError(404, "LISTING_NOT_FOUND", "One or more listings do not belong to the requested run.");
    }

    const existingById = new Map<string, ListingEvaluationRecord>();
    const missing: ListingRecord[] = [];
    for (const listing of listings) {
      const existing = this.repository.findEvaluation(runId, listing, request);
      if (existing) existingById.set(listing.id, existing);
      else missing.push(listing);
    }

    let evaluatedResponse: FilterListingsResponse | undefined;
    if (missing.length) {
      evaluatedResponse = await this.filterService.filter({
        runId,
        locale: request.locale,
        recipe: {
          id: recipe.id,
          version: recipe.version,
          name: recipe.name,
          threshold: recipe.threshold,
          criteria: recipe.criteria,
        },
        listings: missing.map(toFilterListing),
      }, context);
      for (const persisted of this.repository.saveEvaluationBatch(evaluatedResponse)) {
        existingById.set(persisted.listingId, persisted);
      }
    }

    const records = request.listingIds.map((listingId) => {
      const evaluation = existingById.get(listingId);
      if (!evaluation) throw new Error("The requested evaluation is missing after persistence.");
      return evaluation;
    });
    const evaluator = evaluatedResponse?.evaluator ?? records[0]?.evaluator;
    if (!evaluator) throw new Error("An evaluation response requires evaluator metadata.");

    return {
      runId,
      locale: request.locale,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      evaluator,
      results: records.map(toEvaluationResult),
    };
  }
}

function toFilterListing(listing: ListingRecord): FilterListingInput {
  const imageUrls = selectEvaluationImageUrls(listing);

  return {
    id: listing.id,
    url: listing.url,
    ...(listing.title ? { title: listing.title } : {}),
    ...(listing.priceEuros !== undefined ? { priceEuros: listing.priceEuros } : {}),
    ...(listing.propertyType ? { propertyType: listing.propertyType } : {}),
    ...(listing.rooms !== undefined ? { rooms: listing.rooms } : {}),
    ...(listing.bedrooms !== undefined ? { bedrooms: listing.bedrooms } : {}),
    ...(listing.surfaceM2 !== undefined ? { surfaceM2: listing.surfaceM2 } : {}),
    ...(listing.landSurfaceM2 !== undefined ? { landSurfaceM2: listing.landSurfaceM2 } : {}),
    ...(listing.location ? { location: listing.location } : {}),
    ...(listing.sellerName ? { sellerName: listing.sellerName } : {}),
    ...(listing.sellerType ? { sellerType: listing.sellerType } : {}),
    ...(listing.energyClass ? { energyClass: listing.energyClass } : {}),
    ...(listing.gesClass ? { gesClass: listing.gesClass } : {}),
    ...(listing.description ? { description: listing.description } : {}),
    features: listing.features ?? [],
    ...(imageUrls.length ? { imageUrls } : {}),
  };
}

function selectEvaluationImageUrls(listing: ListingRecord): string[] {
  const selected: string[] = [];
  const seenImages = new Set<string>();
  const candidates = [
    ...(listing.imageUrl ? [listing.imageUrl] : []),
    ...(listing.imageUrls ?? []),
  ];

  for (const candidate of candidates) {
    if (candidate.length > 500) continue;
    const parsed = new URL(candidate);
    const imageIdentity = `${parsed.origin}${parsed.pathname}`;
    if (seenImages.has(imageIdentity)) continue;
    seenImages.add(imageIdentity);
    selected.push(candidate);
    if (selected.length === MAX_EVALUATION_IMAGE_URLS) break;
  }

  return selected;
}

function toEvaluationResult(record: ListingEvaluationRecord): ListingEvaluationResult {
  return {
    listingId: record.listingId,
    decision: record.decision,
    score: record.score,
    summary: record.summary,
    criteria: record.criteria,
    missingData: record.missingData,
    evaluatedAt: record.evaluatedAt,
  };
}
