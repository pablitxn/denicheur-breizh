import {
  createListingKey,
  evaluationBatchResponseSchema,
  evaluationRequestSchema,
  MAX_LISTINGS_PER_REQUEST,
  parseListingKey,
} from "@denicheur-breizh/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@denicheur-breizh/i18n";
import type {
  IntelligenceRecipe,
  ListingEvaluation,
  ListingEvaluationFailure,
  ListingEvaluationOutcome,
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
  OPENAI_INSUFFICIENT_QUOTA: "error.apiInsufficientQuota",
  OPENAI_UNAVAILABLE: "error.apiUnavailable",
  OPENAI_REJECTED: "error.apiRejected",
  OPENAI_REFUSAL: "error.apiRefusal",
  MODEL_REFUSAL: "error.apiRefusal",
  OPENAI_INCOMPLETE: "error.apiIncomplete",
  MAX_OUTPUT_TOKENS: "error.apiIncomplete",
  OPENAI_CONTENT_FILTER: "error.apiContentFilter",
  CONTENT_FILTER: "error.apiContentFilter",
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
  SYNC_FAILED: "error.apiUnavailable",
  MISSING_LISTING: "error.apiInvalidOutput",
  DUPLICATE_LISTING: "error.apiInvalidOutput",
  UNEXPECTED_LISTING: "error.apiInvalidOutput",
  MISSING_CRITERION: "error.apiInvalidOutput",
  DUPLICATE_CRITERION: "error.apiInvalidOutput",
  UNEXPECTED_CRITERION: "error.apiInvalidOutput",
  EVIDENCE_REQUIRED: "error.apiInvalidOutput",
  UNKNOWN_EVIDENCE_ID: "error.apiInvalidOutput",
  CROSS_LISTING_EVIDENCE: "error.apiInvalidOutput",
  EMPTY_OUTPUT: "error.apiInvalidOutput",
  SCHEMA_MISMATCH: "error.apiInvalidOutput",
};

interface EvaluationOptions {
  signal?: AbortSignal;
  fetcher?: Fetcher;
  baseUrl?: string;
  locale?: LocaleCode;
  force?: boolean;
  onBatchComplete?: (
    batch: ListingEvaluationOutcome,
    accumulated: ListingEvaluationOutcome,
  ) => void | Promise<void>;
}

export class FilterApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
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
): Promise<ListingEvaluationOutcome> {
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
    ...(options.force ? { force: true } : {}),
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
    return createEvaluationFailureOutcome(detailedRecords, new FilterApiError(
      `Intelligence API is unavailable: ${errorMessage(error)}`,
      undefined,
      "NETWORK_UNAVAILABLE",
    ));
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = readApiError(payload, response.status);
    return createEvaluationFailureOutcome(detailedRecords, new FilterApiError(
      apiError.message,
      response.status,
      apiError.code ?? fallbackHttpErrorCode(response.status),
      apiError.requestId,
    ));
  }

  const parsed = evaluationBatchResponseSchema.safeParse(payload);
  if (!parsed.success ||
    parsed.data.runId !== runId ||
    parsed.data.locale !== locale ||
    parsed.data.recipeId !== recipe.id ||
    parsed.data.recipeVersion !== recipe.version) {
    return createEvaluationFailureOutcome(
      detailedRecords,
      invalidApiResponse("Intelligence API response does not match the request.", readRequestId(payload)),
    );
  }

  const expected = new Set(request.data.listingIds);
  const seen = new Set<string>();
  const expectedCriteria = new Set(recipe.criteria.map((criterion) => criterion.id));
  const evaluations: ListingEvaluation[] = [];
  const failures: ListingEvaluationFailure[] = [];
  for (const item of parsed.data.items) {
    const identity = parseListingKey(item.listingId);
    if (!identity || !expected.has(item.listingId) || seen.has(item.listingId)) {
      return createEvaluationFailureOutcome(
        detailedRecords,
        invalidApiResponse("Intelligence API returned unexpected or duplicate listing ids.", parsed.data.requestId),
      );
    }
    seen.add(item.listingId);

    if (item.status === "failed") {
      failures.push({
        listingId: identity.externalId,
        code: item.error.code,
        stage: item.error.stage,
        retryable: item.error.retryable,
        requestId: item.error.requestId,
        ...(item.error.attemptId ? { attemptId: item.error.attemptId } : {}),
        ...(item.error.criterionId ? { criterionId: item.error.criterionId } : {}),
      });
      continue;
    }

    const criterionIds = item.evaluation.criteria.map((criterion) => criterion.criterionId);
    if (new Set(criterionIds).size !== expectedCriteria.size ||
      criterionIds.some((criterionId) => !expectedCriteria.has(criterionId))) {
      failures.push({
        listingId: identity.externalId,
        code: "INVALID_API_RESPONSE",
        stage: "response",
        retryable: true,
        requestId: parsed.data.requestId,
      });
      continue;
    }

    evaluations.push({
      ...item.evaluation,
      listingId: identity.externalId,
      locale: parsed.data.locale,
      evaluator: item.evaluator,
      recipeId: parsed.data.recipeId,
      recipeVersion: parsed.data.recipeVersion,
    });
  }
  if (seen.size !== expected.size) {
    return createEvaluationFailureOutcome(
      detailedRecords,
      invalidApiResponse("Intelligence API did not evaluate every listing.", parsed.data.requestId),
    );
  }
  return { evaluations, failures };
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

