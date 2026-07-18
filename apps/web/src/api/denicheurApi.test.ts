import { afterEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL, DenicheurApiError, denicheurApi } from "./denicheurApi";

const now = "2026-07-18T10:00:00.000Z";

function listing(overrides: Record<string, unknown> = {}) {
  return {
    source: "leboncoin",
    externalId: "123456",
    id: "leboncoin:123456",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123456",
    status: "detailed",
    scrapedAt: now,
    lastRunId: "run-1",
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("denicheurApi", () => {
  it("uses the loopback API by default and validates a sparse listings page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [listing({ title: "Maison réelle", priceEuros: 215000 })],
      nextCursor: null,
      total: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    const result = await denicheurApi.listProperties({ limit: 100 });

    expect(API_BASE_URL).toBe("http://127.0.0.1:4310");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:4310\/v1\/listings\?/),
      expect.objectContaining({ signal: undefined }),
    );
    expect(result.items[0]).toMatchObject({
      key: "leboncoin:123456",
      title: "Maison réelle",
      priceEuros: 215000,
      imageUrls: [],
      features: [],
    });
    expect(result.items[0]?.coordinates).toBeUndefined();
    expect(result.items[0]?.surfaceM2).toBeUndefined();
  });

  it("rejects payloads that drift from the shared response contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ id: "invented" }] }), { status: 200 })));

    await expect(denicheurApi.listProperties()).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    } satisfies Partial<DenicheurApiError>);
  });

  it("follows opaque cursors so UI coverage is based on the full resource, not only the first page", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const secondPage = url.searchParams.get("cursor") === "next-page";
      return new Response(JSON.stringify({
        items: [listing({ externalId: secondPage ? "second" : "first", id: `leboncoin:${secondPage ? "second" : "first"}` })],
        nextCursor: secondPage ? null : "next-page",
        total: 2,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await denicheurApi.listAllProperties();

    expect(result.items.map((item) => item.key)).toEqual(["leboncoin:first", "leboncoin:second"]);
    expect(result.total).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes detail history, coordinate provenance and the latest evaluation", async () => {
    const payload = listing({
      coordinates: {
        latitude: 48.4,
        longitude: -4.2,
        verifiedAt: now,
        provenance: "listing structured data",
        locationKind: "source-locality",
      },
      latestEvaluation: {
        listingId: "leboncoin:123456",
        runId: "run-1",
        source: "leboncoin",
        externalId: "123456",
        decision: "review",
        score: null,
        summary: "Informations insuffisantes",
        criteria: [{ criterionId: "garden", verdict: "unknown", reason: "Absent", evidence: [] }],
        missingData: ["description"],
        evaluatedAt: now,
        recipeId: "family",
        recipeVersion: 2,
        locale: "fr",
        evaluator: { provider: "openai", model: "gpt-5-mini", version: "v1" },
      },
      runs: [{ runId: "run-1", observedAt: now, status: "detailed", scrapedAt: now }],
      evaluations: [],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));

    const result = await denicheurApi.getProperty("leboncoin", "123456");

    expect(result.coordinates).toEqual({
      latitude: 48.4,
      longitude: -4.2,
      verifiedAt: now,
      provenance: "listing structured data",
      locationKind: "source-locality",
    });
    expect(result.runs).toEqual([{ id: "run-1", observedAt: now, status: "detailed" }]);
    expect(result.evaluation).toMatchObject({ runId: "run-1", decision: "review", score: null, recipeVersion: 2 });
  });

  it("sends only the shared recipe draft body when saving a new version", async () => {
    const saved = {
      id: "family",
      version: 3,
      name: "Maison famille",
      threshold: 75,
      criteria: [{ id: "garden", name: "Jardin", description: "Présence explicite", weight: 2, required: true }],
      active: false,
      createdAt: now,
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await denicheurApi.saveRecipe({ id: "family", name: saved.name, threshold: saved.threshold, criteria: saved.criteria });

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: saved.name, threshold: saved.threshold, criteria: saved.criteria });
  });

  it("derives the connection badge state from health and database readiness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok",
      service: "denicheur-api",
      database: { status: "ok" },
      openAiConfigured: false,
    }), { status: 200 })));

    await expect(denicheurApi.health()).resolves.toEqual({
      status: "ok",
      database: "ok",
      openAiConfigured: false,
    });
  });

  it("activates the explicitly selected recipe version", async () => {
    const activated = {
      id: "family",
      version: 2,
      name: "Maison famille",
      threshold: 70,
      criteria: [{ id: "garden", name: "Jardin", description: "Présence explicite", weight: 2, required: true }],
      active: true,
      createdAt: now,
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(activated), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await denicheurApi.activateRecipe("family", 2);

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ version: 2 });
  });
});
