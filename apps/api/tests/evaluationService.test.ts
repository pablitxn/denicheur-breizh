import { describe, expect, it, vi } from "vitest";

import type {
  FilterListingsRequest,
  FilterListingsResponse,
  IngestionRequest,
  ListingIngestion,
} from "../src/contracts.js";
import { invalidModelOutput } from "../src/errors.js";
import { StoredEvaluationService } from "../src/evaluationService.js";
import { EVALUATOR_RESPONSE_ID } from "../src/filterService.js";
import { DenicheurRepository } from "../src/repository.js";

const NOW = new Date("2026-07-18T10:00:00.000Z");

describe("StoredEvaluationService", () => {
  it("leaves an already ingested listing untouched when the evaluator fails", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const before = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    const filter = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    const service = new StoredEvaluationService(repository, { filter });

    const response = await service.evaluate("run-1", evaluationRequest("leboncoin:2876543210"), {
      requestId: "request-1",
    });

    const after = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    expect(response).toMatchObject({
      status: "failed",
      items: [{
        listingId: "leboncoin:2876543210",
        status: "failed",
        error: { code: "EVALUATION_FAILED", stage: "internal", retryable: false },
      }],
    });
    expect(after).toEqual(before);
    expect(after?.evaluations).toEqual([]);
    expect(repository.countEvaluationAttempts()).toBe(1);
  });

  it("retains a committed batch when a later evaluation batch fails", async () => {
    const repository = createRepositoryWithListings([
      createListing("2876543210"),
      createListing("2876543211"),
    ]);
    const filter = vi.fn(async (request: FilterListingsRequest) => {
      if (request.listings[0]?.id === "leboncoin:2876543211") throw new Error("second batch failed");
      return createEvaluationResponse(request);
    });
    const service = new StoredEvaluationService(repository, { filter });

    await service.evaluate("run-1", evaluationRequest("leboncoin:2876543210"), { requestId: "request-1" });
    const failed = await service.evaluate("run-1", evaluationRequest("leboncoin:2876543211"), {
      requestId: "request-2",
    });

    const first = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    const second = repository.getListing({ source: "leboncoin", externalId: "2876543211" });
    expect(first?.evaluations).toHaveLength(1);
    expect(first?.latestEvaluation).toMatchObject({
      runId: "run-1",
      decision: "relevant",
      recipeId: "recipe-1",
    });
    expect(second?.evaluations).toEqual([]);
    expect(failed.status).toBe("failed");
  });

  it("returns the immutable stored evaluation without calling OpenAI again", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = new StoredEvaluationService(repository, { filter });
    const request = evaluationRequest("leboncoin:2876543210");

    const first = await service.evaluate("run-1", request, { requestId: "request-1" });
    const second = await service.evaluate("run-1", request, { requestId: "request-2" });

    expect(first).toMatchObject({ requestId: "request-1", items: [{ status: "succeeded" }] });
    expect(second).toMatchObject({ requestId: "request-2", items: [{ status: "cached" }] });
    const firstItem = first.items[0];
    const secondItem = second.items[0];
    if (!firstItem || firstItem.status === "failed" || !secondItem || secondItem.status === "failed") {
      throw new Error("Expected successful evaluation items.");
    }
    expect(secondItem.evaluation).toEqual(firstItem.evaluation);
    expect(filter).toHaveBeenCalledTimes(1);
  });

  it("persists two valid listings when one semantic result is invalid and retries only the failed listing", async () => {
    const listingIds = ["2876543210", "2876543211", "2876543212"];
    const repository = createRepositoryWithListings(listingIds.map(createListing));
    const filter = vi.fn(async (request: FilterListingsRequest) => {
      if (request.listings.length > 1 || request.listings[0]?.id === "leboncoin:2876543212") {
        throw invalidModelOutput({
          stage: "semantic",
          detailCode: "EVIDENCE_REQUIRED",
          listingId: request.listings[0]!.id,
          criterionId: "garden",
          retryable: true,
        });
      }
      return createEvaluationResponse(request);
    });
    const service = createService(repository, filter);
    const request = evaluationRequest(...listingIds.map((id) => `leboncoin:${id}`));

    const first = await service.evaluate("run-1", request, { requestId: "request-partial" });

    expect(first.status).toBe("partial");
    expect(first.items.map((item) => item.status)).toEqual(["succeeded", "succeeded", "failed"]);
    expect(first.items[2]).toMatchObject({
      error: {
        code: "EVIDENCE_REQUIRED",
        stage: "semantic",
        retryable: true,
        criterionId: "garden",
      },
    });
    expect(repository.getListing({ source: "leboncoin", externalId: listingIds[0]! })?.evaluations).toHaveLength(1);
    expect(repository.getListing({ source: "leboncoin", externalId: listingIds[1]! })?.evaluations).toHaveLength(1);
    expect(repository.getListing({ source: "leboncoin", externalId: listingIds[2]! })?.evaluations).toEqual([]);
    expect(filter).toHaveBeenCalledTimes(4);

    const callsBeforeRetry = filter.mock.calls.length;
    const second = await service.evaluate("run-1", request, { requestId: "request-retry" });
    const retryCalls = filter.mock.calls.slice(callsBeforeRetry).map(([input]) => input.listings.map((listing) => listing.id));

    expect(second.items.map((item) => item.status)).toEqual(["cached", "cached", "failed"]);
    expect(retryCalls).toEqual([
      ["leboncoin:2876543212"],
      ["leboncoin:2876543212"],
    ]);
  });

  it("invalidates cache when the run snapshot changes and force always creates a new successful attempt", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = createService(repository, filter);
    const request = evaluationRequest("leboncoin:2876543210");

    const first = await service.evaluate("run-1", request, { requestId: "request-first" });
    const cached = await service.evaluate("run-1", request, { requestId: "request-cached" });
    repository.ingest({
      run: { id: "run-1", source: "leboncoin", status: "completed" },
      listings: [{
        ...createListing("2876543210"),
        title: "Maison modifiée",
        scrapedAt: "2026-07-18T11:00:00.000Z",
      }],
    });
    const changed = await service.evaluate("run-1", request, { requestId: "request-changed" });
    const forced = await service.evaluate("run-1", { ...request, force: true }, { requestId: "request-forced" });

    expect([first.items[0]?.status, cached.items[0]?.status, changed.items[0]?.status, forced.items[0]?.status])
      .toEqual(["succeeded", "cached", "succeeded", "succeeded"]);
    expect(filter).toHaveBeenCalledTimes(3);
    expect(repository.countEvaluationAttempts()).toBe(3);
    expect(repository.getListing({ source: "leboncoin", externalId: "2876543210" })?.evaluations).toHaveLength(1);
  });

  it("evaluates the same listing again for a newer run and keeps both histories", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    repository.ingest({
      run: { id: "run-2", source: "leboncoin", status: "completed" },
      listings: [{
        ...createListing("2876543210"),
        title: "Maison enrichie au run 2",
        description: "Maison avec jardin et vue mer.",
        scrapedAt: "2026-07-18T11:00:00.000Z",
      }],
    });
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = new StoredEvaluationService(repository, { filter });
    const request = evaluationRequest("leboncoin:2876543210");

    await service.evaluate("run-1", request, { requestId: "request-1" });
    await service.evaluate("run-2", request, { requestId: "request-2" });

    const detail = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    expect(filter).toHaveBeenCalledTimes(2);
    expect(new Set(detail?.evaluations.map((evaluation) => evaluation.runId))).toEqual(
      new Set(["run-1", "run-2"]),
    );
  });

  it("sends the selected run snapshot to the evaluator instead of later canonical data", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    repository.ingest({
      run: { id: "run-2", source: "leboncoin", status: "completed" },
      listings: [{
        ...createListing("2876543210"),
        title: "Titre uniquement présent au run 2",
        description: "Description uniquement présente au run 2.",
        scrapedAt: "2026-07-18T11:00:00.000Z",
      }],
    });
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = new StoredEvaluationService(repository, { filter });

    await service.evaluate("run-1", evaluationRequest("leboncoin:2876543210"), { requestId: "request-1" });

    const evaluatedRequest = filter.mock.calls[0]?.[0];
    expect(evaluatedRequest?.listings[0]).toMatchObject({
      title: "Maison 2876543210",
      description: "Maison avec jardin.",
    });
    expect(evaluatedRequest?.listings[0]?.title).not.toBe("Titre uniquement présent au run 2");
  });

  it("sends at most three distinct gallery images and preserves the primary image URL", async () => {
    const primary = "https://img.leboncoin.fr/house-a.jpg?rule=classified-1200x800-webp";
    const repository = createRepositoryWithListings([{
      ...createListing("2876543210"),
      imageUrl: primary,
      imageUrls: [
        "https://img.leboncoin.fr/house-a.jpg?rule=ad-large",
        "https://img.leboncoin.fr/house-b.jpg?rule=classified-1200x800-webp",
        "https://img.leboncoin.fr/house-c.jpg?rule=classified-1200x800-webp",
        "https://img.leboncoin.fr/house-d.jpg?rule=classified-1200x800-webp",
      ],
    }]);
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = new StoredEvaluationService(repository, { filter });

    await service.evaluate("run-1", evaluationRequest("leboncoin:2876543210"), {
      requestId: "request-images",
    });

    expect(filter.mock.calls[0]?.[0].listings[0]?.imageUrls).toEqual([
      primary,
      "https://img.leboncoin.fr/house-b.jpg?rule=classified-1200x800-webp",
      "https://img.leboncoin.fr/house-c.jpg?rule=classified-1200x800-webp",
    ]);
  });

  it("coalesces concurrent requests for the same listing set while preserving each caller order", async () => {
    const listingIds = ["2876543210", "2876543211"];
    const repository = createRepositoryWithListings(listingIds.map(createListing));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filter = vi.fn(async (request: FilterListingsRequest) => {
      await gate;
      return createEvaluationResponse(request);
    });
    const service = createService(repository, filter);
    const firstIds = listingIds.map((id) => `leboncoin:${id}`);
    const secondIds = [...firstIds].reverse();

    const firstPromise = service.evaluate(
      "run-1",
      evaluationRequest(...firstIds),
      { requestId: "request-first" },
    );
    const secondPromise = service.evaluate(
      "run-1",
      evaluationRequest(...secondIds),
      { requestId: "request-second" },
    );
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(filter).toHaveBeenCalledTimes(1);
    expect(first.requestId).toBe("request-first");
    expect(second.requestId).toBe("request-second");
    expect(first.items.map((item) => item.listingId)).toEqual(firstIds);
    expect(second.items.map((item) => item.listingId)).toEqual(secondIds);
    const firstAttemptByListing = new Map(first.items.map((item) => [
      item.listingId,
      item.status === "succeeded" ? item.attemptId : undefined,
    ]));
    expect(second.items.every((item) =>
      item.status === "succeeded" && item.attemptId === firstAttemptByListing.get(item.listingId)))
      .toBe(true);
  });

  it("caps semantic repair fan-out across a large invalid request", async () => {
    const listingIds = Array.from({ length: 9 }, (_, index) => String(2_876_543_210 + index));
    const repository = createRepositoryWithListings(listingIds.map(createListing));
    const filter = vi.fn(async (request: FilterListingsRequest) => {
      if (request.listings.length > 1) {
        throw invalidModelOutput({
          stage: "schema",
          detailCode: "SCHEMA_MISMATCH",
          retryable: true,
        });
      }
      return createEvaluationResponse(request);
    });
    const service = createService(repository, filter);

    const response = await service.evaluate(
      "run-1",
      evaluationRequest(...listingIds.map((id) => `leboncoin:${id}`)),
      { requestId: "request-budget" },
    );

    expect(filter).toHaveBeenCalledTimes(9); // 3 initial batches + at most 6 repairs.
    expect(response.status).toBe("partial");
    expect(response.items.slice(0, 6).every((item) => item.status === "succeeded")).toBe(true);
    expect(response.items.slice(6).every((item) => item.status === "failed")).toBe(true);
    expect(repository.countEvaluationAttempts()).toBe(15);
  });

  it("passes the non-enumerable provider response id into successful attempt history", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const saveEvaluationResult = vi.spyOn(repository, "saveEvaluationResult");
    const filter = vi.fn(async (request: FilterListingsRequest) => {
      const response = createEvaluationResponse(request) as FilterListingsResponse & {
        readonly [EVALUATOR_RESPONSE_ID]?: string;
      };
      Object.defineProperty(response, EVALUATOR_RESPONSE_ID, {
        enumerable: false,
        value: "resp-success-1",
      });
      return response;
    });
    const service = createService(repository, filter);

    await service.evaluate(
      "run-1",
      evaluationRequest("leboncoin:2876543210"),
      { requestId: "request-response-id" },
    );

    expect(saveEvaluationResult).toHaveBeenCalledWith(expect.objectContaining({
      responseId: "resp-success-1",
    }));
  });
});

