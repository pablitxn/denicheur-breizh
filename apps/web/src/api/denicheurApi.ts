import {
  evaluationExecutionCreateRequestSchema,
  evaluationExecutionRecordSchema,
  evaluationExecutionResultsSchema,
  evaluationExecutionsPageSchema,
  evaluationPlanDraftSchema,
  evaluationPlanVersionSchema,
  evaluationPlansResponseSchema,
  healthDetailsResponseSchema,
  listingDetailSchema,
  listingsPageSchema,
  listingsMapPageSchema,
  listingsMetadataSchema,
  recipeDraftSchema,
  recipeVersionSchema,
  recipesResponseSchema,
  resolvedEvaluationPlanVersionSchema,
  runDetailSchema,
  runListingsPageSchema,
  runsPageSchema,
  sourceRecordSchema,
  sourceRecordsPageSchema,
  type EvaluationExecutionRecord,
  type EvaluationExecutionResults,
  type EvaluationExecutionsPage,
  type EvaluationPlanVersion,
  type HealthDetailsResponse,
  type ListingImageAsset,
  type ListingDetail,
  type ListingEvaluationRecord,
  type ListingRecord,
  type ListingsPage,
  type ListingMapSummary,
  type ListingsMetadata,
  type RecipeVersion,
  type RunDetail,
  type RunListingsPage,
  type RunsPage,
  type SourceRecord,
  type SourceRecordsPage,
} from "@denicheur-breizh/contracts";
import type {
  EvaluationExecution,
  EvaluationPlan,
  EvaluationPlanDraft,
  HealthStatus,
  IntelligenceRecipe,
  ListingFilters,
  PaginatedListings,
  PropertyImageAsset,
  PropertyListing,
  PropertyMapListing,
  RecipeDraft,
  StartEvaluationExecutionInput,
} from "../types";
import { API_BASE_URL } from "../config/apiBaseUrl";

export { API_BASE_URL } from "../config/apiBaseUrl";

export class DenicheurApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "DenicheurApiError";
  }
}

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export interface ConditionalValue<T> { value: T; etag?: string }
export interface MapCatalog { items: PropertyMapListing[]; total: number }

export function isExpiredCursor(error: unknown): boolean {
  return error instanceof DenicheurApiError && error.status === 410;
}

async function requestJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await requestConditionalJson(path, schema, init, signal);
  if (response.value === null) throw new DenicheurApiError("Unexpected empty response.", 304, "INVALID_API_RESPONSE");
  return response.value;
}

async function requestConditionalJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  init?: RequestInit,
  signal?: AbortSignal,
  etag?: string,
): Promise<{ value: T | null; etag?: string }> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (etag) headers.set("If-None-Match", etag);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DenicheurApiError(error instanceof Error ? error.message : "API unavailable");
  }

  if (response.status === 304 && etag) return { value: null, etag };
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = readApiError(payload);
    throw new DenicheurApiError(apiError.message ?? `API request failed: ${response.status}`, response.status, apiError.code);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DenicheurApiError("The API returned a response that does not match the shared contract.", response.status, "INVALID_API_RESPONSE");
  }
  return { value: parsed.data, etag: response.headers.get("ETag") ?? undefined };
}

