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
  mergeRecordEvaluationOutcome,
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
  const evaluation = {
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
  };
  return {
    requestId: "request-1",
    runId: "run-1",
    locale,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    status: "completed",
    items: [
      {
        listingId,
        status: "succeeded",
        attemptId: "attempt-1",
        evaluation,
        evaluator: { provider: "openai", model: "gpt-5-mini-2025-08-07", version: "filter-v1" },
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

    const outcome = await evaluateDetailedRecords("run-1", recipe, [{
      ...detailedRecord(),
      listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1?utm_source=test#photo",
      location: "x".repeat(400),
    }], {
      baseUrl: "http://127.0.0.1:4310/",
      fetcher,
      locale: "es",
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(outcome.failures).toEqual([]);
    expect(outcome.evaluations[0]).toMatchObject({
      listingId: "listing-1",
      decision: "relevant",
      evaluator: { provider: "openai" },
      recipeId: recipe.id,
      locale: "es",
    });
  });

  it("loads the runtime API URL and bearer token for costing evaluations", async () => {
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
        "https://denicheur-breizh.orchid-labs.xyz/api/v1/runs/run-1/evaluations",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer operator-secret");
      return new Response(JSON.stringify(validPayload()), { status: 200 });
    });

    try {
      const outcome = await evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher });
      expect(outcome.failures).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("returns successful and failed items independently for a partial response", async () => {
    const first = detailedRecord();
    const second = detailedRecord("listing-2");
    const payload = {
      ...validPayload(),
      status: "partial",
      items: [
        validPayload("leboncoin:listing-1").items[0],
        {
          listingId: "leboncoin:listing-2",
          status: "failed",
          error: {
            code: "UNKNOWN_EVIDENCE_ID",
            stage: "semantic",
            retryable: true,
            requestId: "request-partial",
          },
        },
      ],
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    const outcome = await evaluateDetailedRecords("run-1", recipe, [first, second], { fetcher });

    expect(outcome.evaluations).toHaveLength(1);
    expect(outcome.failures).toEqual([{
      listingId: "listing-2",
      code: "UNKNOWN_EVIDENCE_ID",
      stage: "semantic",
      retryable: true,
      requestId: "request-partial",
    }]);
  });

  it("sends force only for an explicit full reevaluation", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ force: true });
      return new Response(JSON.stringify(validPayload()), { status: 200 });
    });

    await evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher, force: true });

    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("turns incomplete or mismatched API output into retryable listing failures", async () => {
    const payload = validPayload("leboncoin:unexpected-id");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

    const outcome = await evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher });

    expect(outcome).toEqual({
      evaluations: [],
      failures: [{
        code: "INVALID_API_RESPONSE",
        listingId: "listing-1",
        requestId: "request-1",
        retryable: true,
        stage: "response",
      }],
    });
  });

  it("rejects a response whose locale does not match the requested narrative language", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(validPayload()), { status: 200 }));

    const outcome = await evaluateDetailedRecords(
      "run-1",
      recipe,
      [detailedRecord()],
      { fetcher, locale: "en" },
    );

    expect(outcome.failures[0]).toMatchObject({
      code: "INVALID_API_RESPONSE",
      listingId: "listing-1",
    });
  });

  it("normalizes transport failures without losing the original records", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const outcome = await evaluateDetailedRecords("run-1", recipe, [detailedRecord()], { fetcher });

    expect(outcome).toEqual({
      evaluations: [],
      failures: [{
        listingId: "listing-1",
        code: "NETWORK_UNAVAILABLE",
        stage: "provider",
        retryable: true,
      }],
    });
  });

  it("turns an unclassified server error into retryable failures for every requested record", async () => {
    const records = [detailedRecord(), detailedRecord("listing-2")];
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));

    const outcome = await evaluateDetailedRecords("run-1", recipe, records, { fetcher });

    expect(outcome.evaluations).toEqual([]);
    expect(outcome.failures).toEqual([
      expect.objectContaining({
        listingId: "listing-1",
        code: "OPENAI_UNAVAILABLE",
        retryable: true,
      }),
      expect.objectContaining({
        listingId: "listing-2",
        code: "OPENAI_UNAVAILABLE",
        retryable: true,
      }),
    ]);
  });

  it.each([
    ["OPENAI_TIMEOUT", "error.apiTimeout"],
    ["OPENAI_INSUFFICIENT_QUOTA", "error.apiInsufficientQuota"],
    ["MODEL_REFUSAL", "error.apiRefusal"],
    ["MAX_OUTPUT_TOKENS", "error.apiIncomplete"],
    ["CONTENT_FILTER", "error.apiContentFilter"],
    ["SCHEMA_MISMATCH", "error.apiInvalidOutput"],
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
    const outcome = await evaluateDetailedRecords("run-1", recipe, [first], { fetcher });

    const merged = mergeRecordEvaluations([first, second], outcome.evaluations);

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
        items: body.listingIds.map((id) => ({ ...validPayload(id).items[0], listingId: id })),
      }), { status: 200 });
    });

    const outcome = await evaluateDetailedRecordsInBatches("reevaluation-1", recipe, records, { fetcher });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(outcome.evaluations).toHaveLength(21);
    expect(outcome.failures).toEqual([]);
    expect(outcome.evaluations.at(-1)?.listingId).toBe("listing-21");
  });

  it("reports each completed batch before a later batch fails", async () => {
    const records = Array.from({ length: 21 }, (_, index) => detailedRecord(`listing-${index + 1}`));
    const completed: Array<{ evaluations: ListingEvaluation[]; failures: unknown[] }> = [];
    let attempt = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      if (attempt === 2) throw new TypeError("API offline");
      const body = JSON.parse(String(init?.body)) as { listingIds: string[] };
      return new Response(JSON.stringify({
        ...validPayload(),
        items: body.listingIds.map((id) => ({ ...validPayload(id).items[0], listingId: id })),
      }), { status: 200 });
    });

    const outcome = await evaluateDetailedRecordsInBatches("run-1", recipe, records, {
      fetcher,
      onBatchComplete(batch) {
        completed.push(batch);
      },
    });

    expect(completed).toHaveLength(2);
    expect(completed[0].evaluations).toHaveLength(20);
    expect(completed[1].failures).toHaveLength(1);
    expect(outcome.evaluations).toHaveLength(20);
    expect(outcome.failures).toEqual([expect.objectContaining({
      code: "NETWORK_UNAVAILABLE",
      listingId: "listing-21",
    })]);
  });

  it("keeps a previous valid evaluation while attaching a partial failure", () => {
    const previous: ListingEvaluation = {
      ...validPayload().items[0].evaluation,
      listingId: "listing-1",
      decision: "relevant",
      criteria: [{
        criterionId: "garden",
        verdict: "pass",
        reason: "The description explicitly mentions a private garden.",
        evidence: ["jardin privatif"],
      }],
      evaluator: { provider: "openai", model: "gpt-5-mini-2025-08-07", version: "filter-v1" },
      recipeId: recipe.id,
      recipeVersion: recipe.version,
    };
    const record = { ...detailedRecord(), evaluation: previous };
    const merged = mergeRecordEvaluationOutcome([record], {
      evaluations: [],
      failures: [{
        listingId: "listing-1",
        code: "UNKNOWN_EVIDENCE_ID",
        stage: "semantic",
        retryable: true,
        requestId: "request-partial",
      }],
    });

    expect(merged[0].evaluation).toBe(previous);
    expect(merged[0].evaluationFailure).toMatchObject({
      code: "UNKNOWN_EVIDENCE_ID",
      requestId: "request-partial",
    });
  });
});
