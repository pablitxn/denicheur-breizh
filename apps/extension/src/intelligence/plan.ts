import { normalizeIntelligenceRecipe } from "./recipe";
import type {
  EvaluationPlan,
  EvaluationPlanRecipe,
  IntelligenceRecipe,
} from "../lib/types";

/**
 * Accepts the canonical resolved-plan response and the two transitional shapes
 * used while the API and extension are upgraded independently.
 */
export function parseResolvedEvaluationPlan(value: unknown): EvaluationPlan | undefined {
  if (!isRecord(value)) return undefined;
  const envelope = value;
  const rawPlan = isRecord(envelope.plan) ? envelope.plan : envelope;
  const id = requiredText(rawPlan.id);
  const version = positiveInteger(rawPlan.version);
  const name = requiredText(rawPlan.name);
  const operator = rawPlan.operator === "all" || rawPlan.operator === "any"
    ? rawPlan.operator
    : undefined;
  const createdAt = requiredText(rawPlan.createdAt);
  if (!id || !version || !name || !operator || !createdAt) return undefined;
  if (rawPlan.combinerVersion !== undefined && rawPlan.combinerVersion !== "tri-state-v1") {
    return undefined;
  }

  const rawSteps = Array.isArray(rawPlan.recipes)
    ? rawPlan.recipes
    : Array.isArray(rawPlan.steps)
      ? rawPlan.steps
      : [];
  const resolvedRecipes = [
    ...(Array.isArray(rawPlan.resolvedRecipes) ? rawPlan.resolvedRecipes : []),
    ...(Array.isArray(envelope.resolvedRecipes) ? envelope.resolvedRecipes : []),
    ...(Array.isArray(envelope.recipeVersions) ? envelope.recipeVersions : []),
  ];
  if (rawSteps.length < 1 || rawSteps.length > 4) return undefined;

  const recipes = rawSteps.flatMap((rawStep): EvaluationPlanRecipe[] => {
    if (!isRecord(rawStep)) return [];
    const recipeId = requiredText(rawStep.recipeId) ?? requiredText(rawStep.id);
    const recipeVersion = positiveInteger(rawStep.recipeVersion) ?? positiveInteger(rawStep.version);
    if (!recipeId || !recipeVersion) return [];
    const inline = isRecord(rawStep.recipe)
      ? rawStep.recipe
      : Array.isArray(rawStep.criteria)
        ? rawStep
        : resolvedRecipes.find((candidate) => isRecipeIdentity(candidate, recipeId, recipeVersion));
    const recipe = parseRecipeVersion(inline, recipeId, recipeVersion);
    return recipe ? [{ recipeId, recipeVersion, recipe }] : [];
  });
  if (recipes.length !== rawSteps.length) return undefined;
  if (new Set(recipes.map((item) => item.recipeId)).size !== recipes.length) return undefined;

  return {
    id,
    version,
    name,
    operator,
    recipes,
    isDefault: rawPlan.isDefault !== false,
    combinerVersion: "tri-state-v1",
    createdAt,
  };
}

export function primaryPlanRecipe(plan: EvaluationPlan | undefined): IntelligenceRecipe | undefined {
  return plan?.recipes[0]?.recipe;
}

function parseRecipeVersion(
  value: unknown,
  expectedId: string,
  expectedVersion: number,
): IntelligenceRecipe | undefined {
  if (!isRecord(value)) return undefined;
  const id = requiredText(value.id) ?? requiredText(value.recipeId);
  const version = positiveInteger(value.version) ?? positiveInteger(value.recipeVersion);
  if (id !== expectedId || version !== expectedVersion || !Array.isArray(value.criteria)) return undefined;
  const recipe = normalizeIntelligenceRecipe({
    id,
    version,
    name: requiredText(value.name) ?? id,
    threshold: finiteNumber(value.threshold) ?? 0,
    enabled: true,
    criteria: value.criteria.flatMap((criterion, index) => {
      if (!isRecord(criterion)) return [];
      const criterionId = requiredText(criterion.id) ?? `criterion-${index + 1}`;
      return [{
        id: criterionId,
        name: requiredText(criterion.name) ?? criterionId,
        description: typeof criterion.description === "string" ? criterion.description : "",
        weight: finiteNumber(criterion.weight) ?? 0,
        required: criterion.required === true,
        evidenceRequired: criterion.evidenceRequired !== false,
      }];
    }),
  });
  return recipe.criteria.length === value.criteria.length ? recipe : undefined;
}

function isRecipeIdentity(value: unknown, recipeId: string, recipeVersion: number): boolean {
  if (!isRecord(value)) return false;
  return (value.id === recipeId || value.recipeId === recipeId) &&
    (value.version === recipeVersion || value.recipeVersion === recipeVersion);
}

function requiredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