export const denicheurApi = {
  async listSourceRecords(
    source: string,
    externalId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ): Promise<SourceRecordsPage> {
    const params = new URLSearchParams({ limit: "20" });
    if (beforeSequence !== undefined) params.set("beforeSequence", String(beforeSequence));
    return requestJson(
      `/v1/listings/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}/source-records?${params}`,
      sourceRecordsPageSchema,
      undefined,
      signal,
    );
  },

  async getSourceRecord(id: string, signal?: AbortSignal): Promise<SourceRecord> {
    return requestJson(`/v1/source-records/${encodeURIComponent(id)}`, sourceRecordSchema, undefined, signal);
  },

  async listingsMetadata(previous?: ConditionalValue<ListingsMetadata>, signal?: AbortSignal): Promise<ConditionalValue<ListingsMetadata>> {
    const response = await requestConditionalJson("/v1/listings/metadata", listingsMetadataSchema, undefined, signal, previous?.etag);
    return response.value === null && previous ? previous : { value: response.value!, etag: response.etag };
  },

  async listMapCatalog(previous?: ConditionalValue<MapCatalog>, signal?: AbortSignal): Promise<ConditionalValue<MapCatalog>> {
    // Commit only a complete traversal. An expired snapshot restarts once; partial pages never leak into the map.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const first = await requestConditionalJson("/v1/listings/map?limit=500", listingsMapPageSchema, undefined, signal, attempt === 0 ? previous?.etag : undefined);
        if (first.value === null && previous) return previous;
        if (!first.value) throw new DenicheurApiError("Unexpected empty map response.", 304, "INVALID_API_RESPONSE");
        const items = first.value.items.map(normalizeMapListing);
        const seen = new Set<string>();
        let cursor = first.value.nextCursor;
        while (cursor) {
          if (seen.has(cursor)) throw new DenicheurApiError("The API repeated a pagination cursor.", undefined, "INVALID_API_RESPONSE");
          seen.add(cursor);
          const params = new URLSearchParams({ limit: "500", cursor });
          const page = await requestJson(`/v1/listings/map?${params}`, listingsMapPageSchema, undefined, signal);
          items.push(...page.items.map(normalizeMapListing));
          cursor = page.nextCursor;
        }
        return { value: { items, total: first.value.total }, etag: first.etag };
      } catch (error) {
        if (attempt > 0 || !isExpiredCursor(error)) throw error;
      }
    }
    throw new DenicheurApiError("The catalog could not be loaded.");
  },

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const health: HealthDetailsResponse = await requestJson(
      "/v1/health/details",
      healthDetailsResponseSchema,
      undefined,
      signal,
    );
    return {
      status: health.database.status === "ok" ? "ok" : "degraded",
      database: health.database.status === "ok" ? "ok" : "unavailable",
      media: health.media,
      openAiConfigured: health.openAiConfigured,
    };
  },

  async listProperties(filters: ListingFilters = {}, signal?: AbortSignal): Promise<PaginatedListings> {
    const params = listingSearchParams(filters);
    const page: ListingsPage = await requestJson(`/v1/listings?${params}`, listingsPageSchema, undefined, signal);
    return { items: page.items.map((item) => normalizeListing(item)), nextCursor: page.nextCursor, total: page.total };
  },

  async getProperty(source: string, externalId: string, signal?: AbortSignal): Promise<PropertyListing> {
    const detail: ListingDetail = await requestJson(
      `/v1/listings/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`,
      listingDetailSchema,
      undefined,
      signal,
    );
    return normalizeListing(detail, detail);
  },

  async listRuns(signal?: AbortSignal, cursor?: string): Promise<RunsPage> {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    return requestJson(`/v1/runs?${params}`, runsPageSchema, undefined, signal);
  },

  async getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    return requestJson(`/v1/runs/${encodeURIComponent(runId)}`, runDetailSchema, undefined, signal);
  },

  async listRunListings(
    runId: string,
    options: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<RunListingsPage> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.size > 0 ? `?${params}` : "";
    return requestJson(
      `/v1/runs/${encodeURIComponent(runId)}/listings${query}`,
      runListingsPageSchema,
      undefined,
      signal,
    );
  },

  async listRecipes(signal?: AbortSignal): Promise<IntelligenceRecipe[]> {
    const response = await requestJson("/v1/recipes", recipesResponseSchema, undefined, signal);
    return response.items.map(normalizeRecipe);
  },

  async getActiveRecipe(signal?: AbortSignal): Promise<IntelligenceRecipe | null> {
    try {
      const recipe = await requestJson("/v1/recipes/active", recipeVersionSchema, undefined, signal);
      return normalizeRecipe(recipe);
    } catch (error) {
      if (error instanceof DenicheurApiError && error.status === 404) return null;
      throw error;
    }
  },

  async saveRecipe(recipe: RecipeDraft, signal?: AbortSignal): Promise<IntelligenceRecipe> {
    const body = recipeDraftSchema.parse({
      name: recipe.name,
      threshold: recipe.threshold,
      criteria: recipe.criteria,
    });
    const saved = await requestJson(`/v1/recipes/${encodeURIComponent(recipe.id)}`, recipeVersionSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    }, signal);
    return normalizeRecipe(saved);
  },

  async activateRecipe(recipeId: string, version: number, signal?: AbortSignal): Promise<IntelligenceRecipe> {
    const activated = await requestJson(`/v1/recipes/${encodeURIComponent(recipeId)}/activate`, recipeVersionSchema, {
      method: "POST",
      body: JSON.stringify({ version }),
    }, signal);
    return normalizeRecipe(activated);
  },

  async listEvaluationPlans(signal?: AbortSignal): Promise<EvaluationPlan[]> {
    const response = await requestJson("/v1/evaluation-plans", evaluationPlansResponseSchema, undefined, signal);
    return response.items.map(normalizePlan);
  },

  async getDefaultEvaluationPlan(signal?: AbortSignal): Promise<EvaluationPlan | null> {
    try {
      const plan = await requestJson(
        "/v1/evaluation-plans/default",
        resolvedEvaluationPlanVersionSchema,
        undefined,
        signal,
      );
      return normalizePlan(plan);
    } catch (error) {
      if (error instanceof DenicheurApiError && error.status === 404) return null;
      throw error;
    }
  },

  async saveEvaluationPlan(plan: EvaluationPlanDraft, signal?: AbortSignal): Promise<EvaluationPlan> {
    const body = evaluationPlanDraftSchema.parse({
      name: plan.name,
      operator: plan.operator,
      recipes: plan.recipes,
    });
    const saved = await requestJson(`/v1/evaluation-plans/${encodeURIComponent(plan.id)}`, evaluationPlanVersionSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    }, signal);
    return normalizePlan(saved);
  },

  async setDefaultEvaluationPlan(planId: string, version: number, signal?: AbortSignal): Promise<EvaluationPlan> {
    const saved = await requestJson(
      `/v1/evaluation-plans/${encodeURIComponent(planId)}/set-default`,
      evaluationPlanVersionSchema,
      { method: "POST", body: JSON.stringify({ version }) },
      signal,
    );
    return normalizePlan(saved);
  },

  async listEvaluationExecutions(
    filters: { runId?: string; status?: EvaluationExecution["status"] } = {},
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<EvaluationExecutionsPage> {
    const params = new URLSearchParams({ limit: "100", order: "desc" });
    if (cursor) params.set("cursor", cursor);
    if (filters.runId) params.set("runId", filters.runId);
    if (filters.status) params.set("status", filters.status);
    return requestJson(`/v1/evaluation-executions?${params}`, evaluationExecutionsPageSchema, undefined, signal);
  },

  async getEvaluationExecution(executionId: string, signal?: AbortSignal): Promise<EvaluationExecutionRecord> {
    return requestJson(
      `/v1/evaluation-executions/${encodeURIComponent(executionId)}`,
      evaluationExecutionRecordSchema,
      undefined,
      signal,
    );
  },

  async getEvaluationExecutionResults(executionId: string, signal?: AbortSignal): Promise<EvaluationExecutionResults> {
    return requestJson(
      `/v1/evaluation-executions/${encodeURIComponent(executionId)}/results`,
      evaluationExecutionResultsSchema,
      undefined,
      signal,
    );
  },

  async startEvaluationExecution(input: StartEvaluationExecutionInput, signal?: AbortSignal): Promise<EvaluationExecutionRecord> {
    const { idempotencyKey, runId, ...request } = input;
    const body = evaluationExecutionCreateRequestSchema.parse(request);
    return requestJson(`/v1/runs/${encodeURIComponent(runId)}/evaluation-executions`, evaluationExecutionRecordSchema, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    }, signal);
  },

  async retryEvaluationExecution(executionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<EvaluationExecutionRecord> {
    return requestJson(`/v1/evaluation-executions/${encodeURIComponent(executionId)}/retry`, evaluationExecutionRecordSchema, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({}),
    }, signal);
  },

  async cancelEvaluationExecution(executionId: string, signal?: AbortSignal): Promise<EvaluationExecutionRecord> {
    return requestJson(`/v1/evaluation-executions/${encodeURIComponent(executionId)}/cancel`, evaluationExecutionRecordSchema, {
      method: "POST",
      body: JSON.stringify({}),
    }, signal);
  },
};

