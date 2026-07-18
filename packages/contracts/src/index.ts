import { z } from "zod";

export const MAX_LISTINGS_PER_REQUEST = 20;
export const MAX_CRITERIA_PER_RECIPE = 12;
export const MAX_LISTING_IMAGE_URLS = 50;
export const MAX_EVALUATION_IMAGE_URLS = 3;
export const MAX_LISTING_FEATURES = 100;

export const SUPPORTED_LOCALES = ["fr", "es", "en"] as const;
export const listingSources = ["leboncoin"] as const;

const identifierSchema = z.string().trim().min(1).max(128);
const optionalText = (maximum: number) => z.string().trim().min(1).max(maximum).optional();
const optionalNonNegativeNumber = (maximum: number) => z.number().finite().min(0).max(maximum).optional();
const optionalCount = z.number().int().min(0).max(100).optional();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const httpsUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:", { message: "Listing URLs must use HTTPS." });
const evaluationImageUrlSchema = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => new URL(value).protocol === "https:", { message: "Evaluation images must use HTTPS." });

export const localeSchema = z.enum(SUPPORTED_LOCALES);
export const filterLocaleSchema = localeSchema;
export const listingSourceSchema = z.enum(listingSources);
export const listingIdentitySchema = z
  .object({
    source: listingSourceSchema,
    externalId: identifierSchema,
  })
  .strict();

export const listingKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(260)
  .refine((value) => {
    const separator = value.indexOf(":");
    if (separator < 1) return false;
    return listingIdentitySchema.safeParse({ source: value.slice(0, separator), externalId: value.slice(separator + 1) }).success;
  }, "Listing ids must use the source:externalId format.");

export function createListingKey(identity: ListingIdentity): string {
  return `${identity.source}:${identity.externalId}`;
}

export function parseListingKey(value: string): ListingIdentity | undefined {
  if (!listingKeySchema.safeParse(value).success) return undefined;
  const separator = value.indexOf(":");
  return listingIdentitySchema.parse({ source: value.slice(0, separator), externalId: value.slice(separator + 1) });
}

export const coordinateLocationKinds = [
  "source-property",
  "source-locality",
  "locality-centroid",
  "postal-code-centroid",
] as const;

export const coordinateLocationKindSchema = z.enum(coordinateLocationKinds);

export const listingCoordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    verifiedAt: isoDateTimeSchema,
    provenance: z.string().trim().min(1).max(300),
    locationKind: coordinateLocationKindSchema,
  })
  .strict();

// Compatibility alias for existing extension and API consumers.
export const verifiedCoordinatesSchema = listingCoordinatesSchema;

export const listingStatusSchema = z.enum(["listing", "detailed", "failed"]);

export const listingIngestionSchema = z
  .object({
    source: listingSourceSchema,
    externalId: identifierSchema,
    url: httpsUrlSchema,
    title: optionalText(300),
    priceText: optionalText(120),
    priceEuros: optionalNonNegativeNumber(1_000_000_000),
    pricePerSquareMeterText: optionalText(120),
    propertyType: optionalText(120),
    rooms: optionalCount,
    bedrooms: optionalCount,
    surfaceM2: optionalNonNegativeNumber(10_000_000),
    landSurfaceM2: optionalNonNegativeNumber(100_000_000),
    location: optionalText(300),
    sellerName: optionalText(300),
    sellerType: optionalText(120),
    postedAt: optionalText(160),
    description: optionalText(20_000),
    energyClass: optionalText(20),
    gesClass: optionalText(20),
    imageUrl: httpsUrlSchema.optional(),
    imageUrls: z.array(httpsUrlSchema).max(MAX_LISTING_IMAGE_URLS).optional(),
    features: z.array(z.string().trim().min(1).max(160)).max(MAX_LISTING_FEATURES).optional(),
    coordinates: verifiedCoordinatesSchema.optional(),
    status: listingStatusSchema,
    scrapedAt: isoDateTimeSchema,
    error: optionalText(2_000),
    rawTextSample: optionalText(10_000),
  })
  .strict();

export const runStatusSchema = z.enum([
  "idle",
  "opening-search",
  "configuring-search",
  "collecting-search",
  "collecting-details",
  "evaluating",
  "blocked-captcha",
  "paused-captcha",
  "blocked-activity",
  "completed",
  "cancelled",
  "failed",
  "legacy-import",
]);

