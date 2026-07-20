import { afterEach, describe, expect, it } from "vitest";
import type { EvaluationPlanDraft, IntelligenceRecipe } from "../../types";
import {
  groupVersions,
  moveItem,
  persistWorkingDraft,
  planDraftStorageKey,
  readWorkingDrafts,
  removeWorkingDraft,
  validateRecipeDraft,
  validatePlanDraft,
  workingDraftKey,
} from "./builderModel";

const recipes: IntelligenceRecipe[] = [
  recipe("location", 1, "Location v1"),
  recipe("budget", 1, "Budget"),
  recipe("location", 2, "Location v2"),
];

afterEach(() => window.localStorage.clear());

describe("builder model", () => {
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

  it("persists independent drafts and removes only the published entry", () => {
    const first = { mode: "new", value: { id: "plan-a" } };
    const second = { mode: "version", value: { id: "plan-b" } };
    const firstKey = workingDraftKey("new", "plan-a");
    const secondKey = workingDraftKey("version", "plan-b", 2);
    persistWorkingDraft(planDraftStorageKey, firstKey, first);
    persistWorkingDraft(planDraftStorageKey, secondKey, second);
    expect(readWorkingDrafts(planDraftStorageKey)).toEqual({ [firstKey]: first, [secondKey]: second });

    removeWorkingDraft(planDraftStorageKey, firstKey);
    expect(readWorkingDrafts(planDraftStorageKey)).toEqual({ [secondKey]: second });
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
