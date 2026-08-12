import {
  evaluationExecutionCreateRequestSchema,
  evaluationExecutionRecordSchema,
  evaluationExecutionResultsSchema,
  ingestionResponseSchema,
  parseListingKey,
  recipeVersionSchema,
  resolvedEvaluationPlanVersionSchema,
  type RecipeVersion,
} from "@denicheur-breizh/contracts";
import type { LocaleCode } from "@denicheur-breizh/i18n";
import {
  resolveRuntimeApiConfig,
  withOperatorAuthorization,
} from "../api/runtimeConfig";
import { parseResolvedEvaluationPlan } from "../intelligence/plan";
import type { IntelligenceRecipe } from "../lib/types";
import type {
  EvaluationExecution,
  EvaluationPlan,
  PlanRecipeEvaluation,
  PlanEvaluation,
  PlanEvaluationStep,
} from "../lib/types";
import type { IngestionRequestPayload } from "./types";

export type SyncFetcher = typeof fetch;

export interface ClearedCollectedDataCounts {
  readonly listings: number;
  readonly runs: number;
  readonly runListings: number;
  readonly evaluations: number;
}

export interface EvaluationExecutionCreatePayload {
  planId: string;
  planVersion: number;
  locale: LocaleCode;
  listingIds?: string[];
  force?: boolean;
}

export interface EvaluationExecutionDetail {
  execution: EvaluationExecution;
  items: PlanEvaluation[];
}

export class ExtensionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ExtensionApiError";
  }
}

export async function configuredApiUrl(): Promise<string> {
  return (await resolveRuntimeApiConfig()).baseUrl;
}

export async function ingestRunBatch(
  runId: string,
  payload: IngestionRequestPayload,
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/ingestion/runs/${encodeURIComponent(runId)}`,
    {
      method: "PUT",
      headers: withOperatorAuthorization({ "Content-Type": "application/json" }, config),
      body: JSON.stringify(payload),
      signal: options.signal,
    },
    options.fetcher,
  );
  const parsed = ingestionResponseSchema.safeParse(await readSuccessJson(response));
  if (!parsed.success || parsed.data.runId !== runId) {
    throw new ExtensionApiError("The API returned an invalid ingestion response.", response.status, "INVALID_API_RESPONSE");
  }
}

export async function fetchActiveRecipe(
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<IntelligenceRecipe> {
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/recipes/active`,
    {
      method: "GET",
      headers: withOperatorAuthorization({}, config),
      signal: options.signal,
    },
    options.fetcher,
  );
  const payload = await readSuccessJson(response);
  const parsed = recipeVersionSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.active) {
    throw new ExtensionApiError("The API returned an invalid active recipe.", response.status, "INVALID_API_RESPONSE");
  }
  return toLocalRecipe(parsed.data);
}

export async function fetchDefaultEvaluationPlan(
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<EvaluationPlan | undefined> {
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/evaluation-plans/default`,
    {
      method: "GET",
      headers: withOperatorAuthorization({}, config),
      signal: options.signal,
    },
    options.fetcher,
  );
  if (response.status === 404) return undefined;
  const payload = await readSuccessJson(response);
  const canonical = resolvedEvaluationPlanVersionSchema.safeParse(payload);
  const parsed = canonical.success ? parseResolvedEvaluationPlan(canonical.data) : undefined;
  if (!parsed || !parsed.isDefault) {
    throw new ExtensionApiError("The API returned an invalid default evaluation plan.", response.status, "INVALID_API_RESPONSE");
  }
  return parsed;
}

export async function createEvaluationExecution(
  runId: string,
  payload: EvaluationExecutionCreatePayload,
  idempotencyKey: string,
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<EvaluationExecution> {
  const requestPayload = evaluationExecutionCreateRequestSchema.safeParse(payload);
  if (!requestPayload.success) {
    throw new ExtensionApiError("The evaluation execution request is invalid.", 400, "CLIENT_VALIDATION");
  }
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}/evaluation-executions`,
    {
      method: "POST",
      headers: withOperatorAuthorization({
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      }, config),
      body: JSON.stringify(requestPayload.data),
      signal: options.signal,
    },
    options.fetcher,
  );
  const responsePayload = await readSuccessJson(response);
  const canonicalExecution = evaluationExecutionRecordSchema.safeParse(responsePayload);
  const execution = canonicalExecution.success ? parseEvaluationExecution(canonicalExecution.data) : undefined;
  if (!execution || execution.runId !== runId ||
    execution.planId !== requestPayload.data.planId || execution.planVersion !== requestPayload.data.planVersion ||
    execution.locale !== requestPayload.data.locale) {
    throw new ExtensionApiError("The API returned an invalid evaluation execution.", response.status, "INVALID_API_RESPONSE");
  }
  return execution;
}

