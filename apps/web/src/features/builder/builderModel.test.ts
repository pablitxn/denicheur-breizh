import { afterEach, describe, expect, it } from "vitest";
import type { EvaluationPlanDraft, IntelligenceRecipe } from "../../types";
import {
  groupVersions,
  isPlanWorkingDraft,
  isRecipeWorkingDraft,
  moveItem,
  validateRecipeDraft,
  validatePlanDraft,
} from "./builderModel";

const recipes: IntelligenceRecipe[] = [
  recipe("location", 1, "Location v1"),
  recipe("budget", 1, "Budget"),
  recipe("location", 2, "Location v2"),
];

afterEach(() => window.localStorage.clear());

describe("builder model", () => {
  it("accepts structurally valid unfinished drafts while rejecting incompatible saved entries", () => {
    expect(isRecipeWorkingDraft({ mode: "new", value: { ...recipe("", 1, ""), criteria: [] } })).toBe(true);
    expect(isPlanWorkingDraft({ mode: "new", value: { id: "", name: "", operator: "all", recipes: [] } })).toBe(true);
    expect(isRecipeWorkingDraft({ mode: "version", value: { id: "recipe", name: "Older draft" } })).toBe(false);
    expect(isRecipeWorkingDraft({ mode: "new", value: { ...recipe("recipe", 1, "Draft"), criteria: [null] } })).toBe(false);
    expect(isPlanWorkingDraft({ mode: "new", value: { id: "plan", name: "Draft", operator: "all", recipes: [42] } })).toBe(false);
  });

  it("groups immutable versions by family and exposes the latest first", () => {
    const groups = groupVersions(recipes);

    expect(groups.find((group) => group.id === "location")?.versions.map((item) => item.version)).toEqual([2, 1]);
    expect(groups.find((group) => group.id === "location")?.latest.name).toBe("Location v2");
  });

  it("rejects duplicate recipe families even when their versions differ", () => {
    const draft: EvaluationPlanDraft = {
      id: "plan",
      name: "My plan",
      operator: "all",
      recipes: [
        { recipeId: "location", recipeVersion: 1 },
        { recipeId: "location", recipeVersion: 2 },
      ],
    };

    expect(validatePlanDraft(draft, recipes)).toBe("duplicateFamilies");
  });

  it("rejects recipes whose criteria carry no scoring weight", () => {
    const value = recipe("location", 1, "Location");
    const draft = {
      id: value.id,
      name: value.name,
      threshold: value.threshold,
      criteria: value.criteria.map((criterion) => ({ ...criterion, weight: 0 })),
    };

    expect(validateRecipeDraft(draft)).toBe("criterionWeights");
  });

  it("reorders plan recipes without mutating the original array", () => {
    const original = ["location", "budget", "condition"];
    expect(moveItem(original, 1, -1)).toEqual(["budget", "location", "condition"]);
    expect(original).toEqual(["location", "budget", "condition"]);
  });
});

function recipe(id: string, version: number, name: string): IntelligenceRecipe {
  return {
    id,
    version,
    name,
    threshold: 70,
    criteria: [{ id: "criterion", name: "Criterion", description: "Description", weight: 1, required: false }],
    active: false,
    createdAt: "2026-07-19T10:00:00.000Z",
  };
}
