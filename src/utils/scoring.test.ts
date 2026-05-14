import { describe, expect, it } from "vitest";
import { properties, recipes } from "../assets/mockData";
import { getRecipeTotalWeight, rankPropertiesByRecipe, scorePropertyWithRecipe } from "./scoring";

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
});
