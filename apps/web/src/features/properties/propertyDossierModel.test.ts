import { describe, expect, it } from "vitest";

import type { PropertyListing } from "../../types";
import { missingPropertyFacts, summarizeEvaluation } from "./propertyDossierModel";

describe("summarizeEvaluation", () => {
  it("counts known outcomes separately from unknown criteria", () => {
    const criteria = [
      { verdict: "pass" }, { verdict: "unknown" }, { verdict: "fail" }, { verdict: "pass" },
    ] as const;

    expect(summarizeEvaluation(criteria)).toEqual({ total: 4, known: 3, pass: 2, fail: 1, unknown: 1 });
  });

  it("does not treat an unknown criterion as a pass or failure", () => {
    expect(summarizeEvaluation([{ verdict: "unknown" }, { verdict: "unknown" }]))
      .toEqual({ total: 2, known: 0, pass: 0, fail: 0, unknown: 2 });
    expect(summarizeEvaluation([])).toEqual({ total: 0, known: 0, pass: 0, fail: 0, unknown: 0 });
  });
});

describe("missingPropertyFacts", () => {
  it("identifies absent structured facts without deriving them from unrelated fields", () => {
    expect(missingPropertyFacts(listing({
      title: "Maison de 80 m² à Quimper", priceText: "Prix sur demande", description: "DPE C",
    }))).toEqual(["price", "surface", "location", "energy", "ges"]);
  });

  it("treats zero values and nonempty text as present", () => {
    expect(missingPropertyFacts(listing({
      priceEuros: 0, surfaceM2: 0, location: " Quimper ", energyClass: " A ", gesClass: " B ",
    }))).toEqual([]);
  });

  it("treats empty or whitespace-only text as absent", () => {
    expect(missingPropertyFacts(listing({
      priceEuros: 250_000, surfaceM2: 85, location: " \n ", energyClass: "", gesClass: "\t",
    }))).toEqual(["location", "energy", "ges"]);
  });

  it("reports only the missing fields and leaves the listing intact", () => {
    const property = listing({ priceEuros: 250_000, location: " Quimper ", gesClass: "B" });
    const before = structuredClone(property);

    expect(missingPropertyFacts(property)).toEqual(["surface", "energy"]);
    expect(property).toEqual(before);
  });
});

function listing(overrides: Partial<PropertyListing> = {}): PropertyListing {
  return {
    source: "leboncoin", externalId: "123", key: "leboncoin:123",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123",
    imageUrls: [], features: [], runs: [], evaluations: [], ...overrides,
  };
}
