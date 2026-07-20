import { describe, expect, it } from "vitest";
import {
  createDefaultIntelligenceRecipe,
  normalizeIntelligenceRecipe,
  recipeValidationError,
  validateIntelligenceRecipe,
} from "./recipe";

describe("intelligence recipe", () => {
  it("keeps intelligence disabled by default so existing crawling still works", () => {
    const recipe = createDefaultIntelligenceRecipe();

    expect(recipe).toMatchObject({
      enabled: false,
      threshold: 70,
      version: 1,
      name: "Denicheur Breizh",
    });
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
      name: "",
      description: "evidence",
      weight: 0,
      required: true,
    });
  });

  it("migrates the legacy English default recipe name to the neutral product name", () => {
    const normalized = normalizeIntelligenceRecipe({
      ...createDefaultIntelligenceRecipe(),
      name: "Personal fit",
    });

    expect(normalized.name).toBe("Denicheur Breizh");
  });

  it("keeps contract weights up to one thousand and defaults legacy evidence policy to required", () => {
    const normalized = normalizeIntelligenceRecipe({
      ...createDefaultIntelligenceRecipe(),
      enabled: true,
      criteria: [{
        id: "sea-view",
        name: "Sea view",
        description: "The listing explicitly describes a sea view.",
        weight: 800,
        required: false,
      }],
    });

    expect(normalized.criteria[0]).toMatchObject({
      weight: 800,
      evidenceRequired: true,
    });
    expect(validateIntelligenceRecipe(normalized)).toEqual([]);
  });

  it("returns field-addressable issues for inline validation and focus", () => {
    const recipe = {
      ...createDefaultIntelligenceRecipe(),
      enabled: true,
      name: "",
      threshold: Number.NaN,
      criteria: [{
        id: "garden",
        name: "",
        description: "",
        weight: Number.NaN,
        required: true,
      }],
    };

    expect(validateIntelligenceRecipe(recipe)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "name-required", field: "name" }),
      expect.objectContaining({ code: "threshold-range", field: "threshold" }),
      expect.objectContaining({
        code: "criterion-name-required",
        field: "criterion-name",
        criterionId: "garden",
      }),
      expect.objectContaining({
        code: "criterion-description-required",
        field: "criterion-description",
        criterionId: "garden",
      }),
      expect.objectContaining({
        code: "criterion-weight-range",
        field: "criterion-weight",
        criterionId: "garden",
      }),
    ]));
  });
});