function listingSearchParams(filters: ListingFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  filters.sources?.forEach((source) => params.append("sources", source));
  if (filters.runId) params.set("runId", filters.runId);
  if (filters.status) params.set("status", filters.status);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.propertyType) params.set("propertyType", filters.propertyType);
  if (filters.priceMin !== undefined) params.set("priceMin", String(filters.priceMin));
  if (filters.priceMax !== undefined) params.set("priceMax", String(filters.priceMax));
  if (filters.surfaceMin !== undefined) params.set("surfaceMin", String(filters.surfaceMin));
  if (filters.energyClassMax) params.set("energyClass", filters.energyClassMax);
  if (filters.cursor) params.set("cursor", filters.cursor);
  params.set("limit", String(filters.limit ?? 100));
  params.set("sort", filters.sort ?? "updatedAt");
  params.set("order", filters.order ?? "desc");
  return params.toString();
}

function normalizeMapListing(record: ListingMapSummary): PropertyMapListing {
  return {
    key: record.id, source: record.source, externalId: record.externalId, url: record.url,
    title: record.title, priceEuros: record.priceEuros, propertyType: record.propertyType,
    surfaceM2: record.surfaceM2, rooms: record.rooms, location: record.location,
    coordinates: record.coordinates, status: record.status, scrapedAt: record.scrapedAt, updatedAt: record.updatedAt,
    imageUrls: record.imageUrl ? [record.imageUrl] : [],
    imageAssets: record.coverAsset ? [normalizeImageAsset(record.coverAsset)] : [],
    latestRun: { id: record.lastRunId, observedAt: record.lastSeenAt, status: record.status },
    evaluation: record.evaluation, features: [], runs: [], evaluations: [],
  };
}

