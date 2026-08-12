import { describe, expect, it, vi } from "vitest";
import {
  fetchActiveRecipe,
  fetchDefaultEvaluationPlan,
  fetchEvaluationExecution,
  fetchEvaluationExecutionResults,
  ingestRunBatch,
} from "./api";
import type { IngestionRequestPayload } from "./types";

const CREATED_AT = "2026-07-19T10:00:00.000Z";
const PRODUCTION_API_BASE_URL = "https://denicheur-breizh.orchid-labs.xyz/api";
const OPERATOR_TOKEN = "operator-secret";

describe("durable evaluation API validation", () => {
  it("loads the runtime API URL and bearer token for ingestion mutations", async () => {
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get(keys: string[], callback: (values: Record<string, unknown>) => void) {
            callback(Object.fromEntries(keys.map((key) => [key, {
              "denicheur:runtime-api-base-url": "https://denicheur-breizh.orchid-labs.xyz/api",
              "denicheur:runtime-api-credential": {
                endpoint: "https://denicheur-breizh.orchid-labs.xyz/api",
                token: "operator-secret",
              },
            }[key]])));
          },
        },
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://denicheur-breizh.orchid-labs.xyz/api/v1/ingestion/runs/run-1",
      );
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer operator-secret");
      return new Response(JSON.stringify({
        runId: "run-1",
        accepted: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      }), { status: 200 });
    });

    try {
      await ingestRunBatch("run-1", {} as IngestionRequestPayload, { fetcher });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not forward a stored credential to a different explicit endpoint", async () => {
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get(keys: string[], callback: (values: Record<string, unknown>) => void) {
            callback(Object.fromEntries(keys.map((key) => [key, {
              "denicheur:runtime-api-base-url": "https://denicheur-breizh.orchid-labs.xyz/api",
              "denicheur:runtime-api-credential": {
                endpoint: "https://denicheur-breizh.orchid-labs.xyz/api",
                token: "operator-secret",
              },
            }[key]])));
          },
        },
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/ingestion/runs/run-1");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(JSON.stringify({
        runId: "run-1",
        accepted: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
      }), { status: 200 });
    });

    try {
      await ingestRunBatch("run-1", {} as IngestionRequestPayload, {
        baseUrl: "http://127.0.0.1:4310/",
        fetcher,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches the endpoint-bound bearer token to every private GET", async () => {
    stubRuntimeCredential();
    const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (url.endsWith("/v1/recipes/active")) {
        return jsonResponse(activeRecipe());
      }
      if (url.endsWith("/v1/evaluation-plans/default")) {
        return jsonResponse(defaultPlan());
      }
      if (url.endsWith("/results")) {
        return jsonResponse({ executionId: "execution-1", items: [] });
      }
      if (url.endsWith("/v1/evaluation-executions/execution-1")) {
        return jsonResponse(executionRecord());
      }
      throw new Error(`Unexpected private API request: ${url}`);
    });

    try {
      await fetchActiveRecipe({ fetcher });
      await fetchDefaultEvaluationPlan({ fetcher });
      await fetchEvaluationExecution("execution-1", { fetcher });
      await fetchEvaluationExecutionResults("execution-1", { fetcher });

      expect(requests).toEqual([
        privateGet("/v1/recipes/active"),
        privateGet("/v1/evaluation-plans/default"),
        privateGet("/v1/evaluation-executions/execution-1"),
        privateGet("/v1/evaluation-executions/execution-1"),
        privateGet("/v1/evaluation-executions/execution-1/results"),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a succeeded result step without evaluator provenance", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/results")) {
        return new Response(JSON.stringify({
          executionId: "execution-1",
          items: [{
            executionId: "execution-1",
            listingId: "leboncoin:3007106066",
            planId: "default-plan",
            planVersion: 1,
            decision: "relevant",
            score: 90,
            summary: "Relevant.",
            evaluatedAt: CREATED_AT,
            steps: [{
              recipeId: "coastal",
              recipeVersion: 2,
              status: "succeeded",
              evaluation: {
                listingId: "leboncoin:3007106066",
                decision: "relevant",
                score: 90,
                summary: "Relevant.",
                criteria: [{
                  criterionId: "sea-view",
                  verdict: "pass",
                  reason: "Explicit sea view.",
                  evidence: ["vue mer"],
                }],
                missingData: [],
                evaluatedAt: CREATED_AT,
              },
            }],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "execution-1",
        runId: "run-1",
        planId: "default-plan",
        planVersion: 1,
        locale: "fr",
        status: "completed",
        listingIds: ["leboncoin:3007106066"],
        force: false,
        createdAt: CREATED_AT,
        completedAt: CREATED_AT,
        counters: {
          total: 1,
          processed: 1,
          relevant: 1,
          notRelevant: 0,
          review: 0,
          failed: 0,
        },
        budget: executionBudget(),
      }), { status: 200 });
    });

    await expect(fetchEvaluationExecutionResults("execution-1", { fetcher }))
      .rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
});

function stubRuntimeCredential(): void {
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get(keys: string[], callback: (values: Record<string, unknown>) => void) {
          callback(Object.fromEntries(keys.map((key) => [key, {
            "denicheur:runtime-api-base-url": PRODUCTION_API_BASE_URL,
            "denicheur:runtime-api-credential": {
              endpoint: PRODUCTION_API_BASE_URL,
              token: OPERATOR_TOKEN,
            },
          }[key]])));
        },
      },
    },
  });
}

function privateGet(path: string) {
  return {
    url: `${PRODUCTION_API_BASE_URL}${path}`,
    method: "GET",
    authorization: `Bearer ${OPERATOR_TOKEN}`,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function activeRecipe() {
  return {
    id: "active-recipe",
    version: 1,
    name: "Active recipe",
    threshold: 70,
    criteria: [{
      id: "garden",
      name: "Garden",
      description: "The listing explicitly describes a garden.",
      weight: 100,
      required: true,
      evidenceRequired: true,
    }],
    active: true,
    createdAt: CREATED_AT,
  };
}

function defaultPlan() {
  const recipe = activeRecipe();
  return {
    id: "default-plan",
    version: 1,
    name: "Default plan",
    operator: "all",
    combinerVersion: "tri-state-v1",
    recipes: [{ recipeId: recipe.id, recipeVersion: recipe.version, recipe }],
    isDefault: true,
    createdAt: CREATED_AT,
  };
}

function executionRecord() {
  return {
    id: "execution-1",
    runId: "run-1",
    planId: "default-plan",
    planVersion: 1,
    locale: "fr",
    status: "completed",
    listingIds: [],
    force: false,
    createdAt: CREATED_AT,
    completedAt: CREATED_AT,
    counters: {
      total: 0,
      processed: 0,
      relevant: 0,
      notRelevant: 0,
      review: 0,
      failed: 0,
    },
    budget: executionBudget(),
  };
}

function executionBudget() {
  return {
    limit: { providerCalls: 10, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: 1_000_000 },
    estimate: { providerCalls: 1, inputTokens: 2_000, outputTokens: 1_000, costMicroUsd: 10_000 },
    consumed: { providerCalls: 1, inputTokens: 1_000, outputTokens: 500, costMicroUsd: 5_000 },
  };
}
