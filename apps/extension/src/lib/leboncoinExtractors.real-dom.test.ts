import { describe, expect, it } from "vitest";
import diagnosticsFixtureHtml from "./__fixtures__/leboncoin/2026-07-13/listing-detail-diagnostics.sanitized.html?raw";
import detailFixtureHtml from "./__fixtures__/leboncoin/2026-07-13/listing-detail.sanitized.html?raw";
import locationStateFixtureHtml from "./__fixtures__/leboncoin/2026-07-18/listing-detail-location-state.sanitized.html?raw";
import expected from "./__fixtures__/leboncoin/2026-07-13/expected.json";
import searchFixtureHtml from "./__fixtures__/leboncoin/2026-07-13/search-results.sanitized.html?raw";
import {
  collectListingDetail,
  collectListingSummaries,
  isDetailExtractionReady,
  isSearchExtractionReady,
} from "./leboncoinExtractors";

const summaryFields = [
  "source",
  "id",
  "url",
  "title",
  "priceText",
  "priceEuros",
  "pricePerSquareMeterText",
  "propertyType",
  "rooms",
  "bedrooms",
  "surfaceM2",
  "landSurfaceM2",
  "location",
  "sellerName",
  "sellerType",
  "postedAt",
  "energyClass",
  "gesClass",
  "imageUrl",
  "imageUrls",
  "features",
] as const;

const detailFields = [
  "id",
  "url",
  "title",
  "priceText",
  "priceEuros",
  "pricePerSquareMeterText",
  "propertyType",
  "rooms",
  "bedrooms",
  "surfaceM2",
  "landSurfaceM2",
  "location",
  "sellerName",
  "sellerType",
  "postedAt",
  "description",
  "energyClass",
  "gesClass",
  "imageUrl",
  "imageUrls",
  "features",
] as const;

describe("sanitized current Leboncoin DOM fixtures", () => {
  it("extracts unique plausible results and excludes the professional carousel", () => {
    const doc = parseFixture(searchFixtureHtml, expected.search.pageUrl);
    const listings = collectListingSummaries(doc, expected.search.limit);

    expect(listings).toHaveLength(expected.search.listings.length);
    listings.forEach((listing, index) => {
      expectFields(
        listing as unknown as Record<string, unknown>,
        expected.search.listings[index] as Record<string, unknown>,
        summaryFields,
      );
    });

    expect(new Set(listings.map((listing) => listing.url)).size).toBe(listings.length);
    for (const listing of listings) {
      expect(new URL(listing.url)).toMatchObject({
        protocol: "https:",
        hostname: "www.leboncoin.fr",
      });
      expect(listing.url).toMatch(new RegExp(`/ad/ventes_immobilieres/${listing.id}$`));
    }
    expect(listings.map((listing) => listing.id)).not.toEqual(
      expect.arrayContaining(expected.search.excludedIds),
    );
    expect(isSearchExtractionReady(doc, listings)).toBe(true);
  });

  it("preserves duplicate links while excluded placeholder/carousel branches stay inert", () => {
    const doc = parseFixture(searchFixtureHtml, expected.search.pageUrl);
    const duplicateLinks = doc.querySelectorAll(
      `a[href$="/${expected.search.duplicateLinkId}"]`,
    );

    expect(duplicateLinks.length).toBeGreaterThan(1);
    expect(doc.querySelector('li[role="none"]')?.textContent).toBe("");
    expect(doc.querySelector(
      '[aria-label="Carrousel des annonces du professionnel"] img[loading="lazy"]',
    )).not.toBeNull();
    expect(collectListingSummaries(doc, 20).filter(
      (listing) => listing.id === expected.search.duplicateLinkId,
    )).toHaveLength(1);
  });

  it("matches every visible detail field and leaves absent DPE/GES undefined", () => {
    const doc = parseFixture(detailFixtureHtml, expected.detail.pageUrl);
    const detail = collectListingDetail(doc);

    expectFields(
      detail as unknown as Record<string, unknown>,
      expected.detail.listing as Record<string, unknown>,
      detailFields,
    );
    expect(detail.imageUrls).not.toContain(
      "https://fixtures.invalid/leboncoin/detail-recommended-1.jpg",
    );
    expect(isDetailExtractionReady(detail, doc)).toBe(true);
  });

  it("reads the visibly selected DPE/GES grades from the current real scale DOM", () => {
    const doc = parseFixture(
      diagnosticsFixtureHtml,
      "https://www.leboncoin.fr/ad/ventes_immobilieres/900000000003",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      energyClass: "B",
      gesClass: "A",
    });
  });

  it("classifies the observed embedded location as source-locality evidence", () => {
    const doc = parseFixture(
      locationStateFixtureHtml,
      "https://www.leboncoin.fr/ad/ventes_immobilieres/900000000004",
    );

    expect(collectListingDetail(doc).coordinateEvidence).toMatchObject({
      latitude: 47.8,
      longitude: -3.8,
      locationKind: "source-locality",
      provenance: expect.stringContaining('"path":"props.pageProps.ad.location"'),
    });
  });
});

function parseFixture(html: string, pageUrl: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = pageUrl;
  doc.head.prepend(base);
  return doc;
}

function expectFields(
  actual: Record<string, unknown>,
  fixtureExpected: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const expectedValue = fixtureExpected[field];
    if (expectedValue === null) {
      expect(actual[field], field).toBeUndefined();
    } else {
      expect(actual[field], field).toEqual(expectedValue);
    }
  }
}
