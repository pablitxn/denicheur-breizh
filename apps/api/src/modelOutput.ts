import { z } from "zod";

import {
  MAX_CRITERIA_PER_RECIPE,
  MAX_LISTINGS_PER_REQUEST,
  criterionEvaluationSchema,
  type FilterListingInput,
  type FilterListingsRequest,
} from "./contracts.js";
import { invalidModelOutput } from "./errors.js";

const modelListingResultSchema = z
  .object({
    listingId: z.string().min(1).max(260),
    summary: z.string().trim().min(1).max(1_000),
    criteria: z.array(criterionEvaluationSchema).min(1).max(MAX_CRITERIA_PER_RECIPE),
  })
  .strict();

const modelEvaluationBatchSchema = z
  .object({
    results: z.array(modelListingResultSchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict();

export type ModelListingResult = z.infer<typeof modelListingResultSchema>;
export type ModelEvaluationBatch = z.infer<typeof modelEvaluationBatchSchema>;

export const MODEL_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      minItems: 1,
      maxItems: MAX_LISTINGS_PER_REQUEST,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["listingId", "summary", "criteria"],
        properties: {
          listingId: { type: "string" },
          summary: { type: "string" },
          criteria: {
            type: "array",
            minItems: 1,
            maxItems: MAX_CRITERIA_PER_RECIPE,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterionId", "verdict", "reason", "evidence"],
              properties: {
                criterionId: { type: "string" },
                verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
                reason: { type: "string" },
                evidence: {
                  type: "array",
                  maxItems: 5,
                  items: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function parseAndValidateModelOutput(
  outputText: string,
  request: FilterListingsRequest,
): ModelEvaluationBatch {
  let decoded: unknown;

  try {
    decoded = JSON.parse(outputText);
  } catch (error) {
    throw invalidModelOutput(error);
  }

  const parsed = modelEvaluationBatchSchema.safeParse(decoded);

  if (!parsed.success) {
    throw invalidModelOutput(parsed.error);
  }

  const resultByListingId = uniqueMap(parsed.data.results, (result) => result.listingId);
  const expectedListingIds = new Set(request.listings.map((listing) => listing.id));

  if (!resultByListingId || resultByListingId.size !== expectedListingIds.size) {
    throw invalidModelOutput();
  }

  for (const listingId of resultByListingId.keys()) {
    if (!expectedListingIds.has(listingId)) {
      throw invalidModelOutput();
    }
  }

  const criterionIds = new Set(request.recipe.criteria.map((criterion) => criterion.id));
  const orderedResults = request.listings.map((listing) => {
    const result = resultByListingId.get(listing.id);

    if (!result) {
      throw invalidModelOutput();
    }

    const evaluationByCriterionId = uniqueMap(result.criteria, (criterion) => criterion.criterionId);

    if (!evaluationByCriterionId || evaluationByCriterionId.size !== criterionIds.size) {
      throw invalidModelOutput();
    }

    for (const evaluation of result.criteria) {
      if (!criterionIds.has(evaluation.criterionId)) {
        throw invalidModelOutput();
      }

      if (evaluation.verdict !== "unknown" && evaluation.evidence.length === 0) {
        throw invalidModelOutput();
      }

      if (!evidenceBelongsToListing(evaluation.evidence, listing)) {
        throw invalidModelOutput();
      }
    }

    return {
      ...result,
      criteria: request.recipe.criteria.map((criterion) => {
        const evaluation = evaluationByCriterionId.get(criterion.id);

        if (!evaluation) {
          throw invalidModelOutput();
        }

        return evaluation;
      }),
    };
  });

  return { results: orderedResults };
}

function uniqueMap<T>(values: readonly T[], getId: (value: T) => string): Map<string, T> | undefined {
  const byId = new Map<string, T>();

  for (const value of values) {
    const id = getId(value);

    if (byId.has(id)) {
      return undefined;
    }

    byId.set(id, value);
  }

  return byId;
}

function evidenceBelongsToListing(evidence: readonly string[], listing: FilterListingInput): boolean {
  const sourceValues = listingEvidenceValues(listing);

  return evidence.every((excerpt) => {
    if (isUrl(excerpt)) return listing.imageUrls?.includes(excerpt) ?? false;
    return sourceValues.some((value) => (excerpt.length < 3 ? value === excerpt : value.includes(excerpt)));
  });
}

function listingEvidenceValues(listing: FilterListingInput): string[] {
  const values: Array<string | number | undefined> = [
    listing.url,
    listing.title,
    listing.priceEuros,
    listing.propertyType,
    listing.rooms,
    listing.bedrooms,
    listing.surfaceM2,
    listing.landSurfaceM2,
    listing.location,
    listing.sellerName,
    listing.sellerType,
    listing.energyClass,
    listing.gesClass,
    listing.description,
    ...listing.features,
    ...(listing.imageUrls ?? []),
  ];

  return values.filter((value): value is string | number => value !== undefined).map(String);
}

function isUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
