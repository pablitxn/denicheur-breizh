import { describe, expect, it } from "vitest";
import {
  collectListingDetail,
  collectListingSummaries,
  detectCaptcha,
  detectSiteChallenge,
  isDetailExtractionReady,
  isSearchExtractionReady,
  listingIdFromUrl,
  normalizeListingUrl,
} from "./leboncoinExtractors";

function stubRenderedRect(
  element: Element,
  { left, top, width, height }: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: (): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }),
  });
}

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
    expect(
      normalizeListingUrl("https://leboncoin.fr/ventes_immobilieres/3007106066/"),
    ).toBe("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066");
    expect(
      normalizeListingUrl("https://www.leboncoin.fr/ad/ventes_immobilieres/not-an-id"),
    ).toBeUndefined();
    expect(
      normalizeListingUrl("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066/photos"),
    ).toBeUndefined();
    expect(
      listingIdFromUrl("https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066"),
    ).toBe("3007106066");
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

  it("ignores listing links outside the search-results root", () => {
    const doc = new DOMParser().parseFromString(
      `
        <aside aria-label="Annonces recommandées">
          <a href="/ad/ventes_immobilieres/3007106000"><h2>Annonce vue récemment</h2></a>
        </aside>
        <main>
          <section data-testid="search-results-list">
            <article>
              <a href="/ad/ventes_immobilieres/3007106066"><h2>Maison résultat</h2></a>
              <p>250 000 € · 4 pièces · 100 m²</p>
            </article>
          </section>
          <section>
            <h2>Vu récemment</h2>
            <a href="/ad/ventes_immobilieres/3007106001"><h3>Annonce hors résultats</h3></a>
          </section>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 1)).toEqual([
      expect.objectContaining({ id: "3007106066", title: "Maison résultat" }),
    ]);
  });

  it("does not mistake per-card search-result hooks for the complete results root", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <article data-testid="search-result-card">
            <a href="/ad/ventes_immobilieres/3007106066"><h2>Maison une</h2></a>
          </article>
          <article data-testid="search-result-card">
            <a href="/ad/ventes_immobilieres/3007106077"><h2>Maison deux</h2></a>
          </article>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20).map((listing) => listing.id)).toEqual([
      "3007106066",
      "3007106077",
    ]);
  });

  it("uses the visible responsive results root instead of a hidden duplicate", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <section data-testid="search-results-mobile" style="display: none">
            <a href="/ad/ventes_immobilieres/3007106000"><h2>Résultat mobile caché</h2></a>
          </section>
          <section data-testid="search-results-desktop">
            <a href="/ad/ventes_immobilieres/3007106066"><h2>Résultat desktop visible</h2></a>
          </section>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 1).map((listing) => listing.id)).toEqual(["3007106066"]);
  });

  it("collects a rendered card through its transparent click-through link", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <article aria-label="Maison, 2 pièces, 44 mètres carrés.">
            <a
              href="/ad/ventes_immobilieres/3007106066"
              aria-hidden="true"
              style="opacity: 0"
            ></a>
            <p>Maison · 2 pièces · 44 m²</p>
            <p>Prix: 99 000 €</p>
            <p>Brest 29200</p>
          </article>
          <section style="display: none">
            <article>
              <a href="/ad/ventes_immobilieres/3007106000"></a>
              <p>Maison cachée · 6 pièces · 180 m² · 450 000 €</p>
            </article>
          </section>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20)).toEqual([
      expect.objectContaining({
        id: "3007106066",
        title: "Maison, 2 pièces, 44 mètres carrés",
        rooms: 2,
        surfaceM2: 44,
        priceEuros: 99_000,
      }),
    ]);
  });

  it("finds a transparent overlay whose visible card boundary is deeply nested", () => {
    const wrappers = Array.from({ length: 10 }, () => "<div>").join("");
    const closers = Array.from({ length: 10 }, () => "</div>").join("");
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <section data-testid="search-results-list">
            <div class="rendered-card">
              ${wrappers}
                <a
                  href="/ad/ventes_immobilieres/3007106066"
                  aria-hidden="true"
                  style="opacity: 0"
                ></a>
              ${closers}
              <h2>Maison profonde</h2>
              <p>99 000 € · 2 pièces · 44 m² · Située à Brest 29200.</p>
            </div>
          </section>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 1)).toEqual([
      expect.objectContaining({ id: "3007106066", title: "Maison profonde" }),
    ]);
  });

  it("keeps visible sponsored and organic sibling result groups in DOM order", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <section data-testid="search-results-sponsored">
            <a href="/ad/ventes_immobilieres/3007106001"><h2>Maison sponsorisée</h2></a>
          </section>
          <section data-testid="search-results-organic">
            <a href="/ad/ventes_immobilieres/3007106066"><h2>Maison organique une</h2></a>
            <a href="/ad/ventes_immobilieres/3007106077"><h2>Maison organique deux</h2></a>
          </section>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20).map((listing) => listing.id)).toEqual([
      "3007106001",
      "3007106066",
      "3007106077",
    ]);
  });

  it("ignores the current hidden sponsored placeholder without dropping the following card", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <ul>
            <li role="none"><span style="visibility: hidden">Sponsorisé</span></li>
            <li>
              <article aria-label="Terrain">
                <a href="/ad/ventes_immobilieres/3007106001" aria-label="Voir l’annonce"></a>
                <p>Terrain · 68 000 € · Surface du terrain 512 m²</p>
              </article>
            </li>
          </ul>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20)).toEqual([
      expect.objectContaining({ id: "3007106001", title: "Terrain" }),
    ]);
  });

  it("deduplicates sponsored and organic cards by id and keeps the richer card", () => {
    const doc = new DOMParser().parseFromString(
      `
        <article>
          <p>Annonce sponsorisée proposée dans les premiers résultats.</p>
          <a href="https://leboncoin.fr/ventes_immobilieres/3007106066?campaign=sponsored">
            <h2>Maison mise en avant</h2>
          </a>
          <img
            data-src="https://img.leboncoin.fr/sponsored.jpg"
            srcset="https://img.leboncoin.fr/sponsored-1.jpg 320w, https://img.leboncoin.fr/sponsored-2.jpg 480w, https://img.leboncoin.fr/sponsored-3.jpg 640w, https://img.leboncoin.fr/sponsored-4.jpg 800w, https://img.leboncoin.fr/sponsored-5.jpg 1024w, https://img.leboncoin.fr/sponsored-6.jpg 1280w"
          />
        </article>
        <article>
          <a href="/ad/ventes_immobilieres/3007106066#organic">
            <h2>Maison familiale à Brest</h2>
          </a>
          <p>Maison · 5 pièces · 112,5 m²</p>
          <p>312 000 €</p>
          <p>Située à Brest 29200.</p>
          <p>Particulier · Jardin · Garage</p>
          <img src="https://img.leboncoin.fr/organic.jpg" />
        </article>
        <article>
          <a href="/ad/ventes_immobilieres/3007106077"><h2>Maison hors limite</h2></a>
        </article>
      `,
      "text/html",
    );

    const listings = collectListingSummaries(doc, 1);

    expect(listings).toEqual([
      expect.objectContaining({
        id: "3007106066",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
        title: "Maison familiale à Brest",
        priceEuros: 312000,
        surfaceM2: 112.5,
        features: ["Jardin", "Garage"],
        imageUrl: "https://img.leboncoin.fr/organic.jpg",
        imageUrls: expect.arrayContaining([
          "https://img.leboncoin.fr/organic.jpg",
          "https://img.leboncoin.fr/sponsored.jpg",
        ]),
      }),
    ]);
    expect(listings[0]?.imageUrls).toHaveLength(8);
  });

  it("does not fabricate a summary title", () => {
    const doc = new DOMParser().parseFromString(
      `<article><a href="/ad/ventes_immobilieres/3007106066"></a></article>`,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20)).toEqual([
      expect.objectContaining({
        id: "3007106066",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
        title: undefined,
      }),
    ]);
  });

  it("keeps a visible semantic heading even when it contains rooms and surface", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <article>
            <a href="/ad/ventes_immobilieres/3007106066">
              <h2>Maison 5 pièces 112 m² à Brest</h2>
            </a>
          </article>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 1)[0]?.title).toBe("Maison 5 pièces 112 m² à Brest");
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
              <section aria-label="Galerie de photos">
                <img src="https://img.leboncoin.fr/detail.jpg" />
              </section>
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

  it("canonicalizes the detail URL and derives its terminal id", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head>
            <base href="https://leboncoin.fr/ventes_immobilieres/3007106066?tracking=removed#photo" />
          </head>
          <body><main><h1>Maison test</h1><p>200 000 €</p></main></body>
        </html>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      id: "3007106066",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
    });
  });

  it.each([
    ["312 000 €", 312000],
    ["312.000 €", 312000],
    ["1.234,56 €", 1234.56],
  ])("parses the French price format %s", (price, expected) => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Appartement test</h1><p>${price}</p></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc).priceEuros).toBe(expected);
  });

  it("does not confuse a square-metre price with the labelled total price", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Appartement test</h1>
          <p>3 000 €/m²</p>
          <p>Prix : 300 000 €</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      priceText: "300 000 €",
      priceEuros: 300000,
      pricePerSquareMeterText: "3 000 €/m²",
    });
  });

  it("does not reuse a land area as the living surface", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <p>Maison · 4 pièces</p>
          <p>Terrain 540 m²</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      surfaceM2: undefined,
      landSurfaceM2: 540,
    });
  });

  it("extracts decimal surfaces and labelled DPE/GES variants", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <p>Maison · 4 pièces · 112,5 m²</p>
          <p>Classe énergie (DPE) : B</p>
          <p>Classe climat (GES) : A</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      surfaceM2: 112.5,
      energyClass: "B",
      gesClass: "A",
    });
  });

  it("reads the selected grades from the current Leboncoin diagnostic scales", () => {
    const scale = (selected: string | undefined) => ["A", "B", "C", "D", "E", "F", "G"]
      .map((grade) => `<div class="${grade === selected ? "border-solid drop-shadow-sm" : ""}">${grade}</div>`)
      .join("");
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Studio test</h1>
          <div data-qa-id="criteria_item_energy_rate">
            <p>Classe énergie</p>
            <div title="Classe énergie"><div>${scale("B")}</div></div>
          </div>
          <div data-qa-id="criteria_item_ges">
            <p>GES</p>
            <div title="GES"><div>${scale("A")}</div></div>
          </div>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      energyClass: "B",
      gesClass: "A",
    });
  });

  it("does not invent grades from an unselected or ambiguously selected A-G scale", () => {
    const scale = (selected: string[]) => ["A", "B", "C", "D", "E", "F", "G"]
      .map((grade) => `<div class="${selected.includes(grade) ? "border-solid drop-shadow-sm" : ""}">${grade}</div>`)
      .join("");
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Studio test</h1>
          <div data-qa-id="criteria_item_energy_rate">
            <div title="Classe énergie"><div>${scale([])}</div></div>
          </div>
          <div data-qa-id="criteria_item_ges">
            <div title="GES"><div>${scale(["A", "B"])}</div></div>
          </div>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      energyClass: undefined,
      gesClass: undefined,
    });
  });

  it("keeps labels associated with values split across block elements", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <div><div>Surface du terrain</div><div>540 m²</div></div>
          <div><div>DPE</div><div>C</div></div>
          <div><div>GES</div><div>D</div></div>
          <div><div>Vendeur</div><div>Agence Armor</div><div>Professionnel</div></div>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      landSurfaceM2: 540,
      energyClass: "C",
      gesClass: "D",
      sellerName: "Agence Armor",
      sellerType: "Professionnel",
    });
  });

  it("extracts only explicitly labelled seller and publication fields", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Appartement test</h1>
          <p>210 000 €</p>
          <p>Vendeur : Agence Armor Professionnel</p>
          <p>Publiée le 12 juillet 2026 à 09:30</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      sellerName: "Agence Armor",
      sellerType: "Professionnel",
      postedAt: "12 juillet 2026 à 09:30",
    });
  });

  it("does not infer a seller name from a strong price next to a Pro badge", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Appartement test</h1>
          <div><strong>184 500 €</strong><span>Pro</span></div>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      sellerName: undefined,
      sellerType: "Pro",
    });
  });

  it.each([
    ["Hier 23:13", "Hier 23:13"],
    ["Hier à 23:13", "Hier à 23:13"],
    ["Aujourd'hui 09:04", "Aujourd'hui 09:04"],
  ])("accepts the current relative publication format %s", (value, expected) => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Maison test</h1><p>Date de dépôt : ${value}.</p></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc).postedAt).toBe(expected);
  });

  it.each([
    ["Brest 29200 Aujourd'hui à 10:30", "Brest 29200"],
    ["Située à Brest 29200 Aujourd'hui à 10:30", "Brest 29200"],
  ])("stops location before the adjacent publication date in %s", (line, expected) => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Maison test</h1><p>${line}</p></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc).location).toBe(expected);
  });

  it("preserves field boundaries in minified DOM without whitespace text nodes", () => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Maison test</h1><p>Brest 29200</p><p>312 000 €</p><p>4 pièces</p></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      location: "Brest 29200",
      priceEuros: 312000,
      rooms: 4,
    });
  });

  it("does not merge an inline postal code into the following French price", () => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Maison test</h1><div><span>Brest 29200</span><span>312 000 €</span></div></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      location: "Brest 29200",
      priceEuros: 312000,
    });
  });

  it("does not infer absent energy grades or negated features", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Appartement test</h1>
          <p>DPE : Non soumis</p>
          <p>Sans balcon, ni terrasse. Aucun jardin. Pas de garage. Non meublé.</p>
          <p>Cave saine. Parking privé.</p>
        </main>
      `,
      "text/html",
    );

    const detail = collectListingDetail(doc);

    expect(detail.energyClass).toBeUndefined();
    expect(detail.gesClass).toBeUndefined();
    expect(detail.features).toEqual(["Parking", "Cave"]);
  });

  it("does not read GES or DPE grades from substrings in ordinary words", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <p>Deux garages A rénover. Cottages B disponibles.</p>
          <p>DPE non soumis et aucun diagnostic chiffré.</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      energyClass: undefined,
      gesClass: undefined,
    });
  });

  it("does not turn optional or nearby amenities into present features", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <p>Possibilité de piscine. Garage en option. Jardin à proximité.</p>
          <p>Terrasse existante.</p>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc).features).toEqual(["Terrasse"]);
  });

  it("ignores feature text hidden by opacity or content visibility", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <h1>Maison test</h1>
          <div style="opacity: 0">Piscine</div>
          <div style="content-visibility: hidden">Garage</div>
          <div>Jardin</div>
        </main>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc).features).toEqual(["Jardin"]);
  });

  it("extracts visible lazy image candidates and derives the compatibility image", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head><meta property="og:image" content="https://img.leboncoin.fr/hero.jpg" /></head>
          <body>
            <main>
              <h1>Maison test</h1>
              <p>250 000 €</p>
              <picture>
                <source data-srcset="https://img.leboncoin.fr/source-small.jpg 480w, https://img.leboncoin.fr/source-large.jpg 1200w" />
              <img
                src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
                data-src="https://img.leboncoin.fr/lazy.jpg"
                srcset="https://img.leboncoin.fr/card-small.jpg 480w, https://img.leboncoin.fr/card-large.jpg 1200w"
              />
              <img srcset="data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x, https://img.leboncoin.fr/mixed-real.jpg 2x" />
              </picture>
              <img src="http://img.leboncoin.fr/insecure.jpg" />
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    const detail = collectListingDetail(doc);

    expect(detail.imageUrl).toBe("https://img.leboncoin.fr/hero.jpg");
    expect(detail.imageUrls).toEqual([
      "https://img.leboncoin.fr/hero.jpg",
      "https://img.leboncoin.fr/lazy.jpg",
      "https://img.leboncoin.fr/card-small.jpg",
      "https://img.leboncoin.fr/card-large.jpg",
      "https://img.leboncoin.fr/mixed-real.jpg",
      "https://img.leboncoin.fr/source-small.jpg",
      "https://img.leboncoin.fr/source-large.jpg",
    ]);
  });

  it("ignores hidden responsive image candidates inside a visible gallery", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head><meta property="og:image" content="https://img.leboncoin.fr/visible.jpg" /></head>
          <body>
            <main>
              <h1>Maison test</h1>
              <section aria-label="Galerie de photos">
                <img src="https://img.leboncoin.fr/visible.jpg" />
                <div style="display: none">
                  <img data-src="https://img.leboncoin.fr/hidden.jpg" />
                </div>
                <picture aria-hidden="true">
                  <source srcset="https://img.leboncoin.fr/hidden-source.jpg 1200w" />
                </picture>
              </section>
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc).imageUrls).toEqual([
      "https://img.leboncoin.fr/visible.jpg",
    ]);
  });

  it("does not invent a listing photo from an isolated generic Open Graph image", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head><meta property="og:image" content="https://www.leboncoin.fr/logo.svg" /></head>
          <body><main><h1>Bien sans photo</h1><p>100 000 €</p></main></body>
        </html>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      imageUrl: undefined,
      imageUrls: undefined,
    });
  });

  it("does not let a generic Open Graph image override a visible listing gallery", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head><meta property="og:image" content="https://www.leboncoin.fr/assets/logo.svg" /></head>
          <body>
            <main>
              <h1>Maison test</h1>
              <section aria-label="Galerie de photos">
                <img src="https://img.leboncoin.fr/listing-real.jpg" />
              </section>
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      imageUrl: "https://img.leboncoin.fr/listing-real.jpg",
      imageUrls: ["https://img.leboncoin.fr/listing-real.jpg"],
    });
  });

  it("does not include seller avatars or diagnostic icons as listing photos", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <head><meta property="og:image" content="https://img.leboncoin.fr/listing.jpg" /></head>
          <body>
            <main>
              <h1>Maison test</h1>
              <p>250 000 €</p>
              <section aria-label="Galerie de photos"><img src="https://img.leboncoin.fr/listing.jpg" /></section>
              <section aria-label="Vendeur"><img src="https://img.leboncoin.fr/avatar.jpg" /></section>
              <img alt="Classe énergie D" src="https://img.leboncoin.fr/dpe.svg" />
              <img alt="Classe climat B" src="https://img.leboncoin.fr/ges.svg" />
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(collectListingDetail(doc)).toMatchObject({
      energyClass: "D",
      gesClass: "B",
      imageUrls: [
        "https://img.leboncoin.fr/listing.jpg",
      ],
    });
  });

  it("keeps accessible DPE/GES grades after duplicate search links are merged", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <article aria-label="Maison test">
            <a href="/ad/ventes_immobilieres/3007106066"></a>
            <a href="/ad/ventes_immobilieres/3007106066"></a>
            <p>Maison · 4 pièces · 90 m² · 250 000 €</p>
            <img alt="" src="https://img.leboncoin.fr/listing.jpg" />
            <img alt="Classe énergie C" src="https://img.leboncoin.fr/dpe.svg" />
            <img alt="Classe climat A" src="https://img.leboncoin.fr/ges.svg" />
          </article>
        </main>
      `,
      "text/html",
    );

    expect(collectListingSummaries(doc, 20)).toEqual([
      expect.objectContaining({
        id: "3007106066",
        energyClass: "C",
        gesClass: "A",
        imageUrls: ["https://img.leboncoin.fr/listing.jpg"],
      }),
    ]);
  });

  it("keeps absent detail fields undefined and ignores recommended content inside main", () => {
    const doc = new DOMParser().parseFromString(
      `
        <body>
          <main>
            <h1>Bien sans informations</h1>
            <aside aria-label="Annonces recommandées">
              <p>Annonce recommandée · 999 000 € · DPE A · GES A</p>
              <p>Vendeur : Agence Exemple Professionnel · Garage · Jardin</p>
              <img data-src="https://img.leboncoin.fr/recommended.jpg" />
            </aside>
          </main>
        </body>
      `,
      "text/html",
    );

    const detail = collectListingDetail(doc);

    expect(detail).toMatchObject({
      title: "Bien sans informations",
      priceText: undefined,
      priceEuros: undefined,
      propertyType: undefined,
      rooms: undefined,
      surfaceM2: undefined,
      location: undefined,
      sellerName: undefined,
      sellerType: undefined,
      energyClass: undefined,
      gesClass: undefined,
      description: undefined,
      imageUrl: undefined,
      imageUrls: undefined,
      features: [],
    });
    expect(isDetailExtractionReady(detail)).toBe(false);
  });

  it("does not treat a title-derived property type as an independent ready fact", () => {
    const doc = new DOMParser().parseFromString(
      `<main><h1>Maison en cours de chargement</h1><div data-testid="skeleton"></div></main>`,
      "text/html",
    );

    const detail = collectListingDetail(doc);

    expect(detail).toMatchObject({
      title: "Maison en cours de chargement",
      propertyType: "Maison",
    });
    expect(isDetailExtractionReady(detail)).toBe(false);
  });

  it("skips an empty semantic title candidate and uses the next visible one", () => {
    const doc = new DOMParser().parseFromString(
      `<main><h1></h1><h1>Maison réelle</h1><p>Surface 100 m²</p></main>`,
      "text/html",
    );

    expect(collectListingDetail(doc).title).toBe("Maison réelle");
  });

  it("does not mark a detail ready while a visible loading state remains", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main aria-busy="true">
          <h1>Maison test</h1>
          <p>250 000 €</p>
          <div data-testid="skeleton-gallery"></div>
        </main>
      `,
      "text/html",
    );
    const detail = collectListingDetail(doc);

    expect(isDetailExtractionReady(detail, doc)).toBe(false);
  });

  it("distinguishes a not-ready search skeleton from an explicit empty result", () => {
    const skeleton = new DOMParser().parseFromString(
      `<main><div aria-label="Chargement des annonces"></div></main>`,
      "text/html",
    );
    const empty = new DOMParser().parseFromString(
      `<main><h1>Aucune annonce</h1></main>`,
      "text/html",
    );

    expect(isSearchExtractionReady(skeleton, [])).toBe(false);
    expect(isSearchExtractionReady(empty, [])).toBe(true);
  });

  it("treats extracted listings as stronger readiness evidence than a residual skeleton", () => {
    const doc = new DOMParser().parseFromString(
      `
        <main>
          <article>
            <a href="/ad/ventes_immobilieres/3007106066">Maison prête</a>
            <p>99 000 € · 2 pièces · 44 m²</p>
          </article>
          <div data-testid="skeleton-ad-placeholder"></div>
        </main>
      `,
      "text/html",
    );
    const listings = collectListingSummaries(doc, 1);

    expect(listings).toHaveLength(1);
    expect(isSearchExtractionReady(doc, listings)).toBe(true);
  });

  it.each([
    {
      name: "hidden generic captcha iframe",
      resource: '<iframe hidden src="https://captcha.example.test/widget"></iframe>',
    },
    {
      name: "hidden captcha id",
      resource: '<div id="captcha-widget" hidden></div>',
    },
    {
      name: "hidden captcha class",
      resource: '<div class="captcha-container" style="display: none"></div>',
    },
    {
      name: "hidden DataDome iframe",
      resource: `
        <iframe
          hidden
          title="DataDome CAPTCHA"
          src="https://geo.captcha-delivery.com/captcha/?initialCid=redacted"
        ></iframe>
      `,
    },
    {
      name: "preloaded DataDome script",
      resource: '<script src="https://ct.captcha-delivery.com/i.js"></script>',
    },
  ])("ignores a $name inside a normal home page", ({ resource }) => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main>
              <h1>Leboncoin</h1>
              <p>Recherchez parmi de nombreuses annonces immobilières en France.</p>
              <form><button type="submit">Rechercher</button></form>
            </main>
            ${resource}
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("keeps an isolated non-DataDome captcha iframe resumable", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><iframe title="Security verification" src="https://captcha.example.test/widget"></iframe></body></html>`,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "captcha",
      evidence: "visible-captcha-frame",
    });
    expect(detectCaptcha(doc)).toBe(true);
  });

  it("ignores a zero-size captcha iframe when the document has real layout geometry", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <iframe src="https://captcha.example.test/widget"></iframe>
          </body>
        </html>
      `,
      "text/html",
    );
    const challenge = doc.querySelector("iframe");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 20, top: 20, width: 0, height: 0 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it.each([
    {
      name: "generic CAPTCHA",
      src: "https://captcha.example.test/widget",
      type: "captcha",
      evidence: "visible-captcha-frame",
    },
    {
      name: "DataDome",
      src: "https://geo.captcha-delivery.com/captcha/?initialCid=redacted",
      type: "unusual-activity",
      evidence: "visible-datadome-frame",
    },
  ])("detects a rendered $name iframe intersecting a real viewport", ({ src, type, evidence }) => {
    const doc = new DOMParser().parseFromString(
      `<html><body><main><h1>Leboncoin</h1></main><iframe src="${src}"></iframe></body></html>`,
      "text/html",
    );
    const challenge = doc.querySelector("iframe");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 100, top: 80, width: 320, height: 240 });

    expect(detectSiteChallenge(doc)).toMatchObject({ type, evidence });
  });

  it("ignores an offscreen captcha class marker when the document has real layout geometry", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <div class="captcha-container"></div>
          </body>
        </html>
      `,
      "text/html",
    );
    const challenge = doc.querySelector(".captcha-container");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 1_100, top: 100, width: 300, height: 200 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("detects a labelled captcha id marker with a rendered rect intersecting the viewport", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <div id="captcha-widget" aria-label="CAPTCHA verification"></div>
          </body>
        </html>
      `,
      "text/html",
    );
    const challenge = doc.querySelector("#captcha-widget");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 100, top: 80, width: 320, height: 240 });

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "captcha",
      evidence: "visible-captcha-element",
    });
    expect(detectCaptcha(doc)).toBe(true);
  });

  it("ignores an empty full-size captcha placeholder even when it intersects the viewport", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <div id="captcha-widget"></div>
          </body>
        </html>
      `,
      "text/html",
    );
    const challenge = doc.querySelector("#captcha-widget");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 0, top: 0, width: 1_024, height: 768 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it.each([
    '<div id="captcha-widget" inert aria-label="CAPTCHA verification"></div>',
    '<dialog id="captcha-widget" aria-label="CAPTCHA verification"></dialog>',
  ])("ignores an inactive captcha surface: %s", (markup) => {
    const doc = new DOMParser().parseFromString(
      `<html><body><main><h1>Leboncoin</h1></main>${markup}</body></html>`,
      "text/html",
    );
    const challenge = doc.querySelector("#captcha-widget");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 100, top: 80, width: 320, height: 240 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
  });

  it("ignores a labelled captcha marker clipped by a zero-height ancestor", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1></main>
            <div style="height:0;overflow:hidden">
              <div id="captcha-widget" aria-label="CAPTCHA verification"></div>
            </div>
          </body>
        </html>
      `,
      "text/html",
    );
    const challenge = doc.querySelector("#captcha-widget");
    expect(challenge).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(challenge!, { left: 100, top: 80, width: 320, height: 240 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
  });

  it("ignores offscreen semantic CAPTCHA and human-verification copy", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <section id="preload" role="alert" style="position:absolute;left:-10000px">
              <h2>CAPTCHA</h2><p>Vérifiez que vous êtes humain</p>
            </section>
          </body>
        </html>
      `,
      "text/html",
    );
    const preload = doc.querySelector("#preload");
    expect(preload).not.toBeNull();
    stubRenderedRect(doc.documentElement, { left: 0, top: 0, width: 1_024, height: 768 });
    stubRenderedRect(preload!, { left: -10_000, top: 0, width: 320, height: 240 });

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("ignores a DataDome iframe inside a zero-height overflow-hidden ancestor", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <div style="height: 0; overflow: hidden">
              <iframe
                title="Security verification"
                src="https://geo.captcha-delivery.com/captcha/?initialCid=redacted"
              ></iframe>
            </div>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it.each([
    {
      name: "one-pixel preloader",
      attributes: 'width="1" height="1"',
    },
    {
      name: "offscreen clipped preloader",
      attributes: 'style="position: absolute; left: -10000px; clip-path: inset(50%)"',
    },
  ])("ignores a DataDome $name", ({ attributes }) => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Recherchez des annonces immobilières.</p></main>
            <iframe
              ${attributes}
              title="Security verification"
              src="https://geo.captcha-delivery.com/captcha/?initialCid=redacted"
            ></iframe>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("ignores normal help text that mentions DataDome and CAPTCHA", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main>
              <h1>Leboncoin</h1>
              <p>Notre aide explique comment DataDome et CAPTCHA protègent la plateforme.</p>
              <form><button type="submit">Rechercher</button></form>
            </main>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toBeUndefined();
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("treats DataDome interstitials as terminal unusual activity", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><p>Please enable JS and disable any ad blocker</p><script src="https://ct.captcha-delivery.com/i.js"></script></body></html>`,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "datadome-bootstrap",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("treats the observed geo.captcha-delivery iframe as terminal unusual activity", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main>
              <h1>Leboncoin</h1>
              <p>Recherchez parmi de nombreuses annonces immobilières.</p>
            </main>
            <iframe
              title="Security verification"
              src="https://geo.captcha-delivery.com/captcha/?initialCid=redacted"
            ></iframe>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "visible-datadome-frame",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("treats a DataDome iframe title as terminal even before its provider URL is available", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main><h1>Leboncoin</h1><p>Native search controls are still mounted.</p></main>
            <iframe title="DataDome CAPTCHA" src="about:blank"></iframe>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "visible-datadome-frame",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("keeps a non-DataDome captcha iframe resumable", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <main>
              <h1>Leboncoin</h1>
              <p>Recherchez parmi de nombreuses annonces immobilières.</p>
            </main>
            <iframe title="Security verification" src="https://captcha.example.test/widget"></iframe>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "captcha",
      evidence: "visible-captcha-frame",
    });
    expect(detectCaptcha(doc)).toBe(true);
  });

  it("detects a manual captcha separately from DataDome activity blocks", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><h1>Vérifiez que vous êtes humain</h1><div id="captcha-widget"></div></body></html>`,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "captcha",
      evidence: "human-verification-copy",
    });
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

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "restriction-copy",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("classifies the current French temporary-restriction page before captcha markup", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html>
          <body>
            <h1>Accès temporairement restreint</h1>
            <p>Pourquoi ce blocage ? Quelque chose dans le comportement du navigateur nous a intrigué.</p>
            <p>Un robot est sur le même réseau que vous.</p>
            <iframe src="about:blank?captcha"></iframe>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "restriction-copy",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("classifies the observed Spanish temporary-restriction page without retaining identifiers", () => {
    const doc = new DOMParser().parseFromString(
      `
        <html lang="es">
          <body>
            <h1>El acceso está restringido temporalmente</h1>
            <p>¿Por qué este bloqueo? Algo sobre el comportamiento del navegador nos ha intrigado.</p>
            <p>Un robot se encuentra en la misma red que usted.</p>
          </body>
        </html>
      `,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "restriction-copy",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });

  it("stops on the observed isolated iframe interstitial even when its URL has no challenge token", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><iframe title="Accès" src="https://example.invalid/interstitial"></iframe></body></html>`,
      "text/html",
    );

    expect(detectSiteChallenge(doc)).toMatchObject({
      type: "unusual-activity",
      evidence: "isolated-interstitial",
    });
    expect(detectCaptcha(doc)).toBe(false);
  });
});
