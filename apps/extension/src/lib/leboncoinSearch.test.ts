import { describe, expect, it } from "vitest";
import {
  clampMaxListings,
  createDefaultSearchFilters,
  isLeboncoinSearchUrl,
  isLeboncoinUrl,
  migrateStoredSearchFilters,
  normalizeSearchFilters,
  validateSearchFilters,
} from "./leboncoinSearch";

describe("leboncoin search filters", () => {
  it("defaults to native-search inputs and conservative pacing", () => {
    const filters = createDefaultSearchFilters();

    expect(filters).toMatchObject({
      source: "leboncoin",
      category: "9",
      locationQuery: "",
      maxListings: 20,
      collectDetailPages: false,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
    });
    expect(filters).not.toHaveProperty("rawSearchUrl");
    expect(filters).not.toHaveProperty("locationToken");
    expect(filters).not.toHaveProperty("closeDetailTabs");
  });

  it("migrates the human-readable prefix of a legacy location token", () => {
    const filters = migrateStoredSearchFilters({
      ...createDefaultSearchFilters(),
      locationQuery: undefined,
      locationToken: " Quimper __47.996_-4.102_5000",
      rawSearchUrl: "https://www.leboncoin.fr/recherche?category=10",
      closeDetailTabs: true,
      category: "10",
    });

    expect(filters.locationQuery).toBe("Quimper");
    expect(filters.category).toBe("10");
    expect(filters).not.toHaveProperty("rawSearchUrl");
    expect(filters).not.toHaveProperty("locationToken");
    expect(filters).not.toHaveProperty("closeDetailTabs");
  });

  it("preserves an explicit native location query instead of the legacy token", () => {
    const filters = migrateStoredSearchFilters({
      locationQuery: "Finistère",
      locationToken: "Quimper__47.996_-4.102_5000",
    });

    expect(filters.locationQuery).toBe("Finistère");
  });

  it("normalizes stored enums, ranges and pacing without retaining unknown fields", () => {
    const filters = normalizeSearchFilters({
      category: "invalid",
      propertyTypes: ["2", "2", "99"],
      ownerType: "invalid",
      priceMin: -1,
      priceMax: 120_000.9,
      maxListings: 250,
      minDelaySeconds: 1,
      maxDelaySeconds: 2,
      pauseAfterDetails: 200,
      cooldownSeconds: 5,
    });

    expect(filters).toMatchObject({
      category: "9",
      propertyTypes: ["2"],
      ownerType: "all",
      priceMax: 120_000,
      maxListings: 100,
      minDelaySeconds: 5,
      maxDelaySeconds: 5,
      pauseAfterDetails: 20,
      cooldownSeconds: 30,
    });
    expect(filters.priceMin).toBeUndefined();
  });

  it("clamps the crawl limit", () => {
    expect(clampMaxListings(undefined)).toBe(20);
    expect(clampMaxListings(250)).toBe(100);
    expect(clampMaxListings(0)).toBe(1);
  });

  it("accepts valid ranges including a zero lower bound", () => {
    const issues = validateSearchFilters({
      ...createDefaultSearchFilters(),
      priceMin: 0,
      priceMax: 120_000,
      roomsMin: 2,
      roomsMax: 3,
    });

    expect(issues).toEqual([]);
  });

  it("reports invalid and reversed native ranges by field", () => {
    const issues = validateSearchFilters({
      ...createDefaultSearchFilters(),
      priceMin: 200_000,
      priceMax: 120_000,
      roomsMin: 0,
      bedroomsMax: 9,
      squareMin: 90,
      squareMax: 50,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "priceMax", message: expect.stringContaining("Price maximum") }),
      expect.objectContaining({ field: "roomsMin", message: expect.stringContaining("between 1 and 8") }),
      expect.objectContaining({ field: "bedroomsMax", message: expect.stringContaining("between 1 and 8") }),
      expect.objectContaining({ field: "squareMax", message: expect.stringContaining("Surface maximum") }),
    ]));
  });

  it("reports out-of-bounds pacing and a reversed delay interval", () => {
    const issues = validateSearchFilters({
      ...createDefaultSearchFilters(),
      maxListings: 101,
      minDelaySeconds: 60,
      maxDelaySeconds: 30,
      pauseAfterDetails: 0,
      cooldownSeconds: 1_801,
    });

    expect(issues.map((issue) => issue.field)).toEqual([
      "maxListings",
      "pauseAfterDetails",
      "cooldownSeconds",
      "maxDelaySeconds",
    ]);
  });
});

describe("leboncoin observed URL validation", () => {
  it("accepts canonical HTTPS origins and the search path", () => {
    expect(isLeboncoinUrl(new URL("https://leboncoin.fr/"))).toBe(true);
    expect(isLeboncoinSearchUrl(new URL("https://www.leboncoin.fr/recherche?category=9"))).toBe(true);
  });

  it("rejects insecure, credentialed, ported, unsupported and non-search URLs", () => {
    for (const value of [
      "http://www.leboncoin.fr/recherche?category=9",
      "https://preview.leboncoin.fr/recherche?category=9",
      "https://user:password@www.leboncoin.fr/recherche?category=9",
      "https://www.leboncoin.fr:444/recherche?category=9",
    ]) {
      expect(isLeboncoinUrl(new URL(value))).toBe(false);
    }

    expect(
      isLeboncoinSearchUrl(
        new URL("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066"),
      ),
    ).toBe(false);
  });
});
