import {
  healthResponseSchema,
  listingDetailSchema,
  listingsPageSchema,
  recipeDraftSchema,
  recipeVersionSchema,
  recipesResponseSchema,
  runDetailSchema,
  runsPageSchema,
  type HealthResponse,
  type ListingDetail,
  type ListingEvaluationRecord,
  type ListingRecord,
  type ListingsPage,
  type RecipeVersion,
  type RunDetail,
  type RunsPage,
} from "@denicheur-breizh/contracts";
import type {
  HealthStatus,
  IntelligenceRecipe,
  ListingFilters,
  PaginatedListings,
  PropertyListing,
  RecipeDraft,
} from "../types";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL?.trim() || "http://127.0.0.1:4310").replace(/\/$/, "");

export class DenicheurApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "DenicheurApiError";
  }
}

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function requestJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DenicheurApiError(error instanceof Error ? error.message : "API unavailable");
  }

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const apiError = readApiError(payload);
    throw new DenicheurApiError(apiError.message ?? `API request failed: ${response.status}`, response.status, apiError.code);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DenicheurApiError("The API returned a response that does not match the shared contract.", response.status, "INVALID_API_RESPONSE");
  }
  return parsed.data;
}

export const denicheurApi = {
  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const health: HealthResponse = await requestJson("/health", healthResponseSchema, undefined, signal);
    return {
      status: health.status === "ok" && health.database.status === "ok" ? "ok" : "degraded",
      database: health.database.status === "ok" ? "ok" : "unavailable",
      openAiConfigured: health.openAiConfigured,
    };
  },

  async listProperties(filters: ListingFilters = {}, signal?: AbortSignal): Promise<PaginatedListings> {
    const params = listingSearchParams(filters);
    const page: ListingsPage = await requestJson(`/v1/listings?${params}`, listingsPageSchema, undefined, signal);
    return { items: page.items.map((item) => normalizeListing(item)), nextCursor: page.nextCursor, total: page.total };
  },

  async listAllProperties(filters: ListingFilters = {}, signal?: AbortSignal): Promise<PaginatedListings> {
    const items = new Map<string, PropertyListing>();
    let cursor = filters.cursor;
    let total = 0;
    const seenCursors = new Set<string>();
    do {
      const page = await this.listProperties({ ...filters, cursor, limit: 100 }, signal);
      page.items.forEach((item) => items.set(item.key, item));
      total = page.total;
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new DenicheurApiError("The API repeated a pagination cursor.", undefined, "INVALID_API_RESPONSE");
        seenCursors.add(cursor);
      }
    } while (cursor);
    return { items: Array.from(items.values()), nextCursor: null, total };
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

  async listRuns(signal?: AbortSignal): Promise<RunsPage> {
    return requestJson("/v1/runs?limit=100", runsPageSchema, undefined, signal);
  },

  async getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    return requestJson(`/v1/runs/${encodeURIComponent(runId)}`, runDetailSchema, undefined, signal);
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
};

function listingSearchParams(filters: ListingFilters): string {
  const params = new URLSearchParams();
  if (filters.sources?.length === 1) params.set("source", filters.sources[0]!);
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
  params.set("sort", "updatedAt");
  params.set("order", "desc");
  return params.toString();
}

function normalizeListing(record: ListingRecord, detail?: ListingDetail): PropertyListing {
  const images = [...(record.imageUrls ?? []), ...(record.imageUrl ? [record.imageUrl] : [])];
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
    features: record.features ?? [],
    status: record.status,
    scrapedAt: record.scrapedAt,
    coordinates: record.coordinates ? { ...record.coordinates } : undefined,
    latestRun: { id: record.lastRunId, observedAt: record.lastSeenAt, status: record.status },
    runs: detail?.runs.map((run) => ({ id: run.runId, observedAt: run.observedAt, status: run.status })) ?? [],
    evaluation: record.latestEvaluation ? normalizeEvaluation(record.latestEvaluation) : undefined,
    evaluations: detail?.evaluations.map(normalizeEvaluation) ?? [],
  };
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

function readApiError(payload: unknown): { message?: string; code?: string } {
  if (!payload || typeof payload !== "object") return {};
  const candidate = payload as Record<string, unknown>;
  const nested = candidate.error && typeof candidate.error === "object" ? candidate.error as Record<string, unknown> : candidate;
  return {
    message: typeof nested.message === "string" ? nested.message : undefined,
    code: typeof nested.code === "string" ? nested.code : undefined,
  };
}
