import { describe, expect, it } from "vitest";

import { buildFilterResponse } from "../src/filterService.js";
import { createModelBatch, createRequest } from "./fixtures.js";

const EVALUATED_AT = new Date("2026-07-12T10:00:00.000Z");

describe("buildFilterResponse", () => {
  it("marks a listing relevant when its weighted score reaches the threshold", () => {
    const request = createRequest();
    const modelBatch = createModelBatch(request, ["pass", "fail"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({
      decision: "relevant",
      score: 75,
      evaluatedAt: EVALUATED_AT.toISOString(),
    });
  });

  it("marks a listing not relevant when its score is below the threshold", () => {
    const request = createRequest();
    const modelBatch = createModelBatch(request, ["fail", "pass"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({ decision: "not-relevant", score: 25 });
  });

  it("requires review when a required criterion is unknown while retaining the evaluable score", () => {
    const request = createRequest();
    const modelBatch = createModelBatch(request, ["unknown", "pass"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({ decision: "review", score: 100 });
  });

  it("marks a listing not relevant when a required criterion fails even above threshold", () => {
    const request = createRequest();
    request.recipe.threshold = 20;
    const modelBatch = createModelBatch(request, ["fail", "pass"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "3.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({ decision: "not-relevant", score: 25 });
  });

  it("requires review with a null score when no positive-weight criterion is evaluable", () => {
    const request = createRequest();
    const modelBatch = createModelBatch(request, ["unknown", "unknown"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({ decision: "review", score: null });
  });

  it("excludes optional unknown criteria from the score denominator", () => {
    const request = createRequest();
    request.recipe.criteria[0]!.required = false;
    request.recipe.criteria[0]!.weight = 1;
    request.recipe.criteria[1]!.weight = 9;
    const modelBatch = createModelBatch(request, ["pass", "unknown"]);

    const response = buildFilterResponse(request, modelBatch, "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]).toMatchObject({ decision: "relevant", score: 100 });
  });

  it("returns evaluator and recipe metadata at the batch level", () => {
    const request = createRequest();
    const response = buildFilterResponse(request, createModelBatch(request), "gpt-fixed", "2.1.0", EVALUATED_AT);

    expect(response).toMatchObject({
      runId: request.runId,
      locale: "fr",
      recipeId: request.recipe.id,
      recipeVersion: request.recipe.version,
      evaluator: { provider: "openai", model: "gpt-fixed", version: "2.1.0" },
    });
  });

  it.each(["fr", "es", "en"] as const)("echoes the requested %s locale", (locale) => {
    const request = createRequest(1, locale);

    const response = buildFilterResponse(request, createModelBatch(request), "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.locale).toBe(locale);
  });

  it("derives missing data from the normalized listing instead of model output", () => {
    const request = createRequest();

    const response = buildFilterResponse(request, createModelBatch(request), "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]!.missingData).toEqual([
      "bedrooms",
      "landSurfaceM2",
      "sellerName",
      "gesClass",
    ]);
  });

  it("reports an absent title instead of requiring a fabricated placeholder", () => {
    const request = createRequest();
    request.listings[0]!.title = undefined;

    const response = buildFilterResponse(request, createModelBatch(request), "gpt-fixed", "1.0.0", EVALUATED_AT);

    expect(response.results[0]!.missingData).toContain("title");
  });
});
