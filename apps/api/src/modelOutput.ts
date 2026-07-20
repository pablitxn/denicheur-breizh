import { z } from "zod";

import type {
  CriterionEvaluation,
  CriterionVerdict,
  FilterListingInput,
  FilterListingsRequest,
} from "./contracts.js";
import { invalidModelOutput, type SafeEvaluatorFailureDetails } from "./errors.js";

const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_VALUE_LENGTH = 500;

const generatedCriterionSchema = z
  .object({
    verdict: z.enum(["pass", "fail", "unknown"]),
    reason: z.string().trim().min(1).max(1_000),
    evidenceIds: z.array(z.string().min(1).max(128)).max(MAX_EVIDENCE_ITEMS),
  })
  .strict();

const generatedListingResultSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000),
    criteria: z.record(z.string(), generatedCriterionSchema),
  })
  .strict();

const generatedEvaluationBatchSchema = z
  .object({
    results: z.record(z.string(), generatedListingResultSchema),
  })
  .strict();

export interface ModelListingResult {
  listingId: string;
  summary: string;
  criteria: CriterionEvaluation[];
}

export interface ModelEvaluationBatch {
  results: ModelListingResult[];
  /** Provider trace identifier. Kept internal and never serialized in the public filter response. */
  responseId?: string;
}

export type EvidenceCatalogKind = "field" | "description" | "feature" | "image";

export interface EvidenceCatalogEntry {
  readonly id: string;
  readonly kind: EvidenceCatalogKind;
  readonly value: string;
}

export interface ParseModelOutputOptions {
  readonly responseId?: string;
}

type JsonSchema = Readonly<Record<string, unknown>>;

const EVIDENCE_FIELD_NAMES = [
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
] as const satisfies readonly (keyof FilterListingInput)[];

export function buildEvidenceCatalog(listing: FilterListingInput): EvidenceCatalogEntry[] {
  const entries: EvidenceCatalogEntry[] = [];

  for (const field of EVIDENCE_FIELD_NAMES) {
    const value = listing[field];
    if (value === undefined) continue;
    entries.push({ id: `field:${field}`, kind: "field", value: String(value) });
  }

  if (listing.description) {
    for (const [index, value] of chunkEvidenceText(listing.description).entries()) {
      entries.push({ id: `description:${index}`, kind: "description", value });
    }
  }

  listing.features.forEach((value, index) => {
    entries.push({ id: `feature:${index}`, kind: "feature", value });
  });

  listing.imageUrls?.forEach((value, index) => {
    entries.push({ id: `image:${index}`, kind: "image", value });
  });

  return entries;
}

export function buildModelOutputJsonSchema(request: FilterListingsRequest): JsonSchema {
  const definitions: Record<string, JsonSchema> = {};
  const listingProperties = Object.fromEntries(request.listings.map((listing, listingIndex) => {
    const evidenceIds = buildEvidenceCatalog(listing).map((entry) => entry.id);
    const evidenceDefinition = `evidenceId${listingIndex}`;
    if (evidenceIds.length > 0) {
      definitions[evidenceDefinition] = {
        type: "string",
        minLength: 1,
        maxLength: 128,
        enum: evidenceIds,
      };
    }
    const criterionProperties = Object.fromEntries(request.recipe.criteria.map((criterion, criterionIndex) => {
      const criterionDefinition = `criterion${listingIndex}_${criterionIndex}`;
      definitions[criterionDefinition] = buildCriterionJsonSchema(
        evidenceIds,
        evidenceIds.length > 0 ? `#/$defs/${evidenceDefinition}` : undefined,
        criterion.evidenceRequired !== false,
      );
      return [criterion.id, { $ref: `#/$defs/${criterionDefinition}` }];
    }));

    return [listing.id, {
      type: "object",
      additionalProperties: false,
      required: ["summary", "criteria"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        criteria: {
          type: "object",
          additionalProperties: false,
          required: request.recipe.criteria.map((criterion) => criterion.id),
          properties: criterionProperties,
        },
      },
    }];
  }));

  return {
    type: "object",
    $defs: definitions,
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "object",
        additionalProperties: false,
        required: request.listings.map((listing) => listing.id),
        properties: listingProperties,
      },
    },
  };
}

export function parseAndValidateModelOutput(
  outputText: string,
  request: FilterListingsRequest,
  options: ParseModelOutputOptions = {},
): ModelEvaluationBatch {
  let decoded: unknown;

  try {
    decoded = JSON.parse(outputText);
  } catch (error) {
    throw invalidOutput({
      stage: "parse",
      detailCode: "INVALID_JSON",
      retryable: true,
      ...options,
    }, error);
  }

  const parsed = generatedEvaluationBatchSchema.safeParse(decoded);

  if (!parsed.success) {
    const location = locateSchemaFailure(parsed.error, request);
    throw invalidOutput({
      stage: "schema",
      detailCode: "SCHEMA_MISMATCH",
      retryable: true,
      ...options,
      ...location,
    }, parsed.error);
  }

  assertExactKeys(
    Object.keys(parsed.data.results),
    request.listings.map((listing) => listing.id),
    "LISTING",
    options,
  );

  const orderedResults = request.listings.map((listing): ModelListingResult => {
    const result = parsed.data.results[listing.id];

    if (!result) {
      throw invalidOutput({
        stage: "semantic",
        detailCode: "MISSING_LISTING",
        listingId: listing.id,
        retryable: true,
        ...options,
      });
    }

    assertExactKeys(
      Object.keys(result.criteria),
      request.recipe.criteria.map((criterion) => criterion.id),
      "CRITERION",
      options,
      listing.id,
    );

    const evidenceById = new Map(buildEvidenceCatalog(listing).map((entry) => [entry.id, entry.value]));
    const criteria = request.recipe.criteria.map((criterion): CriterionEvaluation => {
      const generated = result.criteria[criterion.id];

      if (!generated) {
        throw invalidOutput({
          stage: "semantic",
          detailCode: "MISSING_CRITERION",
          listingId: listing.id,
          criterionId: criterion.id,
          retryable: true,
          ...options,
        });
      }

      validateEvidenceIds(generated.verdict, generated.evidenceIds, evidenceById, criterion.evidenceRequired !== false, {
        listingId: listing.id,
        criterionId: criterion.id,
        ...options,
      });

      return {
        criterionId: criterion.id,
        verdict: generated.verdict,
        reason: generated.reason,
        evidence: generated.evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)!),
      };
    });

    return {
      listingId: listing.id,
      summary: result.summary,
      criteria,
    };
  });

  return { results: orderedResults };
}

