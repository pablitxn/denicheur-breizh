import {
  DEFAULT_LOCALE,
  isLocaleCode,
  type LocaleCode,
} from "@denicheur-breizh/i18n";
import type {
  IntelligenceRecipe,
  ListingEvaluation,
  LocalizedText,
  ScrapedPropertyRecord,
} from "../lib/types";

const DEFAULT_FILTER_API_URL = "http://127.0.0.1:4310";

interface FilterListingInput {
  id: string;
  url: string;
  title?: string;
  priceEuros?: number;
  propertyType?: string;
  rooms?: number;
  bedrooms?: number;
  surfaceM2?: number;
  landSurfaceM2?: number;
  location?: string;
  sellerName?: string;
  sellerType?: string;
  energyClass?: string;
  gesClass?: string;
  description?: string;
  features: string[];
}

interface FilterListingsResponse {
  runId: string;
  locale: LocaleCode;
  recipeId: string;
  recipeVersion: number;
  evaluator: ListingEvaluation["evaluator"];
  results: Array<Omit<ListingEvaluation, "evaluator" | "recipeId" | "recipeVersion" | "locale">>;
}

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

  if (detailedRecords.length > 20) {
    throw clientValidationError("Evaluate at most 20 detailed listings per request.");
  }

  const listings = detailedRecords.map(toFilterListingInput);

  if (listings.length === 0) {
    throw clientValidationError("No detailed listings are available for evaluation.");
  }

  const fetcher = options.fetcher ?? fetch;
  const baseUrl = (options.baseUrl ?? configuredFilterApiUrl()).replace(/\/$/, "");
  let response: Response;

  try {
    response = await fetcher(`${baseUrl}/v1/listings/filter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        locale,
        recipe: {
          id: recipe.id,
          version: recipe.version,
          name: recipe.name,
          threshold: recipe.threshold,
          criteria: recipe.criteria,
        },
        listings,
      }),
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

  const parsed = parseFilterResponse(
    payload,
    runId,
    locale,
    recipe,
    listings.map((listing) => listing.id),
  );
  return parsed.results.map((result) => ({
    ...result,
    locale: parsed.locale,
    evaluator: parsed.evaluator,
    recipeId: parsed.recipeId,
    recipeVersion: parsed.recipeVersion,
  }));
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
  if (new Set(detailedRecords.map((record) => record.id)).size !== detailedRecords.length) {
    throw clientValidationError("Detailed listings must have unique ids before evaluation.");
  }

  const evaluations: ListingEvaluation[] = [];
  for (let index = 0; index < detailedRecords.length; index += 20) {
    if (options.signal?.aborted) throw new DOMException("Evaluation cancelled.", "AbortError");
    const batch = detailedRecords.slice(index, index + 20);
    const batchNumber = Math.floor(index / 20) + 1;
    evaluations.push(
      ...await evaluateDetailedRecords(`${runId}-batch-${batchNumber}`, recipe, batch, options),
    );
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

function toFilterListingInput(record: ScrapedPropertyRecord): FilterListingInput {
  const id = record.id.trim();
  if (!id || id.length > 128) throw clientValidationError("A listing has an invalid id.");

  const url = canonicalListingUrl(record.listingUrl);
  return {
    id,
    url,
    title: optionalTruncate(record.title, 300),
    priceEuros: record.priceEuros,
    propertyType: optionalTruncate(record.propertyType, 120),
    rooms: record.rooms,
    bedrooms: record.bedrooms,
    surfaceM2: record.surfaceM2,
    landSurfaceM2: record.landSurfaceM2,
    location: optionalTruncate(record.location, 300),
    sellerName: optionalTruncate(record.sellerName, 300),
    sellerType: optionalTruncate(record.sellerType, 120),
    energyClass: optionalTruncate(record.energyClass, 20),
    gesClass: optionalTruncate(record.gesClass, 20),
    description: optionalTruncate(record.description, 6_000),
    features: record.features.slice(0, 50).map((feature) => truncate(feature, 160)).filter(Boolean),
  };
}

function canonicalListingUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    const canonical = url.toString();
    if (url.protocol !== "https:" || canonical.length > 2_048) throw new Error("invalid listing URL");
    return canonical;
  } catch {
    throw clientValidationError("A listing has an invalid URL.");
  }
}

function optionalTruncate(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const truncated = truncate(value, maximum);
  return truncated || undefined;
}

function truncate(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function configuredFilterApiUrl(): string {
  const configured = import.meta.env.WXT_FILTER_API_URL as string | undefined;
  return configured?.trim() || DEFAULT_FILTER_API_URL;
}

function parseFilterResponse(
  payload: unknown,
  runId: string,
  locale: LocaleCode,
  recipe: IntelligenceRecipe,
  listingIds: string[],
): FilterListingsResponse {
  if (!isRecord(payload)) throw invalidApiResponse("Intelligence API returned an invalid response.");
  if (
    payload.runId !== runId ||
    payload.locale !== locale ||
    payload.recipeId !== recipe.id ||
    payload.recipeVersion !== recipe.version
  ) {
    throw invalidApiResponse("Intelligence API response does not match the request.");
  }
  if (!isLocaleCode(payload.locale) || !isEvaluator(payload.evaluator) || !Array.isArray(payload.results)) {
    throw invalidApiResponse("Intelligence API returned an invalid response.");
  }

  const expected = new Set(listingIds);
  const seen = new Set<string>();
  const results = payload.results.map((value) => parseEvaluation(value, recipe));
  for (const result of results) {
    if (!expected.has(result.listingId) || seen.has(result.listingId)) {
      throw invalidApiResponse("Intelligence API returned unexpected or duplicate listing ids.");
    }
    seen.add(result.listingId);
  }
  if (seen.size !== expected.size) {
    throw invalidApiResponse("Intelligence API did not evaluate every listing.");
  }

  return {
    runId,
    locale: payload.locale,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    evaluator: payload.evaluator,
    results,
  };
}

function parseEvaluation(
  value: unknown,
  recipe: IntelligenceRecipe,
): Omit<ListingEvaluation, "evaluator" | "recipeId" | "recipeVersion"> {
  if (!isRecord(value)) throw invalidApiResponse("Intelligence API returned an invalid evaluation.");
  if (
    typeof value.listingId !== "string" ||
    !isDecision(value.decision) ||
    !(value.score === null || (typeof value.score === "number" && value.score >= 0 && value.score <= 100)) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.criteria) ||
    !isStringArray(value.missingData) ||
    typeof value.evaluatedAt !== "string"
  ) {
    throw invalidApiResponse("Intelligence API returned an invalid evaluation.");
  }

  const expectedCriteria = new Set(recipe.criteria.map((criterion) => criterion.id));
  const seenCriteria = new Set<string>();
  const criteria = value.criteria.map((criterion) => {
    if (
      !isRecord(criterion) ||
      typeof criterion.criterionId !== "string" ||
      !isVerdict(criterion.verdict) ||
      typeof criterion.reason !== "string" ||
      !isStringArray(criterion.evidence) ||
      !expectedCriteria.has(criterion.criterionId) ||
      seenCriteria.has(criterion.criterionId)
    ) {
      throw invalidApiResponse("Intelligence API returned invalid criterion results.");
    }
    seenCriteria.add(criterion.criterionId);
    return {
      criterionId: criterion.criterionId,
      verdict: criterion.verdict,
      reason: criterion.reason,
      evidence: criterion.evidence,
    };
  });
  if (seenCriteria.size !== expectedCriteria.size) {
    throw invalidApiResponse("Intelligence API did not evaluate every criterion.");
  }

  return {
    listingId: value.listingId,
    decision: value.decision,
    score: value.score,
    summary: value.summary,
    criteria,
    missingData: value.missingData,
    evaluatedAt: value.evaluatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEvaluator(value: unknown): value is ListingEvaluation["evaluator"] {
  return isRecord(value) && value.provider === "openai" && typeof value.model === "string" && typeof value.version === "string";
}

function isDecision(value: unknown): value is ListingEvaluation["decision"] {
  return value === "relevant" || value === "not-relevant" || value === "review";
}

function isVerdict(value: unknown): value is "pass" | "fail" | "unknown" {
  return value === "pass" || value === "fail" || value === "unknown";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clientValidationError(message: string): FilterApiError {
  return new FilterApiError(message, undefined, "CLIENT_VALIDATION");
}

function invalidApiResponse(message: string): FilterApiError {
  return new FilterApiError(message, undefined, "INVALID_API_RESPONSE");
}
