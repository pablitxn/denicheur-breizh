import { expect, test, type Locator } from "@playwright/test";

import {
  FIXTURE_TIME,
  getDefaultEvaluationPlan,
  getEvaluationExecution,
  getEvaluationExecutionResults,
  ingestListings,
  listingFixture,
  saveEvaluationPlanVersion,
  saveRecipeVersion,
  setDefaultEvaluationPlan,
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    const token = testToken(testInfo, "map-coverage");
    const propertyType = `Fixture cartographique ${token}`;
    const mappedTitle = `Maison visible en Bretagne ${token}`;
    const coastalTitle = `Maison à Camaret-sur-Mer ${token}`;
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
      location: "Quimper 29000",
      description: "Une maison lumineuse avec jardin, proche des services.",
      sellerName: "Agence du littoral",
      energyClass: "C",
      gesClass: "A",
      features: ["Jardin", "Garage"],
      coordinates: {
        latitude: 47.996,
        longitude: -4.102,
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
    const coastal = listingFixture(token, "camaret", {
      title: coastalTitle,
      propertyType,
      location: "Camaret-sur-Mer 29570",
      coordinates: {
        latitude: 48.276667,
        longitude: -4.595556,
        verifiedAt: FIXTURE_TIME,
        provenance: `Fixture Camaret ${token}`,
        locationKind: "source-property",
      },
    });
    const unmapped = listingFixture(token, "unmapped", { title: unmappedTitle, propertyType });
    await ingestListings(request, `web-map-${token}`, [mapped, coastal, distant, unmapped]);

    await page.goto("/?view=map");
    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Type de bien", exact: true }).selectOption(propertyType);

    const map = page.getByRole("region", { name: "Carte de Bretagne et des biens immobiliers", exact: true });
    const zoomOut = map.getByRole("button", { name: "Dézoomer", exact: true });
    await expect(zoomOut).toBeVisible();
    await expect(page.getByText("1 bien filtré n’apparaît pas sur la carte, faute de localisation.", { exact: true })).toBeVisible();
    await expect(page.getByText("1 bien géolocalisé hors Bretagne est masqué sur cette carte.", { exact: true })).toBeVisible();
    await expect(page.getByText("Bretagne administrative · 4 départements", { exact: true })).toBeVisible();
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
    const coastalResult = results.getByRole("button", {
      name: `Afficher le détail de ${coastalTitle}`,
      exact: true,
    });
    await expect(mappedResult).toBeVisible();
    await expect(coastalResult).toBeVisible();
    await expect(distantResult).toHaveCount(0);
    await expect(results.getByRole("button", {
      name: `Afficher le détail de ${unmappedTitle}`,
      exact: true,
    })).toHaveCount(0);

    const pointeDuRaz = map.getByRole("button", { name: "Découvrir Pointe du Raz", exact: true });
    const quimperInterest = map.getByRole("button", {
      name: "Découvrir Cathédrale Saint-Corentin",
      exact: true,
    });
    await expect(pointeDuRaz).toBeVisible();
    await expect(quimperInterest).toBeVisible();
    await expect.poll(() => pointeDuRaz.evaluate((element) => getComputedStyle(element).position))
      .toBe("absolute");
    await expect.poll(async () => {
      const [pointeBox, quimperBox] = await Promise.all([
        pointeDuRaz.boundingBox(),
        quimperInterest.boundingBox(),
      ]);
      if (!pointeBox || !quimperBox) return false;
      const pointeCenterY = pointeBox.y + pointeBox.height / 2;
      const quimperCenterY = quimperBox.y + quimperBox.height / 2;
      return quimperBox.x > pointeBox.x && Math.abs(pointeCenterY - quimperCenterY) < 30;
    }).toBe(true);
    await pointeDuRaz.click();
    const interestDetail = page.getByRole("complementary", { name: "Détail du lieu d’intérêt", exact: true });
    await expect(interestDetail.getByRole("heading", { level: 2, name: "Pointe du Raz", exact: true })).toBeVisible();
    await expect(interestDetail.getByText("Point repère, pas une emprise exacte", { exact: false })).toBeVisible();
    await expect(interestDetail.getByRole("link", { name: "Voir la source DATAtourisme", exact: true }))
      .toHaveAttribute("href", "https://data.datatourisme.fr/38/1c2677ba-27c0-3690-a921-b584198385ce");
    await expect(interestDetail.getByRole("link", { name: "Voir les coordonnées IGN", exact: true }))
      .toHaveAttribute(
        "href",
        "https://data.geopf.fr/geocodage/search?index=poi&limit=1&q=Pointe%20du%20Raz",
      );
    await interestDetail.getByRole("button", { name: "Fermer le lieu d’intérêt", exact: true }).click();
    await expect(interestDetail).toHaveCount(0);

    await mappedResult.click();
    const detail = page.getByRole("complementary", { name: "Détails du bien sélectionné", exact: true });
    await expect(detail.getByRole("heading", { level: 2, name: mappedTitle, exact: true })).toBeVisible();
    await expect(detail.getByText("Une maison lumineuse avec jardin, proche des services.", { exact: true })).toBeVisible();
    await expect(detail).not.toContainText("#__NEXT_DATA__");
    await expect(detail.getByText("Contexte touristique et naturel", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", {
      name: "Découvrir Cathédrale Saint-Corentin",
      exact: true,
    })).toBeVisible();
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

    const mapZoom = async () => Number(await map.getAttribute("data-map-zoom"));
    let previousZoom = await mapZoom();
    expect(previousZoom).toBeGreaterThan(7);
    for (let zoomStep = 0; zoomStep < 8; zoomStep += 1) {
      await expect(zoomOut).toBeEnabled();
      await zoomOut.click();
      await expect.poll(mapZoom).toBeLessThan(previousZoom - 0.5);
      previousZoom = await mapZoom();
    }
    await expect(zoomOut).toBeEnabled();
    expect(previousZoom).toBeLessThan(3.5);
    await expect(distantResult).toHaveCount(0);

    const mapBox = await map.boundingBox();
    expect(mapBox).not.toBeNull();
    if (!mapBox) throw new Error("Map geometry unavailable for pan assertion");
    await page.mouse.move(mapBox.x + mapBox.width * 0.68, mapBox.y + mapBox.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + mapBox.width * 0.46, mapBox.y + mapBox.height * 0.55, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => Number(await map.getAttribute("data-map-center-longitude")))
      .toBeGreaterThan(-0.72);
  });

  test("navigates every property photo in cards and both detail panels", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "property-gallery");
    const title = `Maison avec galerie ${token}`;
    const selectedTitle = `Bien sélectionné avant galerie ${token}`;
    const propertyType = `Fixture galerie ${token}`;
    const imageUrls = [1, 2, 3].map((index) => `https://fixtures.invalid/${token}/photo-${index}.svg`);
    const selected = listingFixture(token, "gallery-selected", { title: selectedTitle });
    const listing = listingFixture(token, "gallery", {
      title,
      propertyType,
      location: "Quimper 29000",
      imageUrls,
      coordinates: {
        latitude: 47.996,
        longitude: -4.102,
        verifiedAt: FIXTURE_TIME,
        provenance: `Fixture galerie ${token}`,
        locationKind: "source-property",
      },
    });

    await page.route("https://fixtures.invalid/**", (route) => route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12"><rect width="16" height="12" fill="#7257d4"/></svg>',
    }));
    await ingestListings(request, `web-gallery-${token}`, [selected, listing]);

    await page.goto(`/?view=properties&pmode=cards&pid=${encodeURIComponent(`leboncoin:${selected.externalId}`)}`);
    await expect(page.getByRole("heading", { level: 2, name: selectedTitle, exact: true })).toBeVisible();

    const selectCard = page.getByRole("button", {
      name: `Afficher le détail de ${title}`,
      exact: true,
    });
    const card = page.locator("article").filter({ has: selectCard });
    const cardGallery = card.getByRole("group", { name: `Galerie photos de ${title}`, exact: true });
    const cardFirstImage = cardGallery.getByRole("img", { name: `Photo 1 sur 3 : ${title}`, exact: true });
    await expectLoadedImage(cardFirstImage, imageUrls[0]);

    await cardGallery.getByRole("button", { name: `Photo suivante de ${title}`, exact: true }).click();
    await expectLoadedImage(
      cardGallery.getByRole("img", { name: `Photo 2 sur 3 : ${title}`, exact: true }),
      imageUrls[1],
    );
    await expect(selectCard).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => new URL(page.url()).searchParams.get("pid"))
      .toBe(`leboncoin:${selected.externalId}`);

    await selectCard.click();
    const propertiesHeading = page.getByRole("heading", { level: 2, name: title, exact: true });
    await expect(propertiesHeading).toBeVisible();
    const propertiesDetail = page.locator("aside").filter({ has: propertiesHeading });
    const propertiesGallery = propertiesDetail.getByRole("group", {
      name: `Galerie photos de ${title}`,
      exact: true,
    });
    const propertiesFirstImage = propertiesGallery.getByRole("img", {
      name: `Photo 1 sur 3 : ${title}`,
      exact: true,
    });
    await expectLoadedImage(propertiesFirstImage, imageUrls[0]);
    await propertiesGallery.getByRole("button", { name: `Photo suivante de ${title}`, exact: true }).click();
    await expectLoadedImage(
      propertiesGallery.getByRole("img", { name: `Photo 2 sur 3 : ${title}`, exact: true }),
      imageUrls[1],
    );
    await expectLoadedImage(
      cardGallery.getByRole("img", { name: `Photo 2 sur 3 : ${title}`, exact: true }),
      imageUrls[1],
    );

    await page.goto("/?view=map");
    await page.getByRole("combobox", { name: "Type de bien", exact: true }).selectOption(propertyType);
    const mapResults = page.getByRole("list", { name: "Résultats", exact: true });
    await mapResults.getByRole("button", {
      name: `Afficher le détail de ${title}`,
      exact: true,
    }).click();

    const mapDetail = page.getByRole("complementary", { name: "Détails du bien sélectionné", exact: true });
    const mapGallery = mapDetail.getByRole("group", { name: `Galerie photos de ${title}`, exact: true });
    const mapFirstImage = mapGallery.getByRole("img", { name: `Photo 1 sur 3 : ${title}`, exact: true });
    await expectLoadedImage(mapFirstImage, imageUrls[0]);
    await mapGallery.getByRole("button", { name: `Photo suivante de ${title}`, exact: true }).click();
    await expectLoadedImage(
      mapGallery.getByRole("img", { name: `Photo 2 sur 3 : ${title}`, exact: true }),
      imageUrls[1],
    );
    const previousImage = mapGallery.getByRole("button", { name: `Photo précédente de ${title}`, exact: true });
    await previousImage.click();
    await expectLoadedImage(
      mapGallery.getByRole("img", { name: `Photo 1 sur 3 : ${title}`, exact: true }),
      imageUrls[0],
    );
    await previousImage.click();
    await expectLoadedImage(
      mapGallery.getByRole("img", { name: `Photo 3 sur 3 : ${title}`, exact: true }),
      imageUrls[2],
    );
  });

  test("publishes an immutable recipe version and pins it in the default evaluation plan", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "recipe-version");
    const recipeId = `recipe-${token}`;
    const planId = `plan-${token}`;
    const initialName = `Recette initiale ${token}`;
    const publishedName = `Recette publiée ${token}`;
    const planName = `Plan exact ${token}`;
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

    await page.goto(`/?view=builder&brid=${encodeURIComponent(`${recipeId}:1`)}`);
    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: initialName, exact: true })).toBeVisible();
    await expect(page.getByText("Publiée · lecture seule", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Identifiant de recette", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Créer une version", exact: true }).click();
    await expect(page.getByLabel("Identifiant de recette", { exact: true })).toHaveValue(recipeId);
    await page.getByLabel("Nom", { exact: true }).fill(publishedName);
    const publishRecipe = page.getByRole("button", { name: "Publier la version", exact: true });
    await expect(publishRecipe).toBeEnabled();
    const recipeResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/v1/recipes/${recipeId}`
    ));
    await publishRecipe.click();
    expect((await recipeResponse).status()).toBe(201);

    await expect(page.getByRole("heading", { level: 2, name: publishedName, exact: true })).toBeVisible();
    await expect(page.getByText("v2", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Publiée · lecture seule", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    await page.getByRole("button", { name: "Nouveau plan", exact: true }).click();
    await page.getByLabel("Identifiant du plan", { exact: true }).fill(planId);
    await page.getByLabel("Nom du plan", { exact: true }).fill(planName);
    await page.getByRole("combobox", { name: "Recette en position 1", exact: true })
      .selectOption(`${recipeId}:2`);

    const publishPlan = page.getByRole("button", { name: "Publier la version", exact: true });
    await expect(publishPlan).toBeEnabled();
    const planResponse = page.waitForResponse((response) => (
      response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/v1/evaluation-plans/${planId}`
    ));
    await publishPlan.click();
    expect((await planResponse).status()).toBe(201);

    await expect(page.getByRole("heading", { level: 2, name: planName, exact: true })).toBeVisible();
    await expect(page.getByText("Plan publié", { exact: true })).toBeVisible();
    const setDefault = page.getByRole("button", { name: "Définir par défaut", exact: true });
    await expect(setDefault).toBeEnabled();
    const defaultResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/v1/evaluation-plans/${planId}/set-default`
    ));
    await setDefault.click();
    expect((await defaultResponse).status()).toBe(200);

    await expect.poll(async () => {
      const active = await getDefaultEvaluationPlan(request);
      return {
        id: active.id,
        version: active.version,
        operator: active.operator,
        recipes: active.recipes.map((reference) => ({
          id: reference.recipeId,
          version: reference.recipeVersion,
          name: reference.recipe.name,
        })),
      };
    }).toEqual({
      id: planId,
      version: 1,
      operator: "all",
      recipes: [{ id: recipeId, version: 2, name: publishedName }],
    });
  });

  test("runs a durable evaluation pipeline and exposes its honest failed step", async ({ page, request }, testInfo) => {
    const token = testToken(testInfo, "evaluation-pipeline");
    const recipeId = `scores-${token}`;
    const planId = `scores-plan-${token}`;
    const recipeName = `Évaluation réelle ${token}`;
    const planName = `Pipeline réel ${token}`;
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
    const plan = await saveEvaluationPlanVersion(request, planId, {
      name: planName,
      operator: "all",
      recipes: [{ recipeId, recipeVersion: recipe.version }],
    });
    await setDefaultEvaluationPlan(request, planId, plan.version);

    const title = `Bien à évaluer ${token}`;
    const listing = listingFixture(token, "pipeline", {
      title,
      description: "Snapshot détaillé réel sans décision pré-calculée.",
    });
    const runId = `web-scores-${token}`;
    await ingestListings(request, runId, [listing]);
    await page.goto(`/?view=scorings&spid=${encodeURIComponent(`${planId}:1`)}&srun=${encodeURIComponent(runId)}`);

    await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Plan et version", exact: true }))
      .toHaveValue(`${planId}:1`);
    await expect(page.getByRole("combobox", { name: "Run terminé", exact: true })).toHaveValue(runId);
    const launch = page.getByRole("button", { name: "Lancer l’évaluation", exact: true });
    await expect(launch).toBeEnabled();

    const creationResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/v1/runs/${runId}/evaluation-executions`
    ));
    await launch.click();
    const response = await creationResponse;
    expect(response.status()).toBe(202);
    const created = await response.json() as { id: string };
    expect(created.id).toBeTruthy();

    await expect.poll(async () => (await getEvaluationExecution(request, created.id)).status, {
      timeout: 12_000,
    }).toBe("failed");
    await expect.poll(() => new URL(page.url()).searchParams.get("seid")).toBe(created.id);

    const executionHeader = page.getByText(created.id, { exact: true }).locator("..").locator("..");
    await expect(executionHeader.getByText("Échec", { exact: true })).toBeVisible();
    const resultItem = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}`, "u") });
    await expect(resultItem).toContainText("À revoir");
    await expect(resultItem).toContainText("Non disponible");

    const aggregate = page.getByText("Décision agrégée", { exact: true }).locator("..");
    await expect(aggregate.getByText("Non disponible", { exact: true })).toBeVisible();
    await expect(aggregate.getByText(/\/ 100/u)).toHaveCount(0);
    await expect(aggregate).toContainText("TOUTES: a revoir");

    const recipeStep = page.getByText(`${recipeId}@v1`, { exact: true })
      .locator("xpath=ancestor::article[1]");
    await expect(recipeStep.getByText(recipeName, { exact: true })).toBeVisible();
    await expect(recipeStep.getByText("Échec", { exact: true })).toBeVisible();
    await expect(recipeStep).toContainText("OPENAI_NOT_CONFIGURED · provider");

    const results = await getEvaluationExecutionResults(request, created.id);
    expect(results.items).toHaveLength(1);
    expect(results.items[0]).toMatchObject({
      executionId: created.id,
      listingId: `leboncoin:${listing.externalId}`,
      planId,
      planVersion: 1,
      decision: "review",
      score: null,
      steps: [{ recipeId, recipeVersion: 1, status: "failed" }],
    });

    const retryResponse = page.waitForResponse((candidate) => (
      candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/v1/evaluation-executions/${created.id}/retry`
    ));
    await executionHeader.getByRole("button", { name: "Réessayer", exact: true }).click();
    const retriedResponse = await retryResponse;
    expect(retriedResponse.status()).toBe(202);
    const retried = await retriedResponse.json() as { id: string };
    expect(retried.id).not.toBe(created.id);
    await expect.poll(() => new URL(page.url()).searchParams.get("seid")).toBe(retried.id);
    await expect.poll(async () => (await getEvaluationExecution(request, retried.id)).status, {
      timeout: 12_000,
    }).toBe("failed");
    expect(await getEvaluationExecution(request, retried.id)).toMatchObject({
      retryOfExecutionId: created.id,
      force: false,
    });
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

async function expectLoadedImage(image: Locator, expectedSrc: string): Promise<void> {
  await expect(image).toBeVisible();
  await expect(async () => image.scrollIntoViewIfNeeded()).toPass({ timeout: 8_000 });
  await expect(image).toHaveAttribute("src", expectedSrc);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}
