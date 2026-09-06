import type {
  EvaluationPlan,
  EvaluationPlanDraft,
  EvaluationPlanRecipeRef,
  IntelligenceRecipe,
  RecipeDraft,
} from "../../types";

export const MAX_PLAN_RECIPES = 4;
export const recipeDraftStorageKey = "denicheur:builder:recipe-draft:v1";
export const planDraftStorageKey = "denicheur:builder:plan-draft:v1";

export type DraftMode = "new" | "version" | "duplicate";

export interface RecipeWorkingDraft {
  mode: DraftMode;
  sourceKey?: string;
  value: RecipeDraft;
}

export interface PlanWorkingDraft {
  mode: DraftMode;
  sourceKey?: string;
  value: EvaluationPlanDraft;
}

// Persisted drafts may contain unfinished edits. Check the shape needed by the
// editor here; publication validation below applies the stricter domain rules.
export function isRecipeWorkingDraft(input: unknown): input is RecipeWorkingDraft {
  if (!isWorkingDraft(input)) return false;
  const draft = input.value;
  return typeof draft.threshold === "number" && Array.isArray(draft.criteria)
    && draft.criteria.every((criterion: unknown) => isRecord(criterion)
      && typeof criterion.id === "string" && typeof criterion.name === "string"
      && typeof criterion.description === "string" && typeof criterion.weight === "number"
      && typeof criterion.required === "boolean"
      && (criterion.evidenceRequired === undefined || typeof criterion.evidenceRequired === "boolean"));
}

export function isPlanWorkingDraft(input: unknown): input is PlanWorkingDraft {
  if (!isWorkingDraft(input)) return false;
  const draft = input.value;
  return (draft.operator === "all" || draft.operator === "any") && Array.isArray(draft.recipes)
    && draft.recipes.every((reference: unknown) => isRecord(reference)
      && typeof reference.recipeId === "string" && typeof reference.recipeVersion === "number");
}

