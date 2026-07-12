import { describe, expect, it } from "vitest";
import {
  collectListingDetail,
  collectListingSummaries,
  detectCaptcha,
  detectSiteChallenge,
  normalizeListingUrl,
} from "./leboncoinExtractors";

describe("leboncoin extractors", () => {
  it("normalizes current and legacy listing URLs", () => {
    expect(
      normalizeListingUrl(
        "/ad/ventes_immobilieres/3007106066",
        "https://www.leboncoin.fr/recherche?category=9",
      ),
    ).toBe("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066");

    expect(normalizeListingUrl("https://www.leboncoin.fr/c/ventes_immobilieres")).toBeUndefined();
    expect(normalizeListingUrl("http://www.leboncoin.fr/ad/ventes_immobilieres/3007106066")).toBeUndefined();
    expect(normalizeListingUrl("https://preview.leboncoin.fr/ad/ventes_immobilieres/3007106066")).toBeUndefined();
    expect(
      normalizeListingUrl("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066?utm_source=test#photo"),
    ).toBe("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066");
  });

  it("collects listing summaries from result-card-like markup", () => {
    const doc = new DOMParser().parseFromString(
      `
        <article>
          <a href="/ad/ventes_immobilieres/3007106066" aria-label="Maison familiale à Brest"></a>
          <img src="https://img.leboncoin.fr/sample.jpg" />
          <p>Maison · 5 pièces · 112 m²</p>
          <p>Prix: 312.000 €</p>
          <p>Située à Brest 29200.</p>
          <p>Particulier</p>
        </article>
      `,
      "text/html",
    );

    const listings = collectListingSummaries(doc, 20);

    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      id: "3007106066",
      title: "Maison familiale à Brest",
      priceEuros: 312000,
      rooms: 5,
      surfaceM2: 112,
      location: "Brest 29200",
      sellerType: "Particulier",
    });
  });

  it("uses the terminal ad id so listings in one category remain unique", () => {
    const doc = new DOMParser().parseFromString(
      `
        <article><a href="/ad/ventes_immobilieres/3007106066">Maison à Brest</a></article>
        <article><a href="/ad/ventes_immobilieres/3007106077">Maison à Quimper</a></article>
      `,
      "text/html",
    );

    const listings = collectListingSummaries(doc, 20);

    expect(listings.map((listing) => listing.id)).toEqual(["3007106066", "3007106077"]);
    expect(new Set(listings.map((listing) => listing.id)).size).toBe(2);
  });

  it("collects detail fundamentals from an ad page", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head>
            <meta property="og:title" content="Maison lumineuse" />
            <meta property="og:image" content="https://img.leboncoin.fr/detail.jpg" />
          </head>
          <body>
            <h1>Maison lumineuse</h1>
            <main>
              <p>Prix: 410 000 €</p>
              <p>Maison · 6 pièces · 130 m²</p>
              <p>3 chambres</p>
              <p>Terrain 540 m²</p>
              <p>Située à Vannes 56000.</p>
              <p>Classe énergie C GES D</p>
              <p>Garage Jardin Terrasse</p>
              <section data-qa-id="adview_description_container">
                Belle maison proche du centre avec jardin.
              </section>
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    const detail = collectListingDetail(doc);

    expect(detail).toMatchObject({
      title: "Maison lumineuse",
      priceEuros: 410000,
      rooms: 6,
      bedrooms: 3,
      surfaceM2: 130,
      landSurfaceM2: 540,
      location: "Vannes 56000",
      energyClass: "C",
      gesClass: "D",
      imageUrl: "https://img.leboncoin.fr/detail.jpg",
    });
    expect(detail.features).toEqual(expect.arrayContaining(["Garage", "Jardin", "Terrasse"]));
    expect(detail.description).toContain("Belle maison");
  });

  it("detects DataDome and captcha interstitials", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><p>Please enable JS and disable any ad blocker</p><script src="https://ct.captcha-delivery.com/i.js"></script></body></html>`,
      "text/html",
    );

    expect(detectCaptcha(doc)).toBe(true);
  });

  it("detects unusual-activity blocks separately from captchas", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <h1>We detected unusual activity from your device or network.</h1>
            <p>Reasons may include: Rapid taps or clicks. Automated (bot) activity on your network.</p>
            <p>ID: 900f7d46-fdd7-22e9-8c7a-4173a08c30ec</p>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({ type: "unusual-activity" });
    expect(detectCaptcha(doc)).toBe(false);
  });
});