export const intelligenceStatusSchema = z.enum(["idle", "evaluating", "completed", "failed"]);

export const runIngestionSchema = z
  .object({
    id: identifierSchema,
    source: listingSourceSchema,
    status: runStatusSchema,
    startedAt: isoDateTimeSchema.optional(),
    finishedAt: isoDateTimeSchema.optional(),
    searchUrl: httpsUrlSchema.optional(),
    target: z.number().int().min(0).max(100_000).optional(),
    found: z.number().int().min(0).max(100_000).optional(),
    pagesVisited: z.number().int().min(0).max(10_000).optional(),
    collected: z.number().int().min(0).max(100_000).optional(),
    currentUrl: httpsUrlSchema.optional(),
    message: optionalText(2_000),
    error: optionalText(2_000),
    intelligenceStatus: intelligenceStatusSchema.optional(),
    intelligenceError: optionalText(2_000),
    evaluated: z.number().int().min(0).max(100_000).optional(),
    relevant: z.number().int().min(0).max(100_000).optional(),
    notRelevant: z.number().int().min(0).max(100_000).optional(),
    review: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const intelligenceCriterionSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_000),
    weight: z.number().finite().min(0).max(1_000),
    required: z.boolean(),
    evidenceRequired: z.boolean().optional(),
  })
  .strict();

const recipeFields = {
  name: z.string().trim().min(1).max(160),
  threshold: z.number().finite().min(0).max(100),
  criteria: z.array(intelligenceCriterionSchema).min(1).max(MAX_CRITERIA_PER_RECIPE),
} as const;

export const recipeDraftSchema = z
  .object(recipeFields)
  .strict()
  .superRefine((recipe, context) => addDuplicateIdIssues(recipe.criteria, ["criteria"], "criterion", context));

export const intelligenceRecipeSchema = z
  .object({
    id: identifierSchema,
    version: z.number().int().min(1).max(2_147_483_647),
    ...recipeFields,
  })
  .strict()
  .superRefine((recipe, context) => addDuplicateIdIssues(recipe.criteria, ["criteria"], "criterion", context));