function buildCriterionJsonSchema(
  evidenceIds: readonly string[],
  evidenceReference: string | undefined,
  evidenceRequired: boolean,
): JsonSchema {
  const hasEvidence = evidenceIds.length > 0;

  return {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "evidenceIds"],
    properties: {
      verdict: {
        type: "string",
        enum: hasEvidence || !evidenceRequired ? ["pass", "fail", "unknown"] : ["unknown"],
      },
      reason: { type: "string", minLength: 1, maxLength: 1_000 },
      evidenceIds: {
        type: "array",
        minItems: hasEvidence && evidenceRequired ? 1 : 0,
        maxItems: hasEvidence ? MAX_EVIDENCE_ITEMS : 0,
        items: hasEvidence
          ? { $ref: evidenceReference }
          : { type: "string", minLength: 1, maxLength: 128 },
      },
    },
  };
}

function chunkEvidenceText(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();

  while (remaining.length > MAX_EVIDENCE_VALUE_LENGTH) {
    const whitespaceIndex = findLastWhitespace(remaining, MAX_EVIDENCE_VALUE_LENGTH);
    const splitIndex = whitespaceIndex > 0 ? whitespaceIndex : MAX_EVIDENCE_VALUE_LENGTH;
    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function findLastWhitespace(value: string, beforeIndex: number): number {
  for (let index = beforeIndex; index > 0; index -= 1) {
    if (/\s/u.test(value[index - 1]!)) return index - 1;
  }
  return -1;
}

function validateEvidenceIds(
  verdict: CriterionVerdict,
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, string>,
  evidenceRequired: boolean,
  context: Pick<SafeEvaluatorFailureDetails, "listingId" | "criterionId" | "responseId">,
): void {
  if (evidenceRequired && verdict !== "unknown" && evidenceIds.length === 0) {
    throw invalidOutput({
      stage: "semantic",
      detailCode: "EVIDENCE_REQUIRED",
      retryable: true,
      ...context,
    });
  }

  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw invalidOutput({
      stage: "semantic",
      detailCode: "DUPLICATE_EVIDENCE_ID",
      retryable: true,
      ...context,
    });
  }

  for (const evidenceId of evidenceIds) {
    if (!evidenceById.has(evidenceId)) {
      throw invalidOutput({
        stage: "semantic",
        detailCode: "UNKNOWN_EVIDENCE_ID",
        retryable: true,
        ...context,
      });
    }
  }
}

function assertExactKeys(
  actual: readonly string[],
  expected: readonly string[],
  entity: "LISTING" | "CRITERION",
  options: ParseModelOutputOptions,
  listingId?: string,
): void {
  const expectedIds = new Set(expected);
  const unexpected = actual.find((id) => !expectedIds.has(id));
  if (unexpected) {
    const location = entity === "LISTING"
      ? { listingId: unexpected }
      : { ...(listingId ? { listingId } : {}), criterionId: unexpected };
    throw invalidOutput({
      stage: "semantic",
      detailCode: `UNEXPECTED_${entity}`,
      ...location,
      retryable: true,
      ...options,
    });
  }

  const actualIds = new Set(actual);
  const missing = expected.find((id) => !actualIds.has(id));
  if (missing) {
    const location = entity === "LISTING"
      ? { listingId: missing }
      : { ...(listingId ? { listingId } : {}), criterionId: missing };
    throw invalidOutput({
      stage: "semantic",
      detailCode: `MISSING_${entity}`,
      ...location,
      retryable: true,
      ...options,
    });
  }
}

function locateSchemaFailure(
  error: z.ZodError,
  request: FilterListingsRequest,
): Pick<SafeEvaluatorFailureDetails, "listingId" | "criterionId"> {
  const path = error.issues[0]?.path;
  if (!path || path[0] !== "results") return {};

  const listingId = typeof path[1] === "string" && request.listings.some((listing) => listing.id === path[1])
    ? path[1]
    : undefined;
  const criterionId = listingId && path[2] === "criteria" && typeof path[3] === "string" &&
    request.recipe.criteria.some((criterion) => criterion.id === path[3])
    ? path[3]
    : undefined;

  return {
    ...(listingId ? { listingId } : {}),
    ...(criterionId ? { criterionId } : {}),
  };
}

function invalidOutput(details: SafeEvaluatorFailureDetails, cause?: unknown): ReturnType<typeof invalidModelOutput> {
  return invalidModelOutput(details, cause);
}