export async function fetchEvaluationExecution(
  executionId: string,
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<EvaluationExecutionDetail> {
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/evaluation-executions/${encodeURIComponent(executionId)}`,
    {
      method: "GET",
      headers: withOperatorAuthorization({}, config),
      signal: options.signal,
    },
    options.fetcher,
  );
  return parseExecutionDetail(await readSuccessJson(response), executionId, response.status);
}

export async function fetchEvaluationExecutionResults(
  executionId: string,
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<EvaluationExecutionDetail> {
  const { execution } = await fetchEvaluationExecution(executionId, options);
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/evaluation-executions/${encodeURIComponent(executionId)}/results`,
    {
      method: "GET",
      headers: withOperatorAuthorization({}, config),
      signal: options.signal,
    },
    options.fetcher,
  );
  const payload = await readSuccessJson(response);
  const canonical = evaluationExecutionResultsSchema.safeParse(payload);
  if (!canonical.success || canonical.data.executionId !== executionId) {
    throw new ExtensionApiError("The API returned invalid evaluation results.", response.status, "INVALID_API_RESPONSE");
  }
  const items = canonical.data.items.flatMap((item) => {
    const parsed = parsePlanEvaluation(item, execution);
    return parsed ? [parsed] : [];
  });
  if (items.length !== canonical.data.items.length) {
    throw new ExtensionApiError("The API returned invalid evaluation results.", response.status, "INVALID_API_RESPONSE");
  }
  return { execution, items };
}

export async function clearApiCollectedData(
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<ClearedCollectedDataCounts> {
  const config = await resolveRuntimeApiConfig(options.baseUrl);
  const response = await request(
    `${config.baseUrl}/v1/maintenance/collected-data/clear`,
    {
      method: "POST",
      headers: withOperatorAuthorization({ "Content-Type": "application/json" }, config),
      body: JSON.stringify({ confirm: "clear-collected-data", runnerLease: "held" }),
      signal: options.signal,
    },
    options.fetcher,
  );
  const payload = await readSuccessJson(response);
  const deleted = isRecord(payload) && isRecord(payload.deleted) ? payload.deleted : undefined;
  if (!deleted) {
    throw new ExtensionApiError("The API returned an invalid cleanup response.", response.status, "INVALID_API_RESPONSE");
  }

  const counts = {
    listings: deleted.listings,
    runs: deleted.runs,
    runListings: deleted.runListings,
    evaluations: deleted.evaluations,
  };
  if (!Object.values(counts).every(isNonNegativeInteger)) {
    throw new ExtensionApiError("The API returned an invalid cleanup response.", response.status, "INVALID_API_RESPONSE");
  }
  return counts as ClearedCollectedDataCounts;
}

async function request(url: string, init: RequestInit, fetcher: SyncFetcher = fetch): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ExtensionApiError(`Local API unavailable: ${errorMessage(error)}`, undefined, "NETWORK_UNAVAILABLE");
  }
}

async function readSuccessJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => undefined);
  if (response.ok) return payload;

  const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const message = typeof apiError?.message === "string"
    ? apiError.message
    : `Local API request failed with status ${response.status}.`;
  const code = typeof apiError?.code === "string" ? apiError.code : undefined;
  throw new ExtensionApiError(message, response.status, code);
}

function toLocalRecipe(recipe: RecipeVersion): IntelligenceRecipe {
  return {
    id: recipe.id,
    version: recipe.version,
    name: recipe.name,
    threshold: recipe.threshold,
    enabled: recipe.active,
    criteria: recipe.criteria.map(({ id, name, description, weight, required, evidenceRequired }) => ({
      id,
      name,
      description,
      weight,
      required,
      evidenceRequired: evidenceRequired !== false,
    })),
  };
}

function parseExecutionDetail(
  payload: unknown,
  expectedExecutionId: string,
  status: number,
): EvaluationExecutionDetail {
  if (!isRecord(payload)) {
    throw new ExtensionApiError("The API returned an invalid evaluation execution detail.", status, "INVALID_API_RESPONSE");
  }
  const execution = parseEvaluationExecution(isRecord(payload.execution) ? payload.execution : payload);
  const canonicalExecution = evaluationExecutionRecordSchema.safeParse(
    isRecord(payload.execution) ? payload.execution : payload,
  );
  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : isRecord(payload.execution) && Array.isArray(payload.results)
      ? payload.results
      : [];
  if (!canonicalExecution.success || !execution || execution.id !== expectedExecutionId) {
    throw new ExtensionApiError("The API returned an invalid evaluation execution detail.", status, "INVALID_API_RESPONSE");
  }
  const items = rawItems.flatMap((item) => {
    const parsed = parsePlanEvaluation(item, execution);
    return parsed ? [parsed] : [];
  });
  return { execution, items };
}