function createRepositoryWithListings(listings: ListingIngestion[]): DenicheurRepository {
  const repository = new DenicheurRepository({ path: ":memory:", now: () => NOW });
  const ingestion: IngestionRequest = {
    run: {
      id: "run-1",
      source: "leboncoin",
      status: "completed",
      startedAt: "2026-07-18T09:00:00.000Z",
      finishedAt: "2026-07-18T09:30:00.000Z",
      collected: listings.length,
    },
    listings,
  };
  repository.ingest(ingestion);
  repository.saveRecipe("recipe-1", {
    name: "Maison bretonne",
    threshold: 70,
    criteria: [{
      id: "garden",
      name: "Jardin",
      description: "Le bien doit disposer d'un jardin.",
      weight: 1,
      required: false,
    }],
  });
  return repository;
}

function createListing(externalId: string): ListingIngestion {
  return {
    source: "leboncoin",
    externalId,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`,
    title: `Maison ${externalId}`,
    description: "Maison avec jardin.",
    features: ["Jardin"],
    status: "detailed",
    scrapedAt: "2026-07-18T09:20:00.000Z",
  };
}

function evaluationRequest(...listingIds: string[]) {
  return {
    locale: "fr" as const,
    recipeId: "recipe-1",
    recipeVersion: 1,
    listingIds,
  };
}

function createService(
  repository: DenicheurRepository,
  filter: (request: FilterListingsRequest) => Promise<FilterListingsResponse>,
): StoredEvaluationService {
  return new StoredEvaluationService(repository, { filter }, {
    evaluator: { provider: "openai", model: "gpt-test", version: "1.0.0" },
  });
}

function createEvaluationResponse(request: FilterListingsRequest): FilterListingsResponse {
  return {
    runId: request.runId,
    locale: request.locale,
    recipeId: request.recipe.id,
    recipeVersion: request.recipe.version,
    evaluator: { provider: "openai", model: "gpt-test", version: "1.0.0" },
    results: request.listings.map((listing) => ({
      listingId: listing.id,
      decision: "relevant",
      score: 100,
      summary: "Le bien correspond au critère.",
      criteria: [{
        criterionId: "garden",
        verdict: "pass",
        reason: "Le jardin est explicitement mentionné.",
        evidence: ["Jardin"],
      }],
      missingData: ["priceEuros", "propertyType", "rooms", "bedrooms", "surfaceM2", "landSurfaceM2", "location", "sellerName", "sellerType", "energyClass", "gesClass"],
      evaluatedAt: NOW.toISOString(),
    })),
  };
}