export const recipeVersionSchema = z
  .object({
    id: identifierSchema,
    version: z.number().int().min(1).max(2_147_483_647),
    ...recipeFields,
    active: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((recipe, context) => addDuplicateIdIssues(recipe.criteria, ["criteria"], "criterion", context));

export const criterionVerdictSchema = z.enum(["pass", "fail", "unknown"]);
export const listingDecisionSchema = z.enum(["relevant", "not-relevant", "review"]);

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

const verbatimEvidenceSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim().length > 0, { message: "Evidence must contain non-whitespace text." });

export const criterionEvaluationSchema = z
  .object({
    criterionId: identifierSchema,
    verdict: criterionVerdictSchema,
    reason: z.string().trim().min(1).max(1_000),
    evidence: z.array(verbatimEvidenceSchema).max(5),
  })
  .strict();

export const listingEvaluationResultSchema = z
  .object({
    listingId: z.string().trim().min(1).max(260),
    decision: listingDecisionSchema,
    score: z.number().min(0).max(100).nullable(),
    summary: z.string().trim().min(1).max(1_000),
    criteria: z.array(criterionEvaluationSchema).min(1).max(MAX_CRITERIA_PER_RECIPE),
    missingData: z.array(z.enum(MISSING_DATA_FIELDS)).max(MISSING_DATA_FIELDS.length),
    evaluatedAt: isoDateTimeSchema,
  })
  .strict();

export const evaluatorSchema = z
  .object({
    provider: z.literal("openai"),
    model: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
  })
  .strict();

export const listingEvaluationRecordSchema = listingEvaluationResultSchema.extend({
  runId: identifierSchema,
  source: listingSourceSchema,
  externalId: identifierSchema,
  recipeId: identifierSchema,
  recipeVersion: z.number().int().min(1),
  locale: localeSchema,
  evaluator: evaluatorSchema,
});

export const filterListingInputSchema = z
  .object({
    id: z.string().trim().min(1).max(260),
    url: httpsUrlSchema,
    title: optionalText(300),
    priceEuros: optionalNonNegativeNumber(1_000_000_000),
    propertyType: optionalText(120),
    rooms: optionalCount,
    bedrooms: optionalCount,
    surfaceM2: optionalNonNegativeNumber(10_000_000),
    landSurfaceM2: optionalNonNegativeNumber(100_000_000),
    location: optionalText(300),
    sellerName: optionalText(300),
    sellerType: optionalText(120),
    energyClass: optionalText(20),
    gesClass: optionalText(20),
    description: optionalText(6_000),
    features: z.array(z.string().trim().min(1).max(160)).max(MAX_LISTING_FEATURES),
    imageUrls: z
      .array(evaluationImageUrlSchema)
      .max(MAX_EVALUATION_IMAGE_URLS)
      .refine((values) => new Set(values).size === values.length, "Evaluation image URLs must be unique.")
      .optional(),
  })
  .strict();

export const filterListingsRequestSchema = z
  .object({
    runId: identifierSchema,
    locale: localeSchema,
    recipe: intelligenceRecipeSchema,
    listings: z.array(filterListingInputSchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict()
  .superRefine((request, context) => {
    addDuplicateIdIssues(request.recipe.criteria, ["recipe", "criteria"], "criterion", context);
    addDuplicateIdIssues(request.listings, ["listings"], "listing", context);
  });

export const filterListingsResponseSchema = z
  .object({
    runId: identifierSchema,
    locale: localeSchema,
    recipeId: identifierSchema,
    recipeVersion: z.number().int().min(1),
    evaluator: evaluatorSchema,
    results: z.array(listingEvaluationResultSchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict();

export const ingestionRequestSchema = z
  .object({
    run: runIngestionSchema,
    listings: z.array(listingIngestionSchema).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict()
  .superRefine((request, context) => {
    const keys = request.listings.map(createListingKey);
    addDuplicateValuesIssues(keys, ["listings"], "listing", context);
    request.listings.forEach((listing, index) => {
      if (listing.source !== request.run.source) {
        context.addIssue({
          code: "custom",
          path: ["listings", index, "source"],
          message: "Listing source must match the run source.",
        });
      }
    });
  });

export const ingestionResponseSchema = z
  .object({
    runId: identifierSchema,
    accepted: z.number().int().min(0),
    inserted: z.number().int().min(0),
    updated: z.number().int().min(0),
    unchanged: z.number().int().min(0),
  })
  .strict();

export const evaluationRequestSchema = z
  .object({
    locale: localeSchema,
    recipeId: identifierSchema,
    recipeVersion: z.number().int().min(1),
    listingIds: z.array(listingKeySchema).min(1).max(MAX_LISTINGS_PER_REQUEST),
  })
  .strict()
  .superRefine((request, context) => addDuplicateValuesIssues(request.listingIds, ["listingIds"], "listing", context));

export const runRecordSchema = runIngestionSchema.extend({ updatedAt: isoDateTimeSchema });

export const listingRecordSchema = listingIngestionSchema.extend({
  id: listingKeySchema,
  lastRunId: identifierSchema,
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  latestEvaluation: listingEvaluationRecordSchema.optional(),
});

export const listingRunObservationSchema = z
  .object({
    runId: identifierSchema,
    observedAt: isoDateTimeSchema,
    status: listingStatusSchema,
    scrapedAt: isoDateTimeSchema,
  })
  .strict();

export const listingDetailSchema = listingRecordSchema.extend({
  runs: z.array(listingRunObservationSchema),
  evaluations: z.array(listingEvaluationRecordSchema),
});

export const runDetailSchema = runRecordSchema.extend({ listings: z.array(listingRecordSchema) });

const paginationQueryFields = {
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
} as const;

export const listingsQuerySchema = z
  .object({
    ...paginationQueryFields,
    source: listingSourceSchema.optional(),
    runId: identifierSchema.optional(),
    status: listingStatusSchema.optional(),
    decision: listingDecisionSchema.optional(),
    propertyType: optionalText(120),
    priceMin: z.coerce.number().finite().min(0).optional(),
    priceMax: z.coerce.number().finite().min(0).optional(),
    surfaceMin: z.coerce.number().finite().min(0).optional(),
    surfaceMax: z.coerce.number().finite().min(0).optional(),
    energyClass: optionalText(20),
    sort: z.enum(["updatedAt", "scrapedAt", "priceEuros"]).default("updatedAt"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export const runsQuerySchema = z
  .object({
    ...paginationQueryFields,
    source: listingSourceSchema.optional(),
    status: runStatusSchema.optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export const listingsPageSchema = z
  .object({
    items: z.array(listingRecordSchema),
    nextCursor: z.string().nullable(),
    total: z.number().int().min(0),
  })
  .strict();

export const runsPageSchema = z
  .object({
    items: z.array(runRecordSchema),
    nextCursor: z.string().nullable(),
    total: z.number().int().min(0),
  })
  .strict();

export const recipesResponseSchema = z.object({ items: z.array(recipeVersionSchema) }).strict();

export const healthResponseSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    service: z.literal("denicheur-api"),
    database: z.object({ status: z.enum(["ok", "error"]) }).strict(),
    openAiConfigured: z.boolean(),
  })
  .strict();

export type Locale = z.infer<typeof localeSchema>;
export type ListingSource = z.infer<typeof listingSourceSchema>;
export type ListingIdentity = z.infer<typeof listingIdentitySchema>;
export type CoordinateLocationKind = z.infer<typeof coordinateLocationKindSchema>;
export type ListingCoordinates = z.infer<typeof listingCoordinatesSchema>;
export type VerifiedCoordinates = ListingCoordinates;
export type ListingStatus = z.infer<typeof listingStatusSchema>;
export type ListingIngestion = z.infer<typeof listingIngestionSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunIngestion = z.infer<typeof runIngestionSchema>;
export type IntelligenceCriterion = z.infer<typeof intelligenceCriterionSchema>;
export type RecipeDraft = z.infer<typeof recipeDraftSchema>;
export type IntelligenceRecipe = z.infer<typeof intelligenceRecipeSchema>;
export type RecipeVersion = z.infer<typeof recipeVersionSchema>;
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>;
export type ListingDecision = z.infer<typeof listingDecisionSchema>;
export type CriterionEvaluation = z.infer<typeof criterionEvaluationSchema>;
export type ListingEvaluationResult = z.infer<typeof listingEvaluationResultSchema>;
export type ListingEvaluationRecord = z.infer<typeof listingEvaluationRecordSchema>;
export type FilterListingInput = z.infer<typeof filterListingInputSchema>;
export type FilterListingsRequest = z.infer<typeof filterListingsRequestSchema>;
export type FilterListingsResponse = z.infer<typeof filterListingsResponseSchema>;
export type MissingDataField = (typeof MISSING_DATA_FIELDS)[number];
export type IngestionRequest = z.infer<typeof ingestionRequestSchema>;
export type IngestionResponse = z.infer<typeof ingestionResponseSchema>;
export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type ListingRecord = z.infer<typeof listingRecordSchema>;
export type ListingRunObservation = z.infer<typeof listingRunObservationSchema>;
export type ListingDetail = z.infer<typeof listingDetailSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type ListingsQuery = z.infer<typeof listingsQuerySchema>;
export type RunsQuery = z.infer<typeof runsQuerySchema>;
export type ListingsPage = z.infer<typeof listingsPageSchema>;
export type RunsPage = z.infer<typeof runsPageSchema>;
export type RecipesResponse = z.infer<typeof recipesResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type FilterLocale = Locale;

interface IdentifiedValue {
  readonly id: string;
}

function addDuplicateIdIssues(
  values: readonly IdentifiedValue[],
  pathPrefix: readonly (string | number)[],
  label: string,
  context: z.core.$RefinementCtx<unknown>,
): void {
  addDuplicateValuesIssues(values.map((value) => value.id), pathPrefix, label, context, "id");
}

function addDuplicateValuesIssues(
  values: readonly string[],
  pathPrefix: readonly (string | number)[],
  label: string,
  context: z.core.$RefinementCtx<unknown>,
  property?: string,
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
      path: [...pathPrefix, index, ...(property ? [property] : [])],
      message: `Duplicate ${label} id; first used at index ${firstIndex}.`,
    });
  });
}
