import { describe, expect, it, vi } from "vitest";
import type { IntelligenceRecipe, ScrapedPropertyRecord } from "../lib/types";
import {
  evaluateDetailedRecords,
  evaluateDetailedRecordsInBatches,
  FilterApiError,
  mergeRecordEvaluations,
} from "./filterApi";

const recipe: IntelligenceRecipe = {
  id: "personal-fit",
  version: 2,
  name: "Personal fit",
  threshold: 70,
  enabled: true,
  criteria: [
    {
      id: "garden",
      name: "Private garden",
      description: "The listing clearly describes a private garden.",
      weight: 30,
      required: true,
    },
  ],
};

function detailedRecord(id = "listing-1"): ScrapedPropertyRecord {
  return {
    id,
    source: "leboncoin",
    listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`,
    title: "Maison avec jardin",
    priceEuros: 320000,
    rooms: 5,
    bedrooms: 3,
    surfaceM2: 110,
    description: "Maison familiale avec jardin privatif.",
    features: ["Jardin"],
    scrapedAt: "2026-07-12T10:00:00.000Z",
    searchRunId: "run-1",
    status: "detailed",
    rawTextSample: "Maison avec jardin",
  };
}

function validPayload(listingId = "listing-1") {
  return {
    runId: "run-1",
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    evaluator: { provider: "openai", model: "gpt-5-mini-2025-08-07", version: "filter-v1" },
    results: [
      {
        listingId,
        decision: "relevant",
        score: 100,
        summary: "The garden requirement is supported.",
        criteria: [
          {
            criterionId: "garden",
            verdict: "pass",
            reason: "The description explicitly mentions a private garden.",
            evidence: ["jardin privatif"],
          },
        ],
        missingData: [],
        evaluatedAt: "2026-07-12T10:01:00.000Z",
      },
    ],
  };
}

describe("intelligence filter API client", () => {
  it("serializes detailed records and returns validated evaluations", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ runId: "run-1", recipe: { id: recipe.id, version: 2 } });
      expect(body.listings).toEqual([
        expect.objectContaining({
          id: "listing-1",
          url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
          title: "Maison avec jardin",
          location: "x".repeat(300),
          features: ["Jardin"],
        }),
      ]);
      return new Response(JSON.stringify(validPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const evaluations = await evaluateDetailedRecords("run-1", recipe, [{
      ...detailedRecord(),
      listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1?utm_source=test#photo",
      location: "x".repeat(400),
    }], {
      baseUrl: "http://127.0.0.1:4310/",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(evaluations[0]).toMatchObject({
      listingId: "listing-1",
      decision: "relevant",
      evaluator: { provider: "openai" },
      recipeId: recipe.id,
    });
  });

  it("omits an absent title from the API payload instead of fabricating one", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        listings: Array<Record<string, unknown>>;
      };
      expect(body.listings[0]).not.toHaveProperty("title");
      return new Response(JSON.stringify(validPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await evaluateDetailedRecords("run-1", recipe, [{
      ...detailedRecord(),
      title: undefined,
    }], { fetcher });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects incomplete or mismatched API output", async () => {
    const payload = validPayload("unexpected-id");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await expect(
      evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher }),
    ).rejects.toThrow("unexpected or duplicate listing ids");
  });

  it("normalizes transport failures without losing the original records", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher }),
    ).rejects.toEqual(expect.objectContaining<Partial<FilterApiError>>({
      name: "FilterApiError",
      message: "Intelligence API is unavailable: Failed to fetch",
    }));
  });

  it("merges evaluations by listing id and leaves unrelated records untouched", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validPayload()), { status: 200 }));
    const first = detailedRecord();
    const second = detailedRecord("listing-2");
    const evaluations = await evaluateDetailedRecords("run-1", recipe, [first], { fetcher });

    const merged = mergeRecordEvaluations([first, second], evaluations);

    expect(merged[0].evaluation?.decision).toBe("relevant");
    expect(merged[1]).toBe(second);
  });

  it("reevaluates every stored record in API-sized batches", async () => {
    const records = Array.from({ length: 21 }, (_, index) => detailedRecord(`listing-${index + 1}`));
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        runId: string;
        listings: Array<{ id: string }>;
      };
      return new Response(JSON.stringify({
        ...validPayload(),
        runId: body.runId,
        results: body.listings.map(({ id }) => ({ ...validPayload(id).results[0], listingId: id })),
      }), { status: 200 });
    });

    const evaluations = await evaluateDetailedRecordsInBatches("reevaluation-1", recipe, records, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(evaluations).toHaveLength(21);
    expect(evaluations.at(-1)?.listingId).toBe("listing-21");
  });
});
