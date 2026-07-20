import { describe, expect, it, vi } from "vitest";
import { fetchEvaluationExecutionResults, ingestRunBatch } from "./api";
import type { IngestionRequestPayload } from "./types";

const CREATED_AT = "2026-07-19T10:00:00.000Z";

describe("durable evaluation API validation", () => {
  it("loads the runtime API URL and bearer token for ingestion mutations", async () => {
    vi.stubGlobal("chrome", {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get(keys: string[], callback: (values: Record<string, unknown>) => void) {
            callback(Object.fromEntries(keys.map((key) => [key, {
              "denicheur:runtime-api-base-url": "https://denicheur-breizh.orchid-labs.xyz/api",
              "denicheur:runtime-operator-token": "operator-secret",
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
      }), { status: 200 });
    });

    await expect(fetchEvaluationExecutionResults("execution-1", { fetcher }))
      .rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
});
