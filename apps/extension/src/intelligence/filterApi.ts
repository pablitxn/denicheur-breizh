import {
  createListingKey,
  evaluationRequestSchema,
  filterListingsResponseSchema,
  MAX_LISTINGS_PER_REQUEST,
  parseListingKey,
} from "@denicheur-breizh/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@denicheur-breizh/i18n";
import type {
  IntelligenceRecipe,
  ListingEvaluation,
  LocalizedText,
  ScrapedPropertyRecord,
} from "../lib/types";
import { configuredApiUrl } from "../sync/api";

type Fetcher = typeof fetch;

const FILTER_API_ERROR_MESSAGE_IDS: Record<string, string> = {
  NETWORK_UNAVAILABLE: "error.apiUnavailable",
  OPENAI_NOT_CONFIGURED: "error.apiNotConfigured",
  OPENAI_TIMEOUT: "error.apiTimeout",
  OPENAI_RATE_LIMITED: "error.apiRateLimited",
  OPENAI_UNAVAILABLE: "error.apiUnavailable",
  OPENAI_REJECTED: "error.apiRejected",
  OPENAI_FAILURE: "error.apiFailure",
  INVALID_MODEL_OUTPUT: "error.apiInvalidOutput",
  RATE_LIMITED: "error.apiRateLimited",
  INVALID_REQUEST: "error.apiInvalidRequest",
  PAYLOAD_TOO_LARGE: "error.apiPayloadTooLarge",
  INVALID_JSON: "error.apiInvalidResponse",
  INTERNAL_ERROR: "error.apiFailure",
  ORIGIN_NOT_ALLOWED: "error.apiOriginNotAllowed",
  NOT_FOUND: "error.apiNotFound",
  INVALID_API_RESPONSE: "error.apiInvalidResponse",
  CLIENT_VALIDATION: "error.apiInvalidRequest",
};

interface EvaluationOptions {
  signal?: AbortSignal;
  fetcher?: Fetcher;
  baseUrl?: string;
  locale?: LocaleCode;
  onBatchComplete?: (
    batch: ListingEvaluation[],
    accumulated: ListingEvaluation[],
  ) => void | Promise<void>;
}

export class FilterApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FilterApiError";
  }
}

export async function evaluateDetailedRecords(
  runId: string,
  recipe: IntelligenceRecipe,
  records: ScrapedPropertyRecord[],
  options: EvaluationOptions = {},
): Promise<ListingEvaluation[]> {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const detailedRecords = records.filter((record) => record.status === "detailed");
  if (detailedRecords.length === 0) {
    throw clientValidationError("No detailed listings are available for evaluation.");
  }
  if (detailedRecords.length > MAX_LISTINGS_PER_REQUEST) {
    throw clientValidationError(`Evaluate at most ${MAX_LISTINGS_PER_REQUEST} detailed listings per request.`);
  }

  const request = evaluationRequestSchema.safeParse({
    locale,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    listingIds: detailedRecords.map((record) => createListingKey({
      source: record.source,
      externalId: record.id,
    })),
  });
  if (!request.success) {
    throw clientValidationError("The evaluation request is invalid.");
  }

  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl ?? configuredApiUrl()).replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/evaluations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.data),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new FilterApiError(
      `Intelligence API is unavailable: ${errorMessage(error)}`,
      undefined,
      "NETWORK_UNAVAILABLE",
    );
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = readApiError(payload, response.status);
    throw new FilterApiError(apiError.message, response.status, apiError.code);
  }

  const parsed = filterListingsResponseSchema.safeParse(payload);
  if (!parsed.success ||
    parsed.data.runId !== runId ||
    parsed.data.locale !== locale ||
    parsed.data.recipeId !== recipe.id ||
    parsed.data.recipeVersion !== recipe.version) {
    throw invalidApiResponse("Intelligence API response does not match the request.");
  }

  const expected = new Set(request.data.listingIds);
  const seen = new Set<string>();
  const expectedCriteria = new Set(recipe.criteria.map((criterion) => criterion.id));
  const evaluations = parsed.data.results.map((result): ListingEvaluation => {
    const identity = parseListingKey(result.listingId);
    if (!identity || !expected.has(result.listingId) || seen.has(result.listingId)) {
      throw invalidApiResponse("Intelligence API returned unexpected or duplicate listing ids.");
    }
    seen.add(result.listingId);

    const criterionIds = result.criteria.map((criterion) => criterion.criterionId);
    if (new Set(criterionIds).size !== expectedCriteria.size ||
      criterionIds.some((criterionId) => !expectedCriteria.has(criterionId))) {
      throw invalidApiResponse("Intelligence API did not evaluate every criterion.");
    }

    return {
      ...result,
      listingId: identity.externalId,
      locale: parsed.data.locale,
      evaluator: parsed.data.evaluator,
      recipeId: parsed.data.recipeId,
      recipeVersion: parsed.data.recipeVersion,
    };
  });
  if (seen.size !== expected.size) {
    throw invalidApiResponse("Intelligence API did not evaluate every listing.");
  }
  return evaluations;
}

export function filterApiErrorDescriptor(error: unknown): LocalizedText {
  const id = error instanceof FilterApiError && error.code
    ? FILTER_API_ERROR_MESSAGE_IDS[error.code]
    : undefined;
  if (id) return { id };

  return {
    id: "error.intelligenceFailed",
    technicalDetail: errorMessage(error),
  };
}

export async function evaluateDetailedRecordsInBatches(
  runId: string,
  recipe: IntelligenceRecipe,
  records: ScrapedPropertyRecord[],
  options: EvaluationOptions = {},
): Promise<ListingEvaluation[]> {
  const detailedRecords = records.filter((record) => record.status === "detailed");
  if (detailedRecords.length === 0) {
    throw clientValidationError("No detailed listings are available for evaluation.");
  }
  if (new Set(detailedRecords.map((record) => `${record.source}:${record.id}`)).size !== detailedRecords.length) {
    throw clientValidationError("Detailed listings must have unique ids before evaluation.");
  }

  const evaluations: ListingEvaluation[] = [];
  for (let index = 0; index < detailedRecords.length; index += MAX_LISTINGS_PER_REQUEST) {
    if (options.signal?.aborted) throw new DOMException("Evaluation cancelled.", "AbortError");
    const batch = await evaluateDetailedRecords(
      runId,
      recipe,
      detailedRecords.slice(index, index + MAX_LISTINGS_PER_REQUEST),
      options,
    );
    evaluations.push(...batch);
    await options.onBatchComplete?.(batch, [...evaluations]);
  }
  return evaluations;
}

export function mergeRecordEvaluations(
  records: ScrapedPropertyRecord[],
  evaluations: ListingEvaluation[],
): ScrapedPropertyRecord[] {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.listingId, evaluation]));
  return records.map((record) => {
    const evaluation = byId.get(record.id);
    return evaluation ? { ...record, evaluation } : record;
  });
}

function readApiError(payload: unknown, status: number): { message: string; code?: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string"
      ? payload.error.message
      : `Intelligence API request failed with status ${status}.`;
    const code = typeof payload.error.code === "string" ? payload.error.code : undefined;
    return { message, code };
  }
  return { message: `Intelligence API request failed with status ${status}.` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientValidationError(message: string): FilterApiError {
  return new FilterApiError(message, undefined, "CLIENT_VALIDATION");
}

function invalidApiResponse(message: string): FilterApiError {
  return new FilterApiError(message, undefined, "INVALID_API_RESPONSE");
}