function normalizeListing(record: ListingRecord, detail?: ListingDetail): PropertyListing {
  const images = [...(record.imageUrls ?? []), ...(record.imageUrl ? [record.imageUrl] : [])];
  const imageAssets = (record.imageAssets ?? []).map(normalizeImageAsset);
  return {
    source: record.source,
    externalId: record.externalId,
    key: record.id,
    url: record.url,
    title: record.title,
    priceText: record.priceText,
    priceEuros: record.priceEuros,
    pricePerSquareMeterText: record.pricePerSquareMeterText,
    propertyType: record.propertyType,
    rooms: record.rooms,
    bedrooms: record.bedrooms,
    surfaceM2: record.surfaceM2,
    landSurfaceM2: record.landSurfaceM2,
    location: record.location,
    sellerName: record.sellerName,
    sellerType: record.sellerType,
    postedAt: record.postedAt,
    description: record.description,
    energyClass: record.energyClass,
    gesClass: record.gesClass,
    imageUrls: Array.from(new Set(images)),
    imageAssets,
    features: record.features ?? [],
    status: record.status,
    scrapedAt: record.scrapedAt,
    updatedAt: record.updatedAt,
    coordinates: record.coordinates ? { ...record.coordinates } : undefined,
    latestRun: { id: record.lastRunId, observedAt: record.lastSeenAt, status: record.status },
    runs: detail?.runs.map((run) => ({ id: run.runId, observedAt: run.observedAt, status: run.status })) ?? [],
    evaluation: record.latestEvaluation ? normalizeEvaluation(record.latestEvaluation) : undefined,
    evaluations: detail?.evaluations.map(normalizeEvaluation) ?? [],
  };
}

function normalizeImageAsset(asset: ListingImageAsset): PropertyImageAsset {
  return {
    id: asset.id,
    sourceUrl: asset.sourceUrl,
    status: asset.status,
    ...(asset.thumbnailPath ? { thumbnailUrl: resolveApiPath(asset.thumbnailPath) } : {}),
    ...(asset.galleryPath ? { galleryUrl: resolveApiPath(asset.galleryPath) } : {}),
  };
}

export function resolveApiPath(path: string, apiBaseUrl = API_BASE_URL): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeEvaluation(evaluation: ListingEvaluationRecord) {
  return {
    listingId: evaluation.listingId,
    runId: evaluation.runId,
    decision: evaluation.decision,
    score: evaluation.score,
    summary: evaluation.summary,
    criteria: evaluation.criteria,
    missingData: evaluation.missingData,
    evaluatedAt: evaluation.evaluatedAt,
    recipeId: evaluation.recipeId,
    recipeVersion: evaluation.recipeVersion,
    locale: evaluation.locale,
    evaluator: evaluation.evaluator,
  };
}

function normalizeRecipe(recipe: RecipeVersion): IntelligenceRecipe {
  return { ...recipe, criteria: recipe.criteria.map((criterion) => ({ ...criterion })) };
}

function normalizePlan(plan: EvaluationPlanVersion): EvaluationPlan {
  return {
    id: plan.id,
    version: plan.version,
    name: plan.name,
    operator: plan.operator,
    recipes: plan.recipes.map((recipe) => ({ recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion })),
    combinerVersion: plan.combinerVersion,
    isDefault: plan.isDefault,
    createdAt: plan.createdAt,
  };
}

function readApiError(payload: unknown): { message?: string; code?: string } {
  if (!payload || typeof payload !== "object") return {};
  const candidate = payload as Record<string, unknown>;
  const nested = candidate.error && typeof candidate.error === "object" ? candidate.error as Record<string, unknown> : candidate;
  return {
    message: typeof nested.message === "string" ? nested.message : undefined,
    code: typeof nested.code === "string" ? nested.code : undefined,
  };
}
