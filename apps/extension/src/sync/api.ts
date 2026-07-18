import {
  ingestionResponseSchema,
  recipeVersionSchema,
  type RecipeVersion,
} from "@denicheur-breizh/contracts";
import type { IntelligenceRecipe } from "../lib/types";
import type { IngestionRequestPayload } from "./types";

const DEFAULT_API_URL = "http://127.0.0.1:4310";

export type SyncFetcher = typeof fetch;

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

export function configuredApiUrl(): string {
  const configured = import.meta.env.WXT_FILTER_API_URL as string | undefined;
  return (configured?.trim() || DEFAULT_API_URL).replace(/\/$/, "");
}

export async function ingestRunBatch(
  runId: string,
  payload: IngestionRequestPayload,
  options: { fetcher?: SyncFetcher; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const response = await request(
    `${normalizedBaseUrl(options.baseUrl)}/v1/ingestion/runs/${encodeURIComponent(runId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
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
  const response = await request(
    `${normalizedBaseUrl(options.baseUrl)}/v1/recipes/active`,
    { method: "GET", signal: options.signal },
    options.fetcher,
  );
  const payload = await readSuccessJson(response);
  const parsed = recipeVersionSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.active) {
    throw new ExtensionApiError("The API returned an invalid active recipe.", response.status, "INVALID_API_RESPONSE");
  }
  return toLocalRecipe(parsed.data);
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

function normalizedBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || configuredApiUrl()).replace(/\/$/, "");
}

function toLocalRecipe(recipe: RecipeVersion): IntelligenceRecipe {
  return {
    id: recipe.id,
    version: recipe.version,
    name: recipe.name,
    threshold: recipe.threshold,
    enabled: recipe.active,
    criteria: recipe.criteria.map(({ id, name, description, weight, required }) => ({
      id,
      name,
      description,
      weight,
      required,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