function isWorkingDraft(input: unknown): input is Record<string, unknown> & { value: Record<string, unknown> } {
  return isRecord(input) && ["new", "version", "duplicate"].includes(String(input.mode))
    && (input.sourceKey === undefined || typeof input.sourceKey === "string")
    && isRecord(input.value) && typeof input.value.id === "string" && typeof input.value.name === "string";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

export interface VersionFamily<T extends { id: string; name: string; version: number }> {
  id: string;
  latest: T;
  versions: T[];
}

export function recipeVersionKey(recipe?: Pick<IntelligenceRecipe, "id" | "version">): string {
  return recipe ? `${recipe.id}:${recipe.version}` : "";
}

export function planVersionKey(plan?: Pick<EvaluationPlan, "id" | "version">): string {
  return plan ? `${plan.id}:${plan.version}` : "";
}

export function groupVersions<T extends { id: string; name: string; version: number }>(versions: readonly T[]): VersionFamily<T>[] {
  const groups = new Map<string, T[]>();
  for (const version of versions) {
    const current = groups.get(version.id) ?? [];
    current.push(version);
    groups.set(version.id, current);
  }
  return Array.from(groups, ([id, items]) => {
    const sorted = [...items].sort((left, right) => right.version - left.version);
    return { id, latest: sorted[0]!, versions: sorted };
  }).sort((left, right) => left.latest.name.localeCompare(right.latest.name));
}

export function latestRecipeVersion(recipes: readonly IntelligenceRecipe[], recipeId: string): number | undefined {
  let latest: number | undefined;
  for (const recipe of recipes) {
    if (recipe.id === recipeId && (latest === undefined || recipe.version > latest)) latest = recipe.version;
  }
  return latest;
}

export function toRecipeDraft(recipe: IntelligenceRecipe): RecipeDraft {
  return {
    id: recipe.id,
    name: recipe.name,
    threshold: recipe.threshold,
    criteria: recipe.criteria.map((criterion) => ({ ...criterion })),
  };
}

export function toPlanDraft(plan: EvaluationPlan): EvaluationPlanDraft {
  return {
    id: plan.id,
    name: plan.name,
    operator: plan.operator,
    recipes: plan.recipes.map((recipe) => ({ ...recipe })),
  };
}

export function blankRecipeDraft(): RecipeDraft {
  return {
    id: uniqueBuilderId("recipe"),
    name: "",
    threshold: 70,
    criteria: [blankCriterion("criterion-1")],
  };
}

export function blankPlanDraft(recipes: readonly IntelligenceRecipe[]): EvaluationPlanDraft {
  const first = groupVersions(recipes)[0]?.latest;
  return {
    id: uniqueBuilderId("plan"),
    name: "",
    operator: "all",
    recipes: first ? [{ recipeId: first.id, recipeVersion: first.version }] : [],
  };
}

export function duplicateRecipeDraft(recipe: IntelligenceRecipe): RecipeDraft {
  return {
    ...toRecipeDraft(recipe),
    id: uniqueBuilderId(`${recipe.id}-copy`),
    name: `${recipe.name} · copy`,
  };
}

export function duplicatePlanDraft(plan: EvaluationPlan): EvaluationPlanDraft {
  return {
    ...toPlanDraft(plan),
    id: uniqueBuilderId(`${plan.id}-copy`),
    name: `${plan.name} · copy`,
  };
}

export function validateRecipeDraft(draft: RecipeDraft): string | undefined {
  if (!draft.id.trim() || draft.id.length > 128 || !draft.name.trim()) return "identity";
  if (!Number.isFinite(draft.threshold) || draft.threshold < 0 || draft.threshold > 100) return "threshold";
  if (draft.criteria.length < 1 || draft.criteria.length > 12) return "criteria";
  const ids = draft.criteria.map((criterion) => criterion.id.trim());
  if (ids.some((id) => !id || id.length > 128) || new Set(ids).size !== ids.length) return "criterionIds";
  if (draft.criteria.some((criterion) =>
    !criterion.name.trim()
    || !criterion.description.trim()
    || !Number.isFinite(criterion.weight)
    || criterion.weight < 0
    || criterion.weight > 1_000)) return "criterionFields";
  if (draft.criteria.reduce((total, criterion) => total + criterion.weight, 0) <= 0) return "criterionWeights";
  return undefined;
}

export function validatePlanDraft(
  draft: EvaluationPlanDraft,
  recipes: readonly IntelligenceRecipe[],
): string | undefined {
  if (!draft.id.trim() || draft.id.length > 128 || !draft.name.trim()) return "identity";
  if (draft.operator !== "all" && draft.operator !== "any") return "operator";
  if (draft.recipes.length < 1 || draft.recipes.length > MAX_PLAN_RECIPES) return "recipes";
  const families = draft.recipes.map((recipe) => recipe.recipeId);
  if (new Set(families).size !== families.length) return "duplicateFamilies";
  const available = new Set(recipes.map((recipe) => recipeVersionKey(recipe)));
  if (draft.recipes.some((recipe) => !available.has(recipeRefKey(recipe)))) return "missingVersion";
  return undefined;
}

export function nextAvailableRecipe(
  recipes: readonly IntelligenceRecipe[],
  selected: readonly EvaluationPlanRecipeRef[],
): EvaluationPlanRecipeRef | undefined {
  const selectedFamilies = new Set(selected.map((recipe) => recipe.recipeId));
  const next = groupVersions(recipes).find((family) => !selectedFamilies.has(family.id))?.latest;
  return next ? { recipeId: next.id, recipeVersion: next.version } : undefined;
}

export function recipeRefKey(reference: EvaluationPlanRecipeRef): string {
  return `${reference.recipeId}:${reference.recipeVersion}`;
}

export function parseRecipeRef(value: string): EvaluationPlanRecipeRef | undefined {
  const separator = value.lastIndexOf(":");
  const recipeId = value.slice(0, separator);
  const recipeVersion = Number(value.slice(separator + 1));
  return separator > 0 && recipeId && Number.isInteger(recipeVersion) && recipeVersion > 0
    ? { recipeId, recipeVersion }
    : undefined;
}

export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function workingDraftKey(mode: DraftMode, id: string, baseVersion?: number): string {
  return mode === "version" && baseVersion !== undefined ? `${id}:${baseVersion}` : `new:${id}`;
}

export function blankCriterion(id: string) {
  return { id, name: "", description: "", weight: 1, required: false, evidenceRequired: true };
}

function uniqueBuilderId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : `${Date.now()}`;
  return `${slug(prefix) || "item"}-${suffix}`.slice(0, 128);
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