function parseEvaluationExecution(value: unknown): EvaluationExecution | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredText(value.id);
  const runId = requiredText(value.runId);
  const planId = requiredText(value.planId);
  const planVersion = positiveInteger(value.planVersion);
  const locale = value.locale === "fr" || value.locale === "es" || value.locale === "en"
    ? value.locale
    : undefined;
  const statuses = new Set(["queued", "running", "completed", "partial", "failed", "cancelled"]);
  const executionStatus = typeof value.status === "string" && statuses.has(value.status)
    ? value.status as EvaluationExecution["status"]
    : undefined;
  if (!id || !runId || !planId || !planVersion || !locale || !executionStatus) return undefined;
  return {
    id,
    runId,
    planId,
    planVersion,
    locale,
    status: executionStatus,
    createdAt: optionalTextValue(value.createdAt),
    startedAt: optionalTextValue(value.startedAt),
    completedAt: optionalTextValue(value.completedAt),
    error: optionalTextValue(value.error) ?? optionalTextValue(value.lastError),
  };
}

function parsePlanEvaluation(value: unknown, execution: EvaluationExecution): PlanEvaluation | undefined {
  if (!isRecord(value)) return undefined;
  const listingKey = requiredText(value.listingId);
  const identity = listingKey ? parseListingKey(listingKey) : undefined;
  const listingId = identity?.externalId ?? listingKey;
  const decision = value.decision === "relevant" || value.decision === "not-relevant" || value.decision === "review"
    ? value.decision
    : undefined;
  const score = value.score === null || (typeof value.score === "number" && Number.isFinite(value.score))
    ? value.score
    : null;
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps.flatMap((step) => {
    const parsed = parsePlanEvaluationStep(step, listingId);
    return parsed ? [parsed] : [];
  });
  if (!listingId || !decision || steps.length !== rawSteps.length) return undefined;
  return {
    executionId: execution.id,
    listingId,
    planId: execution.planId,
    planVersion: execution.planVersion,
    decision,
    score,
    summary: optionalTextValue(value.summary) ?? decision,
    locale: execution.locale,
    evaluatedAt: optionalTextValue(value.evaluatedAt) ?? execution.completedAt,
    steps,
  };
}

function parsePlanEvaluationStep(
  value: unknown,
  listingId: string | undefined,
): PlanEvaluationStep | undefined {
  if (!isRecord(value)) return undefined;
  const recipeId = requiredText(value.recipeId);
  const recipeVersion = positiveInteger(value.recipeVersion);
  const statuses = new Set(["succeeded", "cached", "failed", "skipped"]);
  const status = typeof value.status === "string" && statuses.has(value.status)
    ? value.status as PlanEvaluationStep["status"]
    : undefined;
  if (!recipeId || !recipeVersion || !status) return undefined;
  const evaluation = parseListingEvaluation(value.evaluation, listingId);
  const evaluator = isRecord(value.evaluator) && value.evaluator.provider === "openai" &&
    requiredText(value.evaluator.model) && requiredText(value.evaluator.version)
    ? {
        provider: "openai" as const,
        model: requiredText(value.evaluator.model)!,
        version: requiredText(value.evaluator.version)!,
      }
    : undefined;
  const error = isRecord(value.error) && requiredText(value.error.code)
    ? {
        code: requiredText(value.error.code)!,
        message: optionalTextValue(value.error.message),
        retryable: typeof value.error.retryable === "boolean" ? value.error.retryable : undefined,
      }
    : undefined;
  return {
    recipeId,
    recipeVersion,
    status,
    ...(evaluation ? { evaluation } : {}),
    ...(evaluator ? { evaluator } : {}),
    ...(error ? { error } : {}),
  };
}

function parseListingEvaluation(
  value: unknown,
  listingId: string | undefined,
): PlanRecipeEvaluation | undefined {
  if (!isRecord(value) || !listingId) return undefined;
  const decision = value.decision === "relevant" || value.decision === "not-relevant" || value.decision === "review"
    ? value.decision
    : undefined;
  const score = value.score === null || (typeof value.score === "number" && Number.isFinite(value.score))
    ? value.score
    : undefined;
  const criteria = Array.isArray(value.criteria) ? value.criteria.flatMap((criterion) => {
    if (!isRecord(criterion)) return [];
    const criterionId = requiredText(criterion.criterionId);
    const verdict = criterion.verdict === "pass" || criterion.verdict === "fail" || criterion.verdict === "unknown"
      ? criterion.verdict
      : undefined;
    if (!criterionId || !verdict) return [];
    return [{
      criterionId,
      verdict: verdict as "pass" | "fail" | "unknown",
      reason: optionalTextValue(criterion.reason) ?? "",
      evidence: Array.isArray(criterion.evidence)
        ? criterion.evidence.filter((item): item is string => typeof item === "string")
        : [],
    }];
  }) : [];
  if (!decision || score === undefined) return undefined;
  return {
    listingId,
    decision,
    score,
    summary: optionalTextValue(value.summary) ?? decision,
    criteria,
    missingData: Array.isArray(value.missingData)
      ? value.missingData.filter((item): item is string => typeof item === "string")
      : [],
    evaluatedAt: optionalTextValue(value.evaluatedAt) ?? new Date(0).toISOString(),
  };
}

function requiredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalTextValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
