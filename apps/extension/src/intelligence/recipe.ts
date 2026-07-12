import type { IntelligenceCriterion, IntelligenceRecipe } from "../lib/types";

export const MAX_INTELLIGENCE_CRITERIA = 12;

export function createDefaultIntelligenceRecipe(): IntelligenceRecipe {
  return {
    id: "personal-fit",
    version: 1,
    name: "Personal fit",
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
    name: cleanText(recipe.name, defaults.name),
    threshold: clampNumber(recipe.threshold, 0, 100, defaults.threshold),
    enabled: Boolean(recipe.enabled),
    criteria: Array.isArray(recipe.criteria)
      ? recipe.criteria.slice(0, MAX_INTELLIGENCE_CRITERIA).map((criterion, index) => ({
          id: cleanText(criterion.id, `criterion-${index + 1}`),
          name: cleanText(criterion.name, "Unnamed criterion"),
          description: String(criterion.description ?? "").trim(),
          weight: clampNumber(criterion.weight, 0, 100, 0),
          required: Boolean(criterion.required),
        }))
      : [],
  };
}

export function recipeValidationError(recipe: IntelligenceRecipe): string | undefined {
  if (!recipe.enabled) return undefined;
  if (!recipe.name.trim()) return "Give the intelligence recipe a name.";
  if (recipe.name.trim().length > 160) return "Keep the recipe name under 160 characters.";
  if (!Number.isFinite(recipe.threshold) || recipe.threshold < 0 || recipe.threshold > 100) {
    return "The relevance threshold must be between 0 and 100.";
  }
  if (recipe.criteria.length === 0) return "Add at least one intelligence criterion.";
  if (recipe.criteria.length > MAX_INTELLIGENCE_CRITERIA) {
    return `Use at most ${MAX_INTELLIGENCE_CRITERIA} criteria.`;
  }

  const seenIds = new Set<string>();
  for (const criterion of recipe.criteria) {
    if (!criterion.id.trim() || criterion.id.trim().length > 128 || seenIds.has(criterion.id)) {
      return "Every criterion needs a unique id under 128 characters.";
    }
    seenIds.add(criterion.id);
    if (!criterion.name.trim()) return "Every criterion needs a name.";
    if (criterion.name.trim().length > 160) return "Keep criterion names under 160 characters.";
    if (!criterion.description.trim()) return "Every criterion needs a description.";
    if (criterion.description.trim().length > 2_000) {
      return "Keep criterion descriptions under 2,000 characters.";
    }
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100) {
      return "Criterion weights must be between 0 and 100.";
    }
  }

  if (!recipe.criteria.some((criterion) => criterion.weight > 0)) {
    return "At least one criterion must have a positive weight.";
  }

  return undefined;
}

function cleanText(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback;
}
