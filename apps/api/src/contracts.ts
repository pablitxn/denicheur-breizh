import { z } from "zod";

export const MAX_LISTINGS_PER_REQUEST = 20;
export const MAX_CRITERIA_PER_RECIPE = 20;

export const MISSING_DATA_FIELDS = [
  "title",
  "priceEuros",
  "propertyType",
  "rooms",
  "bedrooms",
  "surfaceM2",
  "landSurfaceM2",
  "location",
  "sellerName",
  "sellerType",
  "energyClass",
  "gesClass",
  "description",
  "features",
] as const;

const identifierSchema = z.string().trim().min(1).max(128);
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).optional();
const nonNegativeNumber = (maximum: number) => z.number().finite().min(0).max(maximum).optional();
const optionalCount = z.number().int().min(0).max(100).optional();

export const intelligenceCriterionSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_000),
    weight: z.number().finite().min(0).max(1_000),
    required: z.boolean(),
  })
  .strict();

export const intelligenceRecipeSchema = z
  .object({
    id: identifierSchema,
    version: z.number().int().min(1).max(2_147_483_647),
    name: z.string().trim().min(1).max(160),
    threshold: z.number().finite().min(0).max(100),
    criteria: z.array(intelligenceCriterionSchema).min(1).max(MAX_CRITERIA_PER_RECIPE),
  })
  .strict();

export const filterListingInputSchema = z
  .object({
    id: identifierSchema,
    url: z.string().trim().url().max(2_048).refine((value) => new URL(value).protocol === "https:", {
      message: "Listing URLs must use HTTPS.",
    }),
    title: optionalText(300),
    priceEuros: nonNegativeNumber(1_000_000_000),
    propertyType: optionalText(120),
    rooms: optionalCount,
    bedrooms: optionalCount,
    surfaceM2: nonNegativeNumber(10_000_000),
    landSurfaceM2: nonNegativeNumber(100_000_000),
    location: optionalText(300),
    sellerName: optionalText(300),
    sellerType: optionalText(120),
    energyClass: optionalText(20),
    gesClass: optionalText(20),
    description: optionalText(6_000),
    features: z.array(z.string().trim().min(1).max(160)).max(50),
  })
  .strict();

export const filterListingsRequestSchema = z
  .object({
    runId: identifierSchema,
    recipe: intelligenceRecipeSchema,
    listings: z.array(filterListingInputSchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict()
  .superRefine((request, context) => {
    addDuplicateIssues(
      request.recipe.criteria.map((criterion) => criterion.id),
      ["recipe", "criteria"],
      "criterion",
      context,
    );
    addDuplicateIssues(
      request.listings.map((listing) => listing.id),
      ["listings"],
      "listing",
      context,
    );
  });

export const criterionVerdictSchema = z.enum(["pass", "fail", "unknown"]);
export const listingDecisionSchema = z.enum(["relevant", "not-relevant", "review"]);

export const criterionEvaluationSchema = z
  .object({
    criterionId: identifierSchema,
    verdict: criterionVerdictSchema,
    reason: z.string().trim().min(1).max(1_000),
    evidence: z.array(z.string().trim().min(1).max(500)).max(5),
  })
  .strict();

export const listingEvaluationResultSchema = z
  .object({
    listingId: identifierSchema,
    decision: listingDecisionSchema,
    score: z.number().min(0).max(100).nullable(),
    summary: z.string().trim().min(1).max(1_000),
    criteria: z.array(criterionEvaluationSchema).min(1).max(MAX_CRITERIA_PER_RECIPE),
    missingData: z.array(z.enum(MISSING_DATA_FIELDS)).max(MISSING_DATA_FIELDS.length),
    evaluatedAt: z.string().datetime(),
  })
  .strict();

export const filterListingsResponseSchema = z
  .object({
    runId: identifierSchema,
    recipeId: identifierSchema,
    recipeVersion: z.number().int().min(1),
    evaluator: z
      .object({
        provider: z.literal("openai"),
        model: z.string().min(1).max(128),
        version: z.string().min(1).max(64),
      })
      .strict(),
    results: z.array(listingEvaluationResultSchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict();

export type IntelligenceCriterion = z.infer<typeof intelligenceCriterionSchema>;
export type IntelligenceRecipe = z.infer<typeof intelligenceRecipeSchema>;
export type FilterListingInput = z.infer<typeof filterListingInputSchema>;
export type FilterListingsRequest = z.infer<typeof filterListingsRequestSchema>;
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>;
export type ListingDecision = z.infer<typeof listingDecisionSchema>;
export type CriterionEvaluation = z.infer<typeof criterionEvaluationSchema>;
export type ListingEvaluationResult = z.infer<typeof listingEvaluationResultSchema>;
export type FilterListingsResponse = z.infer<typeof filterListingsResponseSchema>;
export type MissingDataField = (typeof MISSING_DATA_FIELDS)[number];

function addDuplicateIssues(
  values: readonly string[],
  pathPrefix: readonly (string | number)[],
  label: string,
  context: z.core.$RefinementCtx<unknown>,
): void {
  const firstIndexByValue = new Map<string, number>();

  values.forEach((value, index) => {
    const firstIndex = firstIndexByValue.get(value);

    if (firstIndex === undefined) {
      firstIndexByValue.set(value, index);
      return;
    }

    context.addIssue({
      code: "custom",
      path: [...pathPrefix, index, "id"],
      message: `Duplicate ${label} id; first used at index ${firstIndex}.`,
    });
  });
}
