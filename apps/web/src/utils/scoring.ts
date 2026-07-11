import type { PropertyListing, RankedProperty, RecipeFilter, ScoringRecipe } from "../types";

const dpeOrder = ["A", "B", "C", "D", "E", "F", "G"] as const;

export function getRecipeTotalWeight(recipe: ScoringRecipe) {
  return Object.values(recipe.weights).reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
}

export function scorePropertyWithRecipe(property: PropertyListing, recipe: ScoringRecipe) {
  const total = getRecipeTotalWeight(recipe);
  if (total === 0) {
    return 0;
  }

  return Object.entries(recipe.weights).reduce((score, [key, weight]) => {
    const metric = property.scores[key as keyof typeof recipe.weights] ?? 0;
    return score + (Math.max(0, weight) / total) * metric;
  }, 0);
}

export function matchesRecipeFilters(property: PropertyListing, filters: RecipeFilter[]): boolean {
  return filters.every((filter) => matchesRecipeFilter(property, filter));
}

export function isRecipeFilterValid(filter: RecipeFilter): boolean {
  if (!filter.value.trim()) return false;

  if (filter.field === "type") {
    return ["eq", "neq"].includes(filter.operator) && normalizeComparable(filter.field, filter.value) !== undefined;
  }

  if (filter.field === "dpe") {
    return filter.operator !== "between" && normalizeComparable(filter.field, filter.value) !== undefined;
  }

  if (filter.operator === "between") {
    return parseNumericRange(filter.value) !== undefined;
  }

  return normalizeComparable(filter.field, filter.value) !== undefined;
}

function matchesRecipeFilter(property: PropertyListing, filter: RecipeFilter): boolean {
  if (!isRecipeFilterValid(filter)) return true;

  const actual = getFilterValue(property, filter.field);
  if (actual === undefined) return true;

  if (filter.operator === "between") {
    if (typeof actual !== "number") return true;
    const bounds = parseNumericRange(filter.value);
    if (!bounds) return true;
    const [first, second] = bounds;
    return actual >= Math.min(first, second) && actual <= Math.max(first, second);
  }

  const expected = normalizeComparable(filter.field, filter.value);
  const normalizedActual = normalizeComparable(filter.field, actual);
  if (expected === undefined || normalizedActual === undefined) return true;

  switch (filter.operator) {
    case "eq":
      return normalizedActual === expected;
    case "neq":
      return normalizedActual !== expected;
    case "lte":
      return normalizedActual <= expected;
    case "gte":
      return normalizedActual >= expected;
    default:
      return true;
  }
}

function parseNumericRange(value: string): [number, number] | undefined {
  const parts = value.split(/\s*(?:\.\.|-|,|;)\s*/);
  if (parts.length !== 2 || parts.some((part) => !part.trim())) return undefined;

  const bounds = parts.map(Number);
  return bounds.every(Number.isFinite) ? (bounds as [number, number]) : undefined;
}

function getFilterValue(property: PropertyListing, field: RecipeFilter["field"]): string | number | undefined {
  switch (field) {
    case "price":
      return property.price;
    case "type":
      return property.propertyType;
    case "dpe":
      return property.dpe;
    case "surface":
      return property.surfaceM2;
    case "rooms":
      return property.rooms;
    default:
      return property.scores[field];
  }
}

function normalizeComparable(field: RecipeFilter["field"], value: string | number): string | number | undefined {
  if (field === "dpe") {
    const index = dpeOrder.indexOf(String(value).toUpperCase() as (typeof dpeOrder)[number]);
    return index === -1 ? undefined : index;
  }

  if (field === "type") {
    const normalized = String(value).trim().toLowerCase();
    if (["house", "maison", "casa"].includes(normalized)) return "house";
    if (["apartment", "appartement", "apartamento"].includes(normalized)) return "apartment";
    if (["land", "terrain", "terreno"].includes(normalized)) return "land";
    return undefined;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function rankPropertiesByRecipe(properties: PropertyListing[], recipe: ScoringRecipe): RankedProperty[] {
  return properties
    .filter((property) => matchesRecipeFilters(property, recipe.filters))
    .map((property) => ({ ...property, customScore: scorePropertyWithRecipe(property, recipe) }))
    .sort((a, b) => b.customScore - a.customScore);
}
