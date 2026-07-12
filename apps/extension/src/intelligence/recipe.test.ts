import { describe, expect, it } from "vitest";
import {
  createDefaultIntelligenceRecipe,
  normalizeIntelligenceRecipe,
  recipeValidationError,
} from "./recipe";

describe("intelligence recipe", () => {
  it("keeps intelligence disabled by default so existing crawling still works", () => {
    const recipe = createDefaultIntelligenceRecipe();

    expect(recipe).toMatchObject({ enabled: false, threshold: 70, version: 1 });
    expect(recipe.criteria).toEqual([]);
    expect(recipeValidationError(recipe)).toBeUndefined();
  });

  it("requires complete, weighted criteria when enabled", () => {
    const recipe = { ...createDefaultIntelligenceRecipe(), enabled: true };
    expect(recipeValidationError(recipe)).toBe("Add at least one intelligence criterion.");

    recipe.criteria = [
      { id: "garden", name: "Garden", description: "", weight: 10, required: true },
    ];
    expect(recipeValidationError(recipe)).toBe("Every criterion needs a description.");

    recipe.criteria[0].description = "The listing explicitly mentions a private garden.";
    expect(recipeValidationError(recipe)).toBeUndefined();

    recipe.threshold = 101;
    expect(recipeValidationError(recipe)).toBe("The relevance threshold must be between 0 and 100.");
  });

  it("normalizes persisted values without trusting invalid bounds", () => {
    const normalized = normalizeIntelligenceRecipe({
      ...createDefaultIntelligenceRecipe(),
      threshold: 500,
      version: 0,
      criteria: [
        { id: " ", name: " ", description: " evidence ", weight: -5, required: true },
      ],
    });

    expect(normalized.threshold).toBe(100);
    expect(normalized.version).toBe(1);
    expect(normalized.criteria[0]).toMatchObject({
      id: "criterion-1",
      name: "Unnamed criterion",
      description: "evidence",
      weight: 0,
      required: true,
    });
  });
});
