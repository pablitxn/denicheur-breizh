import type { IntelligenceCriterion, IntelligenceRecipe } from "../lib/types";

export const MAX_INTELLIGENCE_CRITERIA = 12;

export function createDefaultIntelligenceRecipe(): IntelligenceRecipe {
  return {
    id: "personal-fit",
    version: 1,
    name: "Denicheur Breizh",
    threshold: 70,
    enabled: false,
    criteria: [],
  };
}

export function createEmptyCriterion(): IntelligenceCriterion {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `criterion-${Date.now()}`,
    name: "",
    description: "",
    weight: 10,
    required: false,
  };
}

export function normalizeIntelligenceRecipe(
  recipe: IntelligenceRecipe | undefined,
): IntelligenceRecipe {
  const defaults = createDefaultIntelligenceRecipe();
  if (!recipe) return defaults;

  return {
    id: cleanText(recipe.id, defaults.id),
    version: positiveInteger(recipe.version, defaults.version),
    name: normalizeRecipeName(recipe, defaults),
    threshold: clampNumber(recipe.threshold, 0, 100, defaults.threshold),
    enabled: Boolean(recipe.enabled),
    criteria: Array.isArray(recipe.criteria)
      ? recipe.criteria.slice(0, MAX_INTELLIGENCE_CRITERIA).map((criterion, index) => ({
          id: cleanText(criterion.id, `criterion-${index + 1}`),
          name: cleanText(criterion.name === "Unnamed criterion" ? "" : criterion.name, ""),
          description: String(criterion.description ?? "").trim(),
          weight: clampNumber(criterion.weight, 0, 1_000, 0),
          required: Boolean(criterion.required),
          evidenceRequired: criterion.evidenceRequired !== false,
        }))
      : [],
  };
}

export function recipeValidationError(recipe: IntelligenceRecipe): string | undefined {
  return validateIntelligenceRecipe(recipe)[0]?.message;
}

export interface RecipeValidationIssue {
  code:
    | "name-required"
    | "name-too-long"
    | "threshold-range"
    | "criteria-required"
    | "criteria-too-many"
    | "criterion-id-invalid"
    | "criterion-name-required"
    | "criterion-name-too-long"
    | "criterion-description-required"
    | "criterion-description-too-long"
    | "criterion-weight-range"
    | "positive-weight-required";
  field: "name" | "threshold" | "criteria" | "criterion-name" | "criterion-description" | "criterion-weight";
  message: string;
  criterionId?: string;
}

export function validateIntelligenceRecipe(recipe: IntelligenceRecipe): RecipeValidationIssue[] {
  if (!recipe.enabled) return [];

  const issues: RecipeValidationIssue[] = [];
  if (!recipe.name.trim()) {
    issues.push({ code: "name-required", field: "name", message: "Give the intelligence recipe a name." });
  } else if (recipe.name.trim().length > 160) {
    issues.push({ code: "name-too-long", field: "name", message: "Keep the recipe name under 160 characters." });
  }
  if (!Number.isFinite(recipe.threshold) || recipe.threshold < 0 || recipe.threshold > 100) {
    issues.push({
      code: "threshold-range",
      field: "threshold",
      message: "The relevance threshold must be between 0 and 100.",
    });
  }
  if (recipe.criteria.length === 0) {
    issues.push({ code: "criteria-required", field: "criteria", message: "Add at least one intelligence criterion." });
  } else if (recipe.criteria.length > MAX_INTELLIGENCE_CRITERIA) {
    issues.push({
      code: "criteria-too-many",
      field: "criteria",
      message: `Use at most ${MAX_INTELLIGENCE_CRITERIA} criteria.`,
    });
  }

  const seenIds = new Set<string>();
  for (const criterion of recipe.criteria) {
    if (!criterion.id.trim() || criterion.id.trim().length > 128 || seenIds.has(criterion.id)) {
      issues.push({
        code: "criterion-id-invalid",
        field: "criteria",
        criterionId: criterion.id,
        message: "Every criterion needs a unique id under 128 characters.",
      });
    }
    seenIds.add(criterion.id);
    if (!criterion.name.trim()) {
      issues.push({
        code: "criterion-name-required",
        field: "criterion-name",
        criterionId: criterion.id,
        message: "Every criterion needs a name.",
      });
    } else if (criterion.name.trim().length > 160) {
      issues.push({
        code: "criterion-name-too-long",
        field: "criterion-name",
        criterionId: criterion.id,
        message: "Keep criterion names under 160 characters.",
      });
    }
    if (!criterion.description.trim()) {
      issues.push({
        code: "criterion-description-required",
        field: "criterion-description",
        criterionId: criterion.id,
        message: "Every criterion needs a description.",
      });
    } else if (criterion.description.trim().length > 2_000) {
      issues.push({
        code: "criterion-description-too-long",
        field: "criterion-description",
        criterionId: criterion.id,
        message: "Keep criterion descriptions under 2,000 characters.",
      });
    }
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 1_000) {
      issues.push({
        code: "criterion-weight-range",
        field: "criterion-weight",
        criterionId: criterion.id,
        message: "Criterion weights must be between 0 and 1,000.",
      });
    }
  }

  if (
    recipe.criteria.length > 0 &&
    !recipe.criteria.some((criterion) => Number.isFinite(criterion.weight) && criterion.weight > 0)
  ) {
    issues.push({
      code: "positive-weight-required",
      field: "criteria",
      message: "At least one criterion must have a positive weight.",
    });
  }

  return issues;
}

function cleanText(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeRecipeName(
  recipe: IntelligenceRecipe,
  defaults: IntelligenceRecipe,
): string {
  const id = cleanText(recipe.id, defaults.id);
  const name = String(recipe.name ?? "").trim();
  return id === defaults.id && name === "Personal fit"
    ? defaults.name
    : cleanText(name, defaults.name);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
}
