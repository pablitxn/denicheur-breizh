import { describe, expect, it, vi } from "vitest";
import type {
  IntelligenceRecipe,
  ListingEvaluation,
  ScrapedPropertyRecord,
} from "../lib/types";
import {
  evaluateDetailedRecords,
  evaluateDetailedRecordsInBatches,
  filterApiErrorDescriptor,
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

function validPayload(listingId = "leboncoin:listing-1", locale: "fr" | "es" | "en" = "fr") {
  return {
    runId: "run-1",
    locale,
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
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(String(input)).toBe("http://127.0.0.1:4310/v1/runs/run-1/evaluations");
      expect(body).toEqual({
        locale: "es",
        recipeId: recipe.id,
        recipeVersion: 2,
        listingIds: ["leboncoin:listing-1"],
      });
      return new Response(JSON.stringify(validPayload("leboncoin:listing-1", "es")), {
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
      locale: "es",
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(evaluations[0]).toMatchObject({
      listingId: "listing-1",
      decision: "relevant",
      evaluator: { provider: "openai" },
      recipeId: recipe.id,
      locale: "es",
    });
  });

  it("sends identities only because listings must already be persisted", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        locale: "fr",
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        listingIds: ["leboncoin:listing-1"],
      });
      expect(body).not.toHaveProperty("listings");
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
    const payload = validPayload("leboncoin:unexpected-id");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    await expect(
      evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher }),
    ).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: expect.stringContaining("unexpected or duplicate listing ids"),
    });
  });

  it("rejects a response whose locale does not match the requested narrative language", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validPayload()), { status: 200 }));

    await expect(
      evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher, locale: "en" }),
    ).rejects.toThrow("does not match the request");
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

  it.each([
    ["OPENAI_TIMEOUT", "error.apiTimeout"],
    ["ORIGIN_NOT_ALLOWED", "error.apiOriginNotAllowed"],
    ["NOT_FOUND", "error.apiNotFound"],
    ["INVALID_API_RESPONSE", "error.apiInvalidResponse"],
    ["CLIENT_VALIDATION", "error.apiInvalidRequest"],
  ])("maps the known API code %s without exposing its raw English message", (code, id) => {
    expect(filterApiErrorDescriptor(new FilterApiError("Raw English diagnostic", 503, code))).toEqual({ id });
  });

  it("keeps the raw diagnosis only for an unknown external error", () => {
    expect(filterApiErrorDescriptor(new FilterApiError(
      "Vendor-specific failure",
      502,
      "VENDOR_FAILURE",
    ))).toEqual({
      id: "error.intelligenceFailed",
      technicalDetail: "Vendor-specific failure",
    });
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
        listingIds: string[];
      };
      return new Response(JSON.stringify({
        ...validPayload(),
        runId: "reevaluation-1",
        results: body.listingIds.map((id) => ({ ...validPayload(id).results[0], listingId: id })),
      }), { status: 200 });
    });

    const evaluations = await evaluateDetailedRecordsInBatches("reevaluation-1", recipe, records, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(evaluations).toHaveLength(21);
    expect(evaluations.at(-1)?.listingId).toBe("listing-21");
  });

  it("reports each completed batch before a later batch fails", async () => {
    const records = Array.from({ length: 21 }, (_, index) => detailedRecord(`listing-${index + 1}`));
    const completed: ListingEvaluation[][] = [];
    let attempt = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 2) throw new TypeError("API offline");
      const body = JSON.parse(String(init?.body)) as { listingIds: string[] };
      return new Response(JSON.stringify({
        ...validPayload(),
        results: body.listingIds.map((id) => ({ ...validPayload(id).results[0], listingId: id })),
      }), { status: 200 });
    });

    await expect(evaluateDetailedRecordsInBatches("run-1", recipe, records, {
      fetcher,
      onBatchComplete(batch) {
        completed.push(batch);
      },
    })).rejects.toThrow("API offline");

    expect(completed).toHaveLength(1);
    expect(completed[0]).toHaveLength(20);
  });
});
