import { describe, expect, it, vi } from "vitest";

import type {
  FilterListingsRequest,
  FilterListingsResponse,
  IngestionRequest,
  ListingIngestion,
} from "../src/contracts.js";
import { StoredEvaluationService } from "../src/evaluationService.js";
import { DenicheurRepository } from "../src/repository.js";

const NOW = new Date("2026-07-18T10:00:00.000Z");

describe("StoredEvaluationService", () => {
  it("leaves an already ingested listing untouched when the evaluator fails", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const before = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    const filter = vi.fn().mockRejectedValue(new Error("upstream unavailable"));
    const service = new StoredEvaluationService(repository, { filter });

    await expect(service.evaluate("run-1", evaluationRequest("leboncoin:2876543210"), {
      requestId: "request-1",
    })).rejects.toThrow("upstream unavailable");

    const after = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    expect(after).toEqual(before);
    expect(after?.evaluations).toEqual([]);
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
    await expect(service.evaluate("run-1", evaluationRequest("leboncoin:2876543211"), {
      requestId: "request-2",
    })).rejects.toThrow("second batch failed");

    const first = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    const second = repository.getListing({ source: "leboncoin", externalId: "2876543211" });
    expect(first?.evaluations).toHaveLength(1);
    expect(first?.latestEvaluation).toMatchObject({
      runId: "run-1",
      decision: "relevant",
      recipeId: "recipe-1",
    });
    expect(second?.evaluations).toEqual([]);
  });

  it("returns the immutable stored evaluation without calling OpenAI again", async () => {
    const repository = createRepositoryWithListings([createListing("2876543210")]);
    const filter = vi.fn(async (request: FilterListingsRequest) => createEvaluationResponse(request));
    const service = new StoredEvaluationService(repository, { filter });
    const request = evaluationRequest("leboncoin:2876543210");

    const first = await service.evaluate("run-1", request, { requestId: "request-1" });
    const second = await service.evaluate("run-1", request, { requestId: "request-2" });

    expect(second).toEqual(first);
    expect(filter).toHaveBeenCalledTimes(1);
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

function evaluationRequest(listingId: string) {
  return {
    locale: "fr" as const,
    recipeId: "recipe-1",
    recipeVersion: 1,
    listingIds: [listingId],
  };
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
