import type { PropertyListing, RankedProperty, ScoringRecipe } from "../types";

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

export function rankPropertiesByRecipe(properties: PropertyListing[], recipe: ScoringRecipe): RankedProperty[] {
  return properties
    .map((property) => ({ ...property, customScore: scorePropertyWithRecipe(property, recipe) }))
    .sort((a, b) => b.customScore - a.customScore);
}
