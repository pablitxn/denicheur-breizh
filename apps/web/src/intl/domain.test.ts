import { describe, expect, it } from "vitest";
import { properties, recipes, scorings } from "../assets/mockData";
import { getPropertyTitle, localizeRecipe, localizeScoring, localizeScoringGroup } from "./domain";

describe("localized domain copy", () => {
  it("provides English property, scoring and recipe content", () => {
    expect(getPropertyTitle(properties[0]!, "en")).toBe("Stone house");
    expect(localizeScoring(scorings[0]!, "en")).toMatchObject({
      group: "Location",
      name: "Coastal access",
      short: "Distance, terrain and actual travel time to the coast.",
    });
    expect(localizeRecipe(recipes[1]!, "en")).toMatchObject({
      name: "Family house",
      description: expect.stringContaining("Daily life"),
    });
    expect(localizeScoringGroup("Vie quotidienne", "en")).toBe("Daily life");
  });

  it("keeps unknown user-authored recipes in their original language", () => {
    const custom = {
      ...recipes[0]!,
      id: "user-recipe",
      name: "Mi búsqueda personal",
      description: "Quiero estar cerca del mar.",
    };

    const localized = localizeRecipe(custom, "en");

    expect(localized.name).toBe(custom.name);
    expect(localized.description).toBe(custom.description);
    expect(localized.filters).not.toBe(custom.filters);
  });

  it("does not translate user-edited copy that retains a built-in identifier", () => {
    const edited = {
      ...recipes[0]!,
      name: "Mon week-end idéal",
      description: "Je veux conserver exactement ce texte.",
    };

    expect(localizeRecipe(edited, "es")).toMatchObject({
      name: edited.name,
      description: edited.description,
    });
  });

  it("does not translate an external listing title that collides with a mock identifier", () => {
    const external = { ...properties[0]!, title: "Annonce rédigée par le propriétaire" };

    expect(getPropertyTitle(external, "en")).toBe(external.title);
  });

  it("keeps user-authored custom scoring copy unchanged", () => {
    const custom = {
      ...scorings.find((scoring) => scoring.id === "weekend")!,
      name: "Mi puntuación costera",
      short: "Texto escrito por la persona usuaria.",
    };

    expect(localizeScoring(custom, "en")).toMatchObject({
      name: custom.name,
      short: custom.short,
    });
  });
});
