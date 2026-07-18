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

  test("maps only listings with verified coordinates and explains the missing coverage", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "map-coverage");
    const propertyType = `Fixture cartographique ${token}`;
    const mappedTitle = `Coordonnées vérifiées ${token}`;
    const unmappedTitle = `Coordonnées absentes ${token}`;
    const mapped = listingFixture(token, "mapped", {
      title: mappedTitle,
      propertyType,
      coordinates: {
        latitude: 48.202,
        longitude: -2.932,
        verifiedAt: FIXTURE_TIME,
        provenance: `Fixture E2E ${token}`,
      },
    });
    const unmapped = listingFixture(token, "unmapped", { title: unmappedTitle, propertyType });
    await ingestListings(request, `web-map-${token}`, [mapped, unmapped]);

    await page.goto("/?view=map");
    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Type de bien", exact: true }).selectOption(propertyType);

    await expect(page.getByText("1 sur 2 biens sont cartographiés", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("1 biens ne disposent pas encore de coordonnées vérifiées.", { exact: true })).toBeVisible();
    const resultPicker = page.getByRole("combobox", { name: "Résultats", exact: true });
    await expect(resultPicker.getByRole("option", { name: mappedTitle, exact: true })).toHaveCount(1);
    await expect(resultPicker.getByRole("option", { name: unmappedTitle, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: mappedTitle, exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Carte des biens immobiliers", exact: true })).toBeVisible();
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
