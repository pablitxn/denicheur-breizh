import { createHash } from "node:crypto";

import type { APIRequestContext, TestInfo } from "@playwright/test";
import type {
  IngestionRequest,
  IngestionResponse,
  ListingIngestion,
  RecipeDraft,
  RecipeVersion,
} from "../../../packages/contracts/src/index.js";

export const E2E_API_URL = "http://127.0.0.1:14310";
export const FIXTURE_TIME = "2026-07-18T12:00:00.000Z";

export function testToken(testInfo: TestInfo, label: string): string {
  return createHash("sha256")
    .update([testInfo.project.name, ...testInfo.titlePath, String(testInfo.retry), label].join(":"))
    .digest("hex")
    .slice(0, 12);
}

export function listingFixture(
  token: string,
  suffix: string,
  overrides: Partial<ListingIngestion> = {},
): ListingIngestion {
  const externalId = `e2e-${token}-${suffix}`;
  return {
    source: "leboncoin",
    externalId,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
    status: "detailed",
    scrapedAt: FIXTURE_TIME,
    ...overrides,
  };
}

export async function ingestListings(
  request: APIRequestContext,
  runId: string,
  listings: ListingIngestion[],
): Promise<IngestionResponse> {
  const payload: IngestionRequest = {
    run: {
      id: runId,
      source: "leboncoin",
      status: "completed",
      startedAt: FIXTURE_TIME,
      finishedAt: FIXTURE_TIME,
      found: listings.length,
      collected: listings.length,
    },
    listings,
  };
  const response = await request.put(`${E2E_API_URL}/v1/ingestion/runs/${encodeURIComponent(runId)}`, {
    data: payload,
  });
  await assertApiResponse(response, `ingest run ${runId}`);
  return response.json() as Promise<IngestionResponse>;
}

export async function saveRecipeVersion(
  request: APIRequestContext,
  recipeId: string,
  draft: RecipeDraft,
): Promise<RecipeVersion> {
  const response = await request.put(`${E2E_API_URL}/v1/recipes/${encodeURIComponent(recipeId)}`, {
    data: draft,
  });
  await assertApiResponse(response, `save recipe ${recipeId}`);
  return response.json() as Promise<RecipeVersion>;
}

export async function activateRecipeVersion(
  request: APIRequestContext,
  recipeId: string,
  version: number,
): Promise<RecipeVersion> {
  const response = await request.post(`${E2E_API_URL}/v1/recipes/${encodeURIComponent(recipeId)}/activate`, {
    data: { version },
  });
  await assertApiResponse(response, `activate recipe ${recipeId} v${version}`);
  return response.json() as Promise<RecipeVersion>;
}

export async function getActiveRecipe(request: APIRequestContext): Promise<RecipeVersion> {
  const response = await request.get(`${E2E_API_URL}/v1/recipes/active`);
  await assertApiResponse(response, "read active recipe");
  return response.json() as Promise<RecipeVersion>;
}

async function assertApiResponse(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  action: string,
): Promise<void> {
  if (response.ok()) return;
  throw new Error(`Unable to ${action}: HTTP ${response.status()} ${await response.text()}`);
}
