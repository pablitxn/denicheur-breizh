import { expect, test } from "@playwright/test";

import {
  FIXTURE_TIME,
  activateRecipeVersion,
  getActiveRecipe,
  ingestListings,
  listingFixture,
  saveRecipeVersion,
  testToken,
} from "./realApiFixture.js";

test.describe("Denicheur web against the real local API", () => {
  test("reports API readiness and renders a sparse listing without invented values", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "sparse-listing");
    const runId = `web-sparse-${token}`;
    const title = `Annonce clairsemée ${token}`;
    const listing = listingFixture(token, "sparse", { title, status: "listing" });

    await ingestListings(request, runId, [listing]);
    await page.goto(`/?view=properties&pid=${encodeURIComponent(`leboncoin:${listing.externalId}`)}`);

    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    const heading = page.getByRole("heading", { level: 2, name: title, exact: true });
    await expect(heading).toBeVisible();

    const detail = page.locator("aside").filter({ has: heading });
    await expect(detail.getByText(listing.externalId, { exact: true })).toBeVisible();
    await expect(detail.getByText(runId, { exact: true })).toBeVisible();
    await expect(detail.getByText("leboncoin", { exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: "Ouvrir l’annonce source", exact: true }))
      .toHaveAttribute("href", listing.url);
    await expect(detail.getByText("Non disponible", { exact: true }).first()).toBeVisible();
    await expect(detail.getByText(/^0(?:[,.]0+)?\s*(?:€|m²|pièces?)$/u)).toHaveCount(0);
  });

  test("collects new listings through five-second polling and focus recovery", async ({ context, page, request }, testInfo) => {
    const token = testToken(testInfo, "live-refresh");
    const baseline = listingFixture(token, "baseline", { title: `Point de départ ${token}` });
    await ingestListings(request, `web-refresh-baseline-${token}`, [baseline]);

    await page.goto(`/?view=properties&pid=${encodeURIComponent(`leboncoin:${baseline.externalId}`)}`);
    await expect(page.getByRole("heading", { level: 2, name: baseline.title, exact: true })).toBeVisible();

    const polledTitle = `Reçu par polling ${token}`;
    const polled = listingFixture(token, "poll", { title: polledTitle });
    await expect(page.getByText(polledTitle, { exact: true })).toHaveCount(0);
    const pollingResponse = page.waitForResponse(isListingsPageResponse, { timeout: 8_000 });
    await ingestListings(request, `web-refresh-poll-${token}`, [polled]);
    await pollingResponse;
    await expect(page.getByText(polledTitle, { exact: true }).first()).toBeVisible();

    const peer = await context.newPage();
    await peer.goto("about:blank");
    await peer.bringToFront();

    const focusedTitle = `Reçu au retour du focus ${token}`;
    const focused = listingFixture(token, "focus", { title: focusedTitle });
    await expect(page.getByText(focusedTitle, { exact: true })).toHaveCount(0);
    await ingestListings(request, `web-refresh-focus-${token}`, [focused]);
    const focusResponse = page.waitForResponse(isListingsPageResponse, { timeout: 8_000 });
    await page.bringToFront();
    await focusResponse;
    await expect(page.getByText(focusedTitle, { exact: true }).first()).toBeVisible();
    await peer.close();
  });

  test("keeps the result list in sync with the map and opens a removable property preview", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "map-coverage");
    const propertyType = `Fixture cartographique ${token}`;
    const mappedTitle = `Maison visible en Bretagne ${token}`;
    const distantTitle = `Maison hors zone ${token}`;
    const unmappedTitle = `Coordonnées absentes ${token}`;
    const mapped = listingFixture(token, "mapped", {
      title: mappedTitle,
      propertyType,
      priceEuros: 425_000,
      surfaceM2: 118,
      rooms: 6,
      bedrooms: 4,
      landSurfaceM2: 920,
      location: "Rennes 35000",
      description: "Une maison lumineuse avec jardin, proche des services.",
      sellerName: "Agence du littoral",
      energyClass: "C",
      gesClass: "A",
      features: ["Jardin", "Garage"],
      coordinates: {
        latitude: 48.202,
        longitude: -2.932,
        verifiedAt: FIXTURE_TIME,
        provenance: JSON.stringify({
          site: "fixture",
          container: "#__NEXT_DATA__",
          path: `props.pageProps.ad.location.${token}`,
          provider: "fixture",
        }),
        locationKind: "source-property",
      },
    });
    const distant = listingFixture(token, "distant", {
      title: distantTitle,
      propertyType,
      location: "Centre-Val de Loire",
      coordinates: {
        latitude: 48.2,
        longitude: 1.8,
        verifiedAt: FIXTURE_TIME,
        provenance: `Fixture distante ${token}`,
        locationKind: "source-locality",
      },
    });
    const unmapped = listingFixture(token, "unmapped", { title: unmappedTitle, propertyType });
    await ingestListings(request, `web-map-${token}`, [mapped, distant, unmapped]);

    await page.goto("/?view=map");
    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Type de bien", exact: true }).selectOption(propertyType);

    const map = page.getByRole("region", { name: "Carte des biens immobiliers", exact: true });
    const zoomOut = map.getByRole("button", { name: "Dézoomer", exact: true });
    await expect(zoomOut).toBeVisible();
    await expect(page.getByText("1 bien filtré n’apparaît pas sur la carte, faute de localisation.", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Résultats", exact: true })).toHaveCount(0);

    const results = page.getByRole("list", { name: "Résultats", exact: true });
    const mappedResult = results.getByRole("button", {
      name: `Afficher le détail de ${mappedTitle}`,
      exact: true,
    });
    const distantResult = results.getByRole("button", {
      name: `Afficher le détail de ${distantTitle}`,
      exact: true,
    });
    await expect(mappedResult).toBeVisible();
    await expect(distantResult).toHaveCount(0);
    await expect(results.getByRole("button", {
      name: `Afficher le détail de ${unmappedTitle}`,
      exact: true,
    })).toHaveCount(0);

    await zoomOut.click();
    await expect(distantResult).toBeVisible();

    await mappedResult.click();
    const detail = page.getByRole("complementary", { name: "Détails du bien sélectionné", exact: true });
    await expect(detail.getByRole("heading", { level: 2, name: mappedTitle, exact: true })).toBeVisible();
    await expect(detail.getByText("Une maison lumineuse avec jardin, proche des services.", { exact: true })).toBeVisible();
    await expect(detail).not.toContainText("#__NEXT_DATA__");
    await expect(mappedResult).toHaveAttribute("aria-pressed", "true");
    await expect(distantResult).toHaveCount(0);
    await expect(page.getByRole("img", { name: `Bien sélectionné : ${mappedTitle}`, exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("pid"))
      .toBe(`leboncoin:${mapped.externalId}`);

    await detail.getByRole("button", { name: "Retirer de l’aperçu", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.getByRole("img", { name: `Bien sélectionné : ${mappedTitle}`, exact: true })).toHaveCount(0);
    await expect(mappedResult).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => new URL(page.url()).searchParams.has("pid")).toBe(false);
  });

  test("creates a recipe version in Atelier and activates that exact version", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "recipe-version");
    const recipeId = `recipe-${token}`;
    const initialName = `Recette initiale ${token}`;
    const publishedName = `Recette publiée ${token}`;
    const criterionName = `Pertinence ${token}`;
    const initial = await saveRecipeVersion(request, recipeId, {
      name: initialName,
      threshold: 65,
      criteria: [{
        id: `criterion-${token}`,
        name: criterionName,
        description: "Décider à partir des seuls éléments capturés dans l’annonce.",
        weight: 1,
        required: true,
        evidenceRequired: true,
      }],
    });
    expect(initial.version).toBe(1);
    await activateRecipeVersion(request, recipeId, initial.version);

    await page.goto(`/?view=builder&brid=${encodeURIComponent(`${recipeId}:1`)}`);
    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    const initialVersion = page.getByRole("button", { name: new RegExp(`${escapeRegExp(initialName)} · v1`, "u") });
    await expect(initialVersion).toBeVisible();
    await initialVersion.click();

    await expect(page.getByLabel("Identifiant de recette", { exact: true })).toHaveValue(recipeId);
    await page.getByLabel("Nom", { exact: true }).fill(publishedName);
    const saveButton = page.getByRole("button", { name: "Enregistrer une version", exact: true });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const secondVersion = page.getByRole("button", { name: new RegExp(`${escapeRegExp(publishedName)} · v2`, "u") });
    await expect(secondVersion).toBeVisible();
    const activateButton = page.getByRole("button", { name: "Activer", exact: true });
    await expect(activateButton).toBeEnabled();
    await activateButton.click();

    const publishedPanel = page.locator("aside").filter({ hasText: "Recette publiée" });
    await expect(publishedPanel.getByRole("heading", { level: 2, name: publishedName, exact: true })).toBeVisible();
    await expect(publishedPanel.getByText("v2", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const active = await getActiveRecipe(request);
      return { id: active.id, version: active.version, name: active.name };
    }).toEqual({ id: recipeId, version: 2, name: publishedName });
  });

  test("shows honest unevaluated coverage instead of synthetic scores", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "unevaluated");
    const recipeId = `scores-${token}`;
    const recipeName = `Évaluation réelle ${token}`;
    const criterionName = `Preuve unique ${token}`;
    const recipe = await saveRecipeVersion(request, recipeId, {
      name: recipeName,
      threshold: 72,
      criteria: [{
        id: `proof-${token}`,
        name: criterionName,
        description: "Exiger une preuve textuelle issue de l’annonce.",
        weight: 1,
        required: true,
        evidenceRequired: true,
      }],
    });
    await activateRecipeVersion(request, recipeId, recipe.version);

    const title = `Sans évaluation ${token}`;
    const listing = listingFixture(token, "unevaluated", { title, status: "listing" });
    await ingestListings(request, `web-scores-${token}`, [listing]);
    await page.goto(`/?view=scorings&sid=${encodeURIComponent(`leboncoin:${listing.externalId}`)}`);

    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    const activeRecipe = page.getByText("Recette active", { exact: true }).locator("..");
    await expect(activeRecipe.getByText(recipeName, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Non évalué/u }).first().click();
    const heading = page.getByRole("heading", { level: 2, name: title, exact: true });
    await expect(heading).toBeVisible();
    const evaluationDocs = heading.locator("..");
    await expect(evaluationDocs.getByText("Non évalué", { exact: true })).toBeVisible();
    await expect(evaluationDocs.getByText(/\/ 100/u)).toHaveCount(0);

    const criterionCoverage = page.getByText(criterionName, { exact: true }).locator("..");
    await expect(criterionCoverage.getByText(/^0 sur \d+ évaluations exploitables$/u)).toBeVisible();
    const decisionSummary = page.getByRole("region", { name: "Résumé des décisions", exact: true });
    await expect(decisionSummary.getByText("Non évalué", { exact: true })).toBeVisible();
  });
});

function isListingsPageResponse(response: { url(): string; request(): { method(): string }; ok(): boolean }): boolean {
  return response.ok()
    && response.request().method() === "GET"
    && new URL(response.url()).pathname === "/v1/listings";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
