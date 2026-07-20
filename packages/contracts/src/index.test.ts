import { describe, expect, it } from "vitest";

import {
  createListingKey,
  evaluationBatchResponseSchema,
  evaluationExecutionListingResultSchema,
  evaluationPlanDraftSchema,
  evaluationRequestSchema,
  filterListingInputSchema,
  ingestionRequestSchema,
  intelligenceRecipeSchema,
  MAX_CRITERIA_PER_RECIPE,
  MAX_EVALUATION_IMAGE_URLS,
  MAX_LISTING_IMAGE_URLS,
  listingCoordinatesSchema,
  listingIngestionSchema,
  parseListingKey,
  recipeDraftSchema,
  recipeVersionSchema,
} from "./index.js";

describe("shared contracts", () => {
  it("round-trips the stable source and external id key", () => {
    const identity = { source: "leboncoin" as const, externalId: "2876543210" };

    expect(parseListingKey(createListingKey(identity))).toEqual(identity);
  });

  it("accepts sparse listings without inventing absent fields", () => {
    const parsed = ingestionRequestSchema.parse({
      run: { id: "run-1", source: "leboncoin", status: "collecting-search" },
      listings: [{
        source: "leboncoin",
        externalId: "2876543210",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
        status: "listing",
        scrapedAt: "2026-07-18T09:00:00.000Z",
      }],
    });

    expect(parsed.listings[0]).not.toHaveProperty("title");
    expect(parsed.listings[0]).not.toHaveProperty("priceEuros");
  });

  it("round-trips source locality coordinates with their precision metadata", () => {
    const coordinates = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T09:00:00.000Z",
      provenance: "leboncoin:api:location",
      locationKind: "source-locality" as const,
    };

    const parsed = listingCoordinatesSchema.parse(JSON.parse(JSON.stringify(coordinates)));

    expect(parsed).toEqual(coordinates);
  });

  it("rejects coordinates with missing or unsupported precision metadata and invalid bounds", () => {
    const valid = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T09:00:00.000Z",
      provenance: "leboncoin:api:location",
      locationKind: "source-locality",
    };

    expect(listingCoordinatesSchema.safeParse({ ...valid, locationKind: undefined }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, locationKind: "city-center" }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
    expect(listingCoordinatesSchema.safeParse({ ...valid, longitude: -181 }).success).toBe(false);
  });

  it("rejects duplicate listing identities in one ingestion batch", () => {
    const listing = {
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      status: "listing",
      scrapedAt: "2026-07-18T09:00:00.000Z",
    };

    expect(ingestionRequestSchema.safeParse({
      run: { id: "run-1", source: "leboncoin", status: "collecting-search" },
      listings: [listing, listing],
    }).success).toBe(false);
  });

  it(`limits recipes to ${MAX_CRITERIA_PER_RECIPE} criteria`, () => {
    const criteria = Array.from({ length: MAX_CRITERIA_PER_RECIPE + 1 }, (_, index) => ({
      id: `criterion-${index}`,
      name: `Criterion ${index}`,
      description: "Explicit criterion",
      weight: 1,
      required: false,
    }));

    expect(recipeDraftSchema.safeParse({ name: "Too large", threshold: 50, criteria }).success).toBe(false);
  });

  it("rejects recipes whose criterion weights sum to zero", () => {
    const draft = {
      name: "No signal",
      threshold: 50,
      criteria: [{
        id: "zero",
        name: "Zero",
        description: "This criterion cannot influence the score.",
        weight: 0,
        required: false,
      }],
    };

    expect(recipeDraftSchema.safeParse(draft).success).toBe(false);
    expect(intelligenceRecipeSchema.safeParse({
      ...draft,
      id: "zero-recipe",
      version: 1,
    }).success).toBe(false);
    expect(recipeVersionSchema.safeParse({
      ...draft,
      id: "zero-recipe",
      version: 1,
      active: false,
      createdAt: "2026-07-19T10:00:00.000Z",
    }).success).toBe(false);
  });

  it("bounds evaluation plans and rejects duplicate recipe families", () => {
    const base = {
      name: "Search plan",
      operator: "all" as const,
      recipes: [{ recipeId: "house", recipeVersion: 1 }],
    };

    expect(evaluationPlanDraftSchema.safeParse(base).success).toBe(true);
    expect(evaluationPlanDraftSchema.safeParse({
      ...base,
      recipes: [
        { recipeId: "house", recipeVersion: 1 },
        { recipeId: "house", recipeVersion: 2 },
      ],
    }).success).toBe(false);
    expect(evaluationPlanDraftSchema.safeParse({
      ...base,
      recipes: Array.from({ length: 5 }, (_, index) => ({
        recipeId: `recipe-${index}`,
        recipeVersion: 1,
      })),
    }).success).toBe(false);
  });

  it("requires immutable evaluator provenance on successful execution steps", () => {
    const evaluation = {
      listingId: "leboncoin:2876543210",
      decision: "relevant" as const,
      score: 100,
      summary: "Relevant.",
      criteria: [{
        criterionId: "garden",
        verdict: "pass" as const,
        reason: "The garden is mentioned.",
        evidence: ["Garden"],
      }],
      missingData: [],
      evaluatedAt: "2026-07-19T10:00:00.000Z",
    };
    const result = {
      executionId: "execution-1",
      listingId: evaluation.listingId,
      planId: "plan-1",
      planVersion: 1,
      decision: "relevant",
      score: 100,
      summary: "ALL: relevant.",
      evaluatedAt: evaluation.evaluatedAt,
      steps: [{
        recipeId: "recipe-1",
        recipeVersion: 1,
        status: "succeeded",
        evaluation,
      }],
    };

    expect(evaluationExecutionListingResultSchema.safeParse(result).success).toBe(false);
    expect(evaluationExecutionListingResultSchema.safeParse({
      ...result,
      steps: [{
        ...result.steps[0],
        evaluator: { provider: "openai", model: "gpt-test", version: "3.0.0" },
      }],
    }).success).toBe(true);
  });

  it("allows a compatibility image alongside a full valid image gallery", () => {
    const listing = {
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      imageUrl: "https://img.leboncoin.fr/primary.jpg",
      imageUrls: Array.from(
        { length: MAX_LISTING_IMAGE_URLS },
        (_, index) => `https://img.leboncoin.fr/gallery-${index}.jpg`,
      ),
      status: "detailed",
      scrapedAt: "2026-07-18T09:00:00.000Z",
    };

    expect(listingIngestionSchema.safeParse(listing).success).toBe(true);
    expect(listingIngestionSchema.safeParse({
      ...listing,
      imageUrls: [...listing.imageUrls, "https://img.leboncoin.fr/overflow.jpg"],
    }).success).toBe(false);
  });

  it(`limits evaluation payloads to ${MAX_EVALUATION_IMAGE_URLS} unique HTTPS images`, () => {
    const listing = {
      id: "leboncoin:2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      features: [],
      imageUrls: Array.from(
        { length: MAX_EVALUATION_IMAGE_URLS },
        (_, index) => `https://img.leboncoin.fr/evaluation-${index}.jpg`,
      ),
    };

    expect(filterListingInputSchema.safeParse(listing).success).toBe(true);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: [...listing.imageUrls, "https://img.leboncoin.fr/overflow.jpg"],
    }).success).toBe(false);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: [listing.imageUrls[0], listing.imageUrls[0]],
    }).success).toBe(false);
    expect(filterListingInputSchema.safeParse({
      ...listing,
      imageUrls: ["http://img.leboncoin.fr/insecure.jpg"],
    }).success).toBe(false);
  });

  it("accepts force on stored evaluation requests and rejects unknown controls", () => {
    const request = {
      locale: "fr",
      recipeId: "recipe-1",
      recipeVersion: 1,
      listingIds: ["leboncoin:2876543210"],
      force: true,
    };

    expect(evaluationRequestSchema.safeParse(request).success).toBe(true);
    expect(evaluationRequestSchema.safeParse({ ...request, retryCount: 3 }).success).toBe(false);
  });

  it("validates completed, partial, and failed stored-evaluation batch semantics", () => {
    const evaluation = {
      listingId: "leboncoin:2876543210",
      decision: "relevant",
      score: 100,
      summary: "Le bien correspond.",
      criteria: [{
        criterionId: "garden",
        verdict: "pass",
        reason: "Le jardin est mentionné.",
        evidence: ["Jardin"],
      }],
      missingData: [],
      evaluatedAt: "2026-07-18T10:00:00.000Z",
    };
    const success = {
      listingId: evaluation.listingId,
      status: "succeeded",
      attemptId: "attempt-1",
      evaluation,
      evaluator: { provider: "openai", model: "gpt-test", version: "1.0.0" },
    };
    const failure = {
      listingId: "leboncoin:2876543211",
      status: "failed",
      error: {
        code: "EVIDENCE_REQUIRED",
        stage: "semantic",
        retryable: true,
        requestId: "request-1",
        criterionId: "garden",
      },
    };
    const base = {
      requestId: "request-1",
      runId: "run-1",
      locale: "fr",
      recipeId: "recipe-1",
      recipeVersion: 1,
    };

    expect(evaluationBatchResponseSchema.safeParse({ ...base, status: "completed", items: [success] }).success)
      .toBe(true);
    expect(evaluationBatchResponseSchema.safeParse({ ...base, status: "partial", items: [success, failure] }).success)
      .toBe(true);
    expect(evaluationBatchResponseSchema.safeParse({ ...base, status: "failed", items: [failure] }).success)
      .toBe(true);
    const { attemptId: _attemptId, ...cachedWithoutAttempt } = success;
    const cached = { ...cachedWithoutAttempt, status: "cached" };
    expect(evaluationBatchResponseSchema.safeParse({ ...base, status: "completed", items: [cached] }).success)
      .toBe(true);
    expect(evaluationBatchResponseSchema.safeParse({
      ...base,
      status: "completed",
      items: [{ ...success, attemptId: undefined }],
    }).success).toBe(false);
    expect(evaluationBatchResponseSchema.safeParse({
      ...base,
      status: "completed",
      items: [{ ...cached, attemptId: "attempt-cache" }],
    }).success).toBe(false);
    expect(evaluationBatchResponseSchema.safeParse({ ...base, status: "completed", items: [success, failure] }).success)
      .toBe(false);
    expect(evaluationBatchResponseSchema.safeParse({
      ...base,
      status: "completed",
      items: [{ ...success, evaluation: { ...evaluation, listingId: "leboncoin:wrong" } }],
    }).success).toBe(false);
  });
});