export function evaluationFailureDescriptor(failure: ListingEvaluationFailure): LocalizedText {
  return {
    id: FILTER_API_ERROR_MESSAGE_IDS[failure.code] ?? "error.intelligenceFailed",
  };
}

export async function evaluateDetailedRecordsInBatches(
  runId: string,
  recipe: IntelligenceRecipe,
  records: ScrapedPropertyRecord[],
  options: EvaluationOptions = {},
): Promise<ListingEvaluationOutcome> {
  const detailedRecords = records.filter((record) => record.status === "detailed");
  if (detailedRecords.length === 0) {
    throw clientValidationError("No detailed listings are available for evaluation.");
  }
  if (new Set(detailedRecords.map((record) => `${record.source}:${record.id}`)).size !== detailedRecords.length) {
    throw clientValidationError("Detailed listings must have unique ids before evaluation.");
  }

  const accumulated: ListingEvaluationOutcome = { evaluations: [], failures: [] };
  for (let index = 0; index < detailedRecords.length; index += MAX_LISTINGS_PER_REQUEST) {
    if (options.signal?.aborted) throw new DOMException("Evaluation cancelled.", "AbortError");
    const batch = await evaluateDetailedRecords(
      runId,
      recipe,
      detailedRecords.slice(index, index + MAX_LISTINGS_PER_REQUEST),
      options,
    );
    accumulated.evaluations.push(...batch.evaluations);
    accumulated.failures.push(...batch.failures);
    await options.onBatchComplete?.(batch, {
      evaluations: [...accumulated.evaluations],
      failures: [...accumulated.failures],
    });
  }
  return accumulated;
}

export function mergeRecordEvaluations(
  records: ScrapedPropertyRecord[],
  evaluations: ListingEvaluation[],
): ScrapedPropertyRecord[] {
  return mergeRecordEvaluationOutcome(records, { evaluations, failures: [] });
}

export function mergeRecordEvaluationOutcome(
  records: ScrapedPropertyRecord[],
  outcome: ListingEvaluationOutcome,
): ScrapedPropertyRecord[] {
  const evaluationsById = new Map(
    outcome.evaluations.map((evaluation) => [evaluation.listingId, evaluation]),
  );
  const failuresById = new Map(
    outcome.failures.map((failure) => [failure.listingId, failure]),
  );
  return records.map((record) => {
    const evaluation = evaluationsById.get(record.id);
    if (evaluation) {
      const { evaluationFailure: _evaluationFailure, ...recordWithoutFailure } = record;
      return { ...recordWithoutFailure, evaluation };
    }
    const evaluationFailure = failuresById.get(record.id);
    return evaluationFailure ? { ...record, evaluationFailure } : record;
  });
}

export function createEvaluationFailureOutcome(
  records: ScrapedPropertyRecord[],
  error: unknown,
): ListingEvaluationOutcome {
  const code = error instanceof FilterApiError && error.code
    ? error.code
    : "INTERNAL_ERROR";
  return {
    evaluations: [],
    failures: records.map((record) => ({
      listingId: record.id,
      code,
      stage: failureStage(code),
      retryable: isRetryableFailure(code),
      ...(error instanceof FilterApiError && error.requestId
        ? { requestId: error.requestId }
        : {}),
    })),
  };
}

function readApiError(
  payload: unknown,
  status: number,
): { message: string; code?: string; requestId?: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string"
      ? payload.error.message
      : `Intelligence API request failed with status ${status}.`;
    const code = typeof payload.error.code === "string" ? payload.error.code : undefined;
    const requestId = typeof payload.error.requestId === "string"
      ? payload.error.requestId
      : readRequestId(payload);
    return { message, code, requestId };
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

function invalidApiResponse(message: string, requestId?: string): FilterApiError {
  return new FilterApiError(message, undefined, "INVALID_API_RESPONSE", requestId);
}

function readRequestId(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.requestId === "string"
    ? payload.requestId
    : undefined;
}

function fallbackHttpErrorCode(status: number): string {
  if (status === 408 || status === 504) return "OPENAI_TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "OPENAI_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

function failureStage(code: string): string {
  if (code === "NETWORK_UNAVAILABLE") return "provider";
  if (code === "INVALID_API_RESPONSE" || code === "INVALID_JSON") return "response";
  if (code === "SYNC_FAILED") return "internal";
  return code.startsWith("OPENAI_") || code === "RATE_LIMITED" ? "provider" : "internal";
}

function isRetryableFailure(code: string): boolean {
  return new Set([
    "NETWORK_UNAVAILABLE",
    "OPENAI_TIMEOUT",
    "OPENAI_RATE_LIMITED",
    "OPENAI_UNAVAILABLE",
    "OPENAI_INCOMPLETE",
    "MAX_OUTPUT_TOKENS",
    "INVALID_MODEL_OUTPUT",
    "EMPTY_OUTPUT",
    "SCHEMA_MISMATCH",
    "INVALID_API_RESPONSE",
    "INVALID_JSON",
    "RATE_LIMITED",
    "SYNC_FAILED",
  ]).has(code) || [
    "MISSING_LISTING",
    "DUPLICATE_LISTING",
    "UNEXPECTED_LISTING",
    "MISSING_CRITERION",
    "DUPLICATE_CRITERION",
    "UNEXPECTED_CRITERION",
    "EVIDENCE_REQUIRED",
    "UNKNOWN_EVIDENCE_ID",
    "CROSS_LISTING_EVIDENCE",
  ].includes(code);
}
