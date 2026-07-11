import { describe, expect, it } from "vitest";
import { properties, recipes } from "../assets/mockData";
import { getRecipeTotalWeight, isRecipeFilterValid, matchesRecipeFilters, rankPropertiesByRecipe, scorePropertyWithRecipe } from "./scoring";

describe("scoring utilities", () => {
  it("computes the configured weight total", () => {
    expect(getRecipeTotalWeight(recipes[0])).toBe(100);
  });

  it("scores a property using the recipe weights", () => {
    const score = scorePropertyWithRecipe(properties[0], recipes[0]);
    expect(score).toBeCloseTo(7.63, 2);
  });

  it("sorts properties by computed custom score descending", () => {
    const ranked = rankPropertiesByRecipe(properties, recipes[0]);
    expect(ranked[0].customScore).toBeGreaterThanOrEqual(ranked[1].customScore);
    expect(ranked.map((property) => property.id)).toContain("p1");
  });

  it("applies hard recipe filters before ranking", () => {
    const ranked = rankPropertiesByRecipe(properties, recipes[0]);

    expect(ranked.every((property) => property.price <= 480000)).toBe(true);
    expect(ranked.every((property) => property.propertyType === "house")).toBe(true);
    expect(ranked.every((property) => property.dpe <= "D")).toBe(true);
  });

  it("supports numeric ranges and ignores incomplete draft values", () => {
    const property = properties[0];
    const incompleteFilter = { id: "draft", field: "price", operator: "gte", value: "" } as const;

    expect(matchesRecipeFilters(property, [{ id: "range", field: "price", operator: "between", value: "250000-270000" }])).toBe(true);
    expect(matchesRecipeFilters(property, [incompleteFilter])).toBe(true);
    expect(isRecipeFilterValid(incompleteFilter)).toBe(false);
  });

  it("validates field-specific hard-filter values and operators", () => {
    expect(isRecipeFilterValid({ id: "type", field: "type", operator: "eq", value: "house" })).toBe(true);
    expect(isRecipeFilterValid({ id: "bad-type", field: "type", operator: "lte", value: "house" })).toBe(false);
    expect(isRecipeFilterValid({ id: "bad-dpe", field: "dpe", operator: "lte", value: "Z" })).toBe(false);
    expect(isRecipeFilterValid({ id: "bad-range", field: "price", operator: "between", value: "250000-" })).toBe(false);
  });
});
