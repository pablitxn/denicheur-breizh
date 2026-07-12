import type { FilterListingsRequest, FilterListingsResponse } from "../src/contracts.js";
import type { ModelEvaluationBatch } from "../src/modelOutput.js";

export function createRequest(listingCount = 1): FilterListingsRequest {
  return {
    runId: "run-123",
    recipe: {
      id: "recipe-1",
      version: 1,
      name: "Maison bretonne",
      threshold: 70,
      criteria: [
        {
          id: "large-enough",
          name: "Surface suffisante",
          description: "La surface habitable doit être au moins 80 m².",
          weight: 3,
          required: true,
        },
        {
          id: "quiet",
          name: "Calme",
          description: "Le texte doit indiquer un environnement calme.",
          weight: 1,
          required: false,
        },
      ],
    },
    listings: Array.from({ length: listingCount }, (_, index) => ({
      id: `listing-${index + 1}`,
      url: `https://www.leboncoin.fr/ad/ventes_immobilieres/listing-${index + 1}`,
      title: `Maison lumineuse ${index + 1}`,
      priceEuros: 250_000 + index,
      propertyType: "Maison",
      rooms: 5,
      surfaceM2: 85,
      location: "Quimper 29000",
      sellerType: "Particulier",
      energyClass: "C",
      description: "Maison lumineuse dans un environnement calme.",
      features: ["Jardin", "Garage"],
    })),
  };
}

export function createModelBatch(
  request = createRequest(),
  verdicts: readonly ["pass" | "fail" | "unknown", "pass" | "fail" | "unknown"] = ["pass", "pass"],
): ModelEvaluationBatch {
  return {
    results: request.listings.map((listing) => ({
      listingId: listing.id,
      summary: "Le bien correspond globalement aux critères.",
      criteria: request.recipe.criteria.map((criterion, criterionIndex) => {
        const verdict = verdicts[criterionIndex] ?? "unknown";
        return {
          criterionId: criterion.id,
          verdict,
          reason: verdict === "unknown" ? "Donnée insuffisante." : "Le texte fournit une preuve explicite.",
          evidence: verdict === "unknown" ? [] : [criterionIndex === 0 ? "85" : "environnement calme"],
        };
      }),
    })),
  };
}

export function createResponse(request = createRequest()): FilterListingsResponse {
  return {
    runId: request.runId,
    recipeId: request.recipe.id,
    recipeVersion: request.recipe.version,
    evaluator: {
      provider: "openai",
      model: "gpt-5-mini-2025-08-07",
      version: "1.0.0",
    },
    results: request.listings.map((listing) => ({
      listingId: listing.id,
      decision: "relevant",
      score: 100,
      summary: "Le bien correspond globalement aux critères.",
      criteria: createModelBatch(request).results.find((result) => result.listingId === listing.id)?.criteria ?? [],
      missingData: ["bedrooms", "landSurfaceM2", "sellerName", "gesClass"],
      evaluatedAt: "2026-07-12T10:00:00.000Z",
    })),
  };
}
