import { describe, expect, it } from "vitest";
import {
  buildLeboncoinSearchUrl,
  clampMaxListings,
  createDefaultSearchFilters,
  normalizeSearchFilters,
} from "./leboncoinSearch";

describe("leboncoin search URL builder", () => {
  it("builds a search URL from structured real-estate filters", () => {
    const filters = {
      ...createDefaultSearchFilters(),
      text: "maison vue mer",
      locationToken: "Quimper__47.996_-4.102_5000",
      priceMin: 150000,
      priceMax: 350000,
      roomsMin: 4,
      squareMin: 90,
      ownerType: "private" as const,
    };

    const url = new URL(buildLeboncoinSearchUrl(filters));

    expect(url.origin).toBe("https://www.leboncoin.fr");
    expect(url.pathname).toBe("/recherche");
    expect(url.searchParams.get("category")).toBe("9");
    expect(url.searchParams.get("text")).toBe("maison vue mer");
    expect(url.searchParams.get("locations")).toBe("Quimper__47.996_-4.102_5000");
    expect(url.searchParams.get("real_estate_type")).toBe("1,2");
    expect(url.searchParams.get("price")).toBe("150000-350000");
    expect(url.searchParams.get("rooms")).toBe("4-max");
    expect(url.searchParams.get("square")).toBe("90-max");
    expect(url.searchParams.get("owner_type")).toBe("private");
  });

  it("keeps a leboncoin raw search URL intact", () => {
    const filters = {
      ...createDefaultSearchFilters(),
      rawSearchUrl: "https://www.leboncoin.fr/recherche?category=10&price=800-1200",
    };

    expect(buildLeboncoinSearchUrl(filters)).toBe(
      "https://www.leboncoin.fr/recherche?category=10&price=800-1200",
    );
  });

  it("rejects raw URLs outside leboncoin", () => {
    expect(() =>
      buildLeboncoinSearchUrl({
        ...createDefaultSearchFilters(),
        rawSearchUrl: "https://example.com/recherche?category=9",
      }),
    ).toThrow("Search URL must be an HTTPS leboncoin.fr search URL.");
  });

  it("rejects insecure, unsupported-host and non-search raw URLs", () => {
    for (const rawSearchUrl of [
      "http://www.leboncoin.fr/recherche?category=9",
      "https://preview.leboncoin.fr/recherche?category=9",
      "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
    ]) {
      expect(() => buildLeboncoinSearchUrl({ ...createDefaultSearchFilters(), rawSearchUrl })).toThrow(
        "Search URL must be an HTTPS leboncoin.fr search URL.",
      );
    }
  });

  it("defaults the PoC scrape limit to 20 and clamps high values", () => {
    expect(createDefaultSearchFilters().maxListings).toBe(20);
    expect(createDefaultSearchFilters().collectDetailPages).toBe(false);
    expect(createDefaultSearchFilters().minDelaySeconds).toBe(25);
    expect(createDefaultSearchFilters().maxDelaySeconds).toBe(55);
    expect(clampMaxListings(undefined)).toBe(20);
    expect(clampMaxListings(250)).toBe(20);
    expect(clampMaxListings(0)).toBe(1);
  });

  it("normalizes pacing settings conservatively", () => {
    const filters = normalizeSearchFilters({
      ...createDefaultSearchFilters(),
      maxListings: 250,
      minDelaySeconds: 1,
      maxDelaySeconds: 2,
      pauseAfterDetails: 200,
      cooldownSeconds: 5,
    });

    expect(filters.maxListings).toBe(20);
    expect(filters.minDelaySeconds).toBe(5);
    expect(filters.maxDelaySeconds).toBe(5);
    expect(filters.pauseAfterDetails).toBe(20);
    expect(filters.cooldownSeconds).toBe(30);
  });
});
