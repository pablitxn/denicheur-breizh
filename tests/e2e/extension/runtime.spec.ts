import type { BrowserContext, Page, Route, TestInfo } from "@playwright/test";

import {
  ACTIVITY_BLOCK_PAGE_HTML,
  CAPTCHA_PAGE_HTML,
  clearExtensionStorage,
  DETAIL_PAGE_HTML,
  DETAIL_URL,
  EXPECTED_EXTENSION_ID,
  extensionUrl,
  HOME_URL,
  homePageHtml,
  readExtensionStorage,
  SEARCH_PAGE_HTML,
  searchPageHtml,
  SECOND_DETAIL_PAGE_HTML,
  SECOND_DETAIL_URL,
  sendContentMessage,
  test,
  type SearchListingFixture,
  expect,
} from "./fixtures.js";

const FOREIGN_SEARCH_URL = "https://www.leboncoin.fr/recherche?foreign=untouched";
const FOREIGN_DETAIL_URL = "https://www.leboncoin.fr/ad/ventes_immobilieres/3999999999";
const UNRELATED_URL = "https://fixtures.invalid/unrelated";
const API_BASE_URL = "http://127.0.0.1:14310";
const WEB_BASE_URL = "http://127.0.0.1:14173";
test.describe("Denicheur MV3 native-search runtime", () => {
  test.afterEach(async ({ context, page }, testInfo) => {
    const failed = testInfo.status !== testInfo.expectedStatus;
    // Opening the dashboard closes the action popup that may own `page`.
    const storagePage = [page, ...context.pages()].find((candidate) =>
      !candidate.isClosed() && candidate.url().startsWith(`chrome-extension://${EXPECTED_EXTENSION_ID}/`),
    );
    if (!storagePage) {
      if (failed) return;
      throw new Error("No open extension page is available to verify the final crawler snapshot.");
    }
    let run = await readStoredRun(storagePage);
    const runId = run.id;
    if (typeof runId !== "string" || runId === "idle") return;

    if (failed && !["completed", "cancelled", "failed", "blocked-activity"].includes(String(run.status))) {
      await test.step("Cancel this failed fixture's owning crawler before closing its context", async () => {
        for (const candidate of context.pages()) {
          if (candidate.isClosed() || !candidate.url().startsWith(extensionUrl(EXPECTED_EXTENSION_ID, "dashboard.html"))) continue;
          const tab = await candidate.evaluate(async () => chrome.tabs.getCurrent());
          if (typeof run.dashboardTabId === "number" && tab?.id !== run.dashboardTabId) continue;
          const cancel = candidate.getByRole("button", { name: /^(Cancel|Annuler|Cancelar)$/ });
          if (await cancel.count() !== 1 || !await cancel.isEnabled()) continue;
          await testInfo.attach("failed-run-before-cleanup", { body: await candidate.screenshot(), contentType: "image/png" });
          await cancel.click();
          break;
        }
      });
    }

    // The runner observer publishes terminal UI before awaiting storage's
    // acknowledgement; storage then triggers the background's final PUT.
    // Keep its browser context alive until the real API observes that snapshot;
    // otherwise another test inherits an active run that can no longer sync.
    // Do not force synchronization here: a broken automatic sync must fail the
    // owning runtime test instead of being repaired or hidden by its cleanup.
    await test.step("Wait for the terminal crawler snapshot in the API", async () => {
      await expect.poll(async () => {
        run = await readStoredRun(storagePage);
        return { id: run.id, status: run.status };
      }, {
        message: `Run ${runId} must acknowledge its terminal snapshot in local storage`,
        timeout: 10_000,
        intervals: [50, 100, 250],
      }).toMatchObject({ id: runId, status: expect.stringMatching(/^(completed|cancelled|failed|blocked-activity)$/) });
      await expect.poll(async () => {
        const response = await context.request.get(
          `${API_BASE_URL}/v1/runs/${encodeURIComponent(runId)}`,
        );
        if (response.status() === 404) return { status: "not-ingested" };
        expect(response.ok()).toBe(true);
        return response.json();
      }, {
        message: `Run ${runId} must persist its terminal snapshot before closing the extension`,
        timeout: 10_000,
        intervals: [100, 250, 500],
      }).toMatchObject({ id: runId, status: run.status, collected: run.collected });
    });
  });

  async function runFunctionalProductFlow({
    context,
    page,
    extensionId,
    runtimeErrors,
  }: {
    context: BrowserContext;
    page: Page;
    extensionId: string;
    runtimeErrors: string[];
  }, testInfo: TestInfo): Promise<void> {
    test.setTimeout(120_000);
    const externalId = String(3_007_199_900 + testInfo.retry);
    const listingId = `leboncoin:${externalId}`;
    const detailUrl = `https://www.leboncoin.fr/ad/ventes_immobilieres/${externalId}`;
    const title = `Maison E2E persistée à Brest r${testInfo.retry}`;
    const detailPageHtml = DETAIL_PAGE_HTML.replaceAll("Maison familiale à Brest", title);
    const recipeId = `mv3-functional-e2e-r${testInfo.retry}`;
    const recipeName = "Recette MV3 fonctionnelle";
    const planId = `mv3-functional-plan-r${testInfo.retry}`;
    const planName = "Plan MV3 fonctionnel";
    const web = await context.newPage();

    await web.goto(`${WEB_BASE_URL}/?view=builder`);
    await web.getByRole("button", { name: /^(French|Français)$/ }).click();
    await expect(web.getByRole("heading", { name: "Atelier de scoring" })).toBeVisible();
    await web.getByRole("button", { name: "Nouvelle recette" }).click();
    await web.getByLabel("Identifiant de recette", { exact: true }).fill(recipeId);
    await web.getByLabel("Nom", { exact: true }).fill(recipeName);
    await web.getByLabel("Seuil de pertinence", { exact: true }).fill("70");
    await web.getByLabel("Identifiant", { exact: true }).fill("garden");
    await web.getByLabel("Nom du critère", { exact: true }).fill("Jardin privé");
    await web.getByLabel("Poids", { exact: true }).fill("100");
    await web.getByLabel("Instruction et contexte", { exact: true }).fill(
      "Confirmer que l’annonce mentionne explicitement un jardin privé.",
    );

    const saveResponse = web.waitForResponse((response) =>
      response.request().method() === "PUT" &&
      response.url() === `${API_BASE_URL}/v1/recipes/${recipeId}`,
    );
    await web.getByRole("button", { name: "Publier la version" }).click();
    expect((await saveResponse).status()).toBe(201);
    await expect(web.getByRole("heading", { name: recipeName, exact: true })).toBeVisible();

    await web.getByRole("tab", { name: "Plans", exact: true }).click();
    await web.getByRole("button", { name: "Nouveau plan", exact: true }).click();
    await web.getByLabel("Identifiant du plan", { exact: true }).fill(planId);
    await web.getByLabel("Nom du plan", { exact: true }).fill(planName);
    await web.getByLabel("Recette en position 1", { exact: true }).selectOption(`${recipeId}:1`);
    const planSaveResponse = web.waitForResponse((response) =>
      response.request().method() === "PUT" &&
      response.url() === `${API_BASE_URL}/v1/evaluation-plans/${planId}`,
    );
    await web.getByRole("button", { name: "Publier la version" }).click();
    expect((await planSaveResponse).status()).toBe(201);
    await expect(web.getByRole("heading", { name: planName, exact: true })).toBeVisible();
    const setDefaultResponse = web.waitForResponse((response) =>
      response.request().method() === "POST" &&
      response.url() === `${API_BASE_URL}/v1/evaluation-plans/${planId}/set-default`,
    );
    await web.getByRole("button", { name: "Définir par défaut", exact: true }).click();
    expect((await setDefaultResponse).status()).toBe(200);

    const uniqueListingBeforeCapture = await context.request.get(
      `${API_BASE_URL}/v1/listings/leboncoin/${externalId}`,
    );
    expect(uniqueListingBeforeCapture.status()).toBe(404);

    await openCleanDashboard(page, extensionId);
    const intelligencePanel = page.locator("details.intelligence-panel");
    if (await intelligencePanel.getAttribute("open") === null) {
      await intelligencePanel.locator("summary").click();
    }
    const refreshPlan = page.getByRole("button", { name: "Refresh default plan" });
    await expect(refreshPlan).toBeVisible();
    await refreshPlan.click();
    await expect(page.getByText("Default plan refreshed from the API.", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const storage = await readExtensionStorage(page);
      const syncState = storage["denicheur:sync:state"] as {
        activePlan?: { status?: string; planId?: string; planVersion?: number };
        activeRecipe?: { status?: string; recipeId?: string; recipeVersion?: number };
      } | undefined;
      const plan = storage["denicheur:intelligence:plan"] as {
        id?: string;
        version?: number;
        recipes?: Array<{ recipeId?: string; recipeVersion?: number }>;
      } | undefined;
      const recipe = storage["denicheur:intelligence:recipe"] as {
        id?: string;
        version?: number;
        enabled?: boolean;
      } | undefined;
      return { activePlan: syncState?.activePlan, activeRecipe: syncState?.activeRecipe, plan, recipe };
    }).toMatchObject({
      activePlan: { status: "cached", planId, planVersion: 1 },
      activeRecipe: { status: "cached", recipeId, recipeVersion: 1 },
      plan: {
        id: planId,
        version: 1,
        recipes: [{ recipeId, recipeVersion: 1 }],
      },
      recipe: { id: recipeId, version: 1, enabled: true },
    });

    await routeNativeFlow(context, {
      searchPages: [[{ id: externalId, title }]],
    });
    await context.route(detailUrl, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: detailPageHtml }),
    );
    const ingestionRoute = `${API_BASE_URL}/v1/ingestion/runs/**`;
    const abortIngestion = async (route: Route) => {
      if (route.request().method() === "PUT") {
        await route.abort("failed");
        return;
      }
      await route.continue();
    };
    await context.route(ingestionRoute, abortIngestion);

    await configureNativeSearch(page, { details: true });
    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 60_000 });

    const capturedStorage = await readExtensionStorage(page);
    const capturedRun = capturedStorage["denicheur:crawler:run"] as { id?: string } | undefined;
    expect(capturedRun?.id).toMatch(/^run-/);
    const capturedRunId = capturedRun?.id ?? "";
    expect(capturedStorage["denicheur:crawler:records"]).toEqual([
      expect.objectContaining({
        id: externalId,
        source: "leboncoin",
        listingUrl: detailUrl,
        title,
        searchRunId: capturedRunId,
        status: "detailed",
      }),
    ]);
    await expect.poll(async () => {
      const storage = await readExtensionStorage(page);
      const syncState = storage["denicheur:sync:state"] as {
        queue?: Array<{
          runId?: string;
          attempts?: number;
          payload?: {
            run?: { status?: string };
            listings?: Array<{ externalId?: string; url?: string }>;
          };
        }>;
      } | undefined;
      return syncState?.queue?.some((entry) =>
        entry.runId === capturedRunId &&
        (entry.attempts ?? 0) > 0 &&
        entry.payload?.run?.status === "completed" &&
        entry.payload?.listings?.some((listing) =>
          listing.externalId === externalId && listing.url === detailUrl,
        ),
      ) ?? false;
    }).toBe(true);

    await context.unroute(ingestionRoute, abortIngestion);
    const popup = await context.newPage();
    await popup.goto(extensionUrl(extensionId, "popup.html"));
    await expect(popup.getByText("1 record", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Sync now" }).click();
    await expect.poll(async () => {
      const storage = await readExtensionStorage(popup);
      const syncState = storage["denicheur:sync:state"] as {
        queue?: unknown[];
        evaluationQueue?: Array<{ status?: string; planId?: string; executionId?: string }>;
      } | undefined;
      return {
        ingestion: syncState?.queue?.length,
        execution: syncState?.evaluationQueue?.find((entry) => entry.planId === planId),
      };
    }, { timeout: 20_000 }).toMatchObject({
      ingestion: 0,
      execution: {
        status: "failed",
        planId,
        executionId: expect.any(String),
      },
    });
    await expect(popup.getByText("Collected data synced", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const storage = await readExtensionStorage(popup);
      const records = storage["denicheur:crawler:records"] as Array<{
        id?: string;
        evaluation?: unknown;
        planEvaluation?: {
          planId?: string;
          decision?: string;
          steps?: Array<{ status?: string }>;
        };
      }> | undefined;
      return records?.find((record) => record.id === externalId);
    }).toMatchObject({
      id: externalId,
      planEvaluation: {
        planId,
        decision: "review",
        steps: [{ status: "failed" }],
      },
    });

    const firstApiDetail = await context.request.get(
      `${API_BASE_URL}/v1/listings/leboncoin/${externalId}`,
    );
    expect(firstApiDetail.ok()).toBe(true);
    expect(await firstApiDetail.json()).toMatchObject({
      id: listingId,
      externalId,
      url: detailUrl,
      title,
      lastRunId: capturedRunId,
    });
    const runListingsUrl = `${API_BASE_URL}/v1/listings?runId=${encodeURIComponent(capturedRunId)}&limit=100`;
    const firstApiListings = await context.request.get(runListingsUrl);
    expect(firstApiListings.ok()).toBe(true);
    const firstApiPayload = await firstApiListings.json() as {
      total: number;
      items: Array<{
        id: string;
        externalId: string;
        url: string;
        title?: string;
        lastRunId: string;
      }>;
    };
    expect(firstApiPayload.total).toBe(1);
    expect(firstApiPayload.items).toEqual([
      expect.objectContaining({
        id: listingId,
        externalId,
        url: detailUrl,
        title,
        lastRunId: capturedRunId,
      }),
    ]);

    const executionsResponse = await context.request.get(
      `${API_BASE_URL}/v1/evaluation-executions?runId=${encodeURIComponent(capturedRunId)}&limit=20`,
    );
    expect(executionsResponse.ok()).toBe(true);
    expect(await executionsResponse.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        runId: capturedRunId,
        planId,
        planVersion: 1,
        status: "failed",
      })],
    });

    await popup.evaluate(() => {
      const root = document.documentElement;
      root.dataset.sawSyncing = "false";
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes("Syncing…")) {
          root.dataset.sawSyncing = "true";
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const repeatSyncButton = popup.getByRole("button", { name: "Sync now" });
    await repeatSyncButton.click();
    await expect.poll(() => popup.locator("html").getAttribute("data-saw-syncing")).toBe("true");
    await expect(repeatSyncButton).toBeEnabled();

    const repeatedApiListings = await context.request.get(runListingsUrl);
    expect(repeatedApiListings.ok()).toBe(true);
    const repeatedApiPayload = await repeatedApiListings.json() as {
      total: number;
      items: Array<{ id: string; url: string }>;
    };
    expect(repeatedApiPayload.total).toBe(1);
    expect(repeatedApiPayload.items).toEqual([
      expect.objectContaining({ id: listingId, url: detailUrl }),
    ]);

    await web.goto(`${WEB_BASE_URL}/?view=properties`);
    await expect(web.getByRole("heading", { name: "Biens", exact: true })).toBeVisible();
    await expect(web.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(web.getByRole("link", { name: "Ouvrir l’annonce source" })).toHaveAttribute(
      "href",
      detailUrl,
    );
    await expect(
      web.getByText("Identifiant source", { exact: true }).locator("..").getByText(externalId, { exact: true }),
    ).toBeVisible();
    await expect(
      web.getByText("Run de collecte", { exact: true }).locator("..").getByText(capturedRunId, { exact: true }),
    ).toBeVisible();

    // The first dashboard hydration intentionally observes the API's no-default
    // 404 before this test publishes its plan. Chromium reports that expected
    // response as a console resource error, so account for it explicitly.
    expect(runtimeErrors).toEqual([
      expect.stringContaining("server responded with a status of 404"),
    ]);
    runtimeErrors.splice(0, runtimeErrors.length);
  }

  test("cleans coordinated iteration data from the npm hook while preserving extension configuration", async ({
    context,
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    const storedFilters = {
      source: "leboncoin",
      category: "9",
      text: "",
      locationQuery: "Finistère",
      propertyTypes: ["1"],
      ownerType: "all",
      priceMax: 120000,
      roomsMin: 2,
      roomsMax: 3,
      sort: "time",
      order: "desc",
      maxListings: 1,
      collectDetailPages: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
      pauseAfterDetails: 5,
      cooldownSeconds: 180,
    };
    const storedRecipe = {
      id: "iteration-recipe",
      version: 4,
      name: "Iteration recipe",
      threshold: 70,
      enabled: false,
      criteria: [],
    };

    let releaseIngestion!: () => void;
    const ingestionRelease = new Promise<void>((resolve) => {
      releaseIngestion = resolve;
    });
    let markIngestionStarted!: () => void;
    const ingestionStarted = new Promise<void>((resolve) => {
      markIngestionStarted = resolve;
    });
    let markIngestionFinished!: () => void;
    const ingestionFinished = new Promise<void>((resolve) => {
      markIngestionFinished = resolve;
    });
    let ingestionStatus = 0;
    let ingestionPayload: unknown;
    await context.route(`${API_BASE_URL}/v1/ingestion/runs/previous-run`, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }

      ingestionPayload = route.request().postDataJSON();
      markIngestionStarted();
      await ingestionRelease;
      const response = await route.fetch();
      ingestionStatus = response.status();
      await route.fulfill({ response });
      markIngestionFinished();
    });

    let releaseMaintenance!: () => void;
    const maintenanceRelease = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    let markMaintenanceStarted!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    let markMaintenanceFinished!: () => void;
    const maintenanceFinished = new Promise<void>((resolve) => {
      markMaintenanceFinished = resolve;
    });
    let maintenanceStatus = 0;
    let maintenanceMethod = "";
    let maintenanceOrigin = "";
    let maintenanceBody = "";
    await context.route(`${API_BASE_URL}/v1/maintenance/collected-data/clear`, async (route) => {
      maintenanceMethod = route.request().method();
      maintenanceOrigin = route.request().headers().origin ?? "";
      maintenanceBody = route.request().postData() ?? "";
      markMaintenanceStarted();
      await maintenanceRelease;
      const response = await route.fetch();
      maintenanceStatus = response.status();
      await route.fulfill({ response });
      markMaintenanceFinished();
    });

    let callbackOrigin = "";
    let callbackRequestUrl = "";
    await context.route("http://127.0.0.1:15432/extension-db-cleaned**", async (route) => {
      callbackOrigin = route.request().headers().origin ?? "";
      callbackRequestUrl = route.request().url();
      await route.fulfill({
        status: 204,
        headers: { "Access-Control-Allow-Origin": `chrome-extension://${extensionId}` },
        body: "",
      });
    });

    await page.evaluate(async ({ detailUrl, filters, recipe }) => {
      await chrome.storage.local.set({
        "denicheur:locale": "es",
        "denicheur:crawler:filters": filters,
        "denicheur:intelligence:recipe": recipe,
        "denicheur:sync:state": {
          version: 2,
          status: "pending",
          queue: [{
            key: "previous-run:batch:1",
            runId: "previous-run",
            fingerprint: "previous-run-fixture-fingerprint",
            payload: {
              run: {
                id: "previous-run",
                source: "leboncoin",
                status: "completed",
                startedAt: "2026-07-18T09:00:00.000Z",
                finishedAt: "2026-07-18T10:00:00.000Z",
                target: 1,
                found: 1,
                pagesVisited: 1,
                collected: 1,
              },
              listings: [{
                source: "leboncoin",
                externalId: "3007106066",
                url: detailUrl,
                title: "Previous iteration",
                features: [],
                status: "detailed",
                scrapedAt: "2026-07-18T10:00:00.000Z",
                rawTextSample: "Previous iteration",
              }],
            },
            attempts: 1,
            nextAttemptAt: 0,
            createdAt: "2026-07-18T10:00:00.000Z",
            updatedAt: "2026-07-18T10:00:00.000Z",
            lastError: "Previous API attempt failed",
          }],
          syncedFingerprints: { "previous-run:batch:1": "stale-fingerprint" },
          activePlan: { status: "none" },
          evaluationQueue: [],
          activeRecipe: {
            status: "cached",
            recipeId: recipe.id,
            recipeVersion: recipe.version,
          },
        },
        "denicheur:crawler:run": {
          id: "previous-run",
          status: "completed",
          target: 1,
          found: 1,
          pagesVisited: 1,
          collected: 1,
          evaluated: 0,
          relevant: 0,
          notRelevant: 0,
          review: 0,
          filterWarnings: [],
          intelligenceStatus: "idle",
        },
        "denicheur:crawler:records": [{
          id: "3007106066",
          source: "leboncoin",
          listingUrl: detailUrl,
          title: "Previous iteration",
          features: [],
          scrapedAt: "2026-07-18T10:00:00.000Z",
          searchRunId: "previous-run",
          status: "detailed",
          rawTextSample: "Previous iteration",
        }],
      });
      await chrome.storage.sync.set({ "denicheur:theme": "dark" });
    }, { detailUrl: DETAIL_URL, filters: storedFilters, recipe: storedRecipe });

    await ingestionStarted;
    const pendingStorage = await readExtensionStorage(page);
    expect(pendingStorage["denicheur:sync:state"]).toEqual(expect.objectContaining({
      status: "syncing",
      queue: [expect.objectContaining({
        key: "previous-run:batch:1",
        runId: "previous-run",
        payload: expect.objectContaining({
          run: expect.objectContaining({ id: "previous-run", status: "completed" }),
          listings: [expect.objectContaining({ externalId: "3007106066", url: DETAIL_URL })],
        }),
      })],
    }));
    expect(ingestionPayload).toEqual(expect.objectContaining({
      run: expect.objectContaining({ id: "previous-run", status: "completed" }),
      listings: [expect.objectContaining({ externalId: "3007106066", url: DETAIL_URL })],
    }));

    const callbackUrl = "http://127.0.0.1:15432/extension-db-cleaned?token=e2e";
    await page.goto(
      `${extensionUrl(extensionId, "dashboard.html")}?action=clean-all-data&callback=${encodeURIComponent(callbackUrl)}`,
    );

    await expect(page).toHaveURL(extensionUrl(extensionId, "dashboard.html"));
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(maintenanceMethod).toBe("");
    expect(callbackRequestUrl).toBe("");

    releaseIngestion();
    await ingestionFinished;
    expect(ingestionStatus).toBe(200);
    await maintenanceStarted;
    expect(maintenanceMethod).toBe("POST");
    expect(maintenanceOrigin).toBe(`chrome-extension://${extensionId}`);
    expect(JSON.parse(maintenanceBody)).toEqual({
      confirm: "clear-collected-data",
      runnerLease: "held",
    });
    expect(callbackRequestUrl).toBe("");

    const seededApiListing = await context.request.get(
      `${API_BASE_URL}/v1/listings/leboncoin/3007106066`,
    );
    expect(seededApiListing.status()).toBe(200);

    const competingDashboard = await context.newPage();
    await competingDashboard.goto(extensionUrl(extensionId, "dashboard.html"));
    const competingStart = competingDashboard.getByRole("button", {
      name: "Iniciar recopilación",
      exact: true,
    });
    await expect(competingStart).toBeEnabled();
    const pagesBeforeCompetingStart = context.pages().map((candidate) => candidate.url());

    await competingStart.click();

    await expect(competingDashboard.getByText(
      "Otro panel ya controla la recopilación.",
      { exact: true },
    )).toBeVisible();
    await expect(competingStart).toBeEnabled();
    await expect(competingDashboard).toHaveURL(extensionUrl(extensionId, "dashboard.html"));
    expect(context.pages().map((candidate) => candidate.url())).toEqual(pagesBeforeCompetingStart);
    expect(context.pages().some((candidate) => candidate.url().startsWith("https://www.leboncoin.fr/"))).toBe(false);
    const competingStorage = await readExtensionStorage(competingDashboard);
    expect(competingStorage["denicheur:crawler:records"]).toEqual([]);
    expect(competingStorage["denicheur:crawler:run"]).toEqual(expect.objectContaining({
      id: "idle",
      status: "idle",
      found: 0,
      collected: 0,
    }));

    releaseMaintenance();
    await maintenanceFinished;
    expect(maintenanceStatus).toBe(200);
    await expect(page.getByText(
      "No hay anuncios guardados. Configura la búsqueda e inicia una recopilación.",
      { exact: true },
    )).toBeVisible();
    await expect.poll(() => callbackRequestUrl).toContain("status=ok");
    expect(callbackOrigin).toBe(`chrome-extension://${extensionId}`);

    const storage = await readExtensionStorage(page);
    expect(storage["denicheur:crawler:records"]).toEqual([]);
    expect(storage["denicheur:crawler:run"]).toEqual(expect.objectContaining({
      id: "idle",
      status: "idle",
      found: 0,
      collected: 0,
    }));
    expect(storage["denicheur:sync:state"]).toEqual(expect.objectContaining({
      version: 2,
      status: "idle",
      queue: [],
      syncedFingerprints: {},
      evaluationQueue: [],
      activeRecipe: expect.objectContaining({
        status: "cached",
        recipeId: storedRecipe.id,
        recipeVersion: storedRecipe.version,
      }),
    }));
    expect(storage["denicheur:crawler:filters"]).toEqual(storedFilters);
    expect(storage["denicheur:intelligence:recipe"]).toEqual(storedRecipe);
    expect(storage["denicheur:locale"]).toBe("es");
    await expect.poll(() => page.evaluate(async () =>
      (await chrome.storage.sync.get("denicheur:theme"))["denicheur:theme"]
    )).toBe("dark");

    const apiListings = await context.request.get(`${API_BASE_URL}/v1/listings?limit=100`);
    const apiRuns = await context.request.get(`${API_BASE_URL}/v1/runs?limit=100`);
    expect(apiListings.status()).toBe(200);
    expect(await apiListings.json()).toMatchObject({ items: [], nextCursor: null, total: 0 });
    expect(apiRuns.status()).toBe(200);
    expect(await apiRuns.json()).toMatchObject({ items: [], nextCursor: null, total: 0 });
  });

  test("loads the pinned minimal manifest and exposes valid native dashboard controls", async ({
    page,
    context,
    extensionId,
    runtimeErrors,
  }) => {
    await page.goto(extensionUrl(extensionId, "popup.html"));
    await clearExtensionStorage(page);
    await page.reload();

    await expect(page.getByRole("heading", { name: "Denicheur Breizh", exact: true })).toBeVisible();
    await expect(page.getByText("0 records", { exact: true })).toBeVisible();
    await expect(page.getByText("ready", { exact: true })).toBeVisible();

    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    expect(extensionId).toBe(EXPECTED_EXTENSION_ID);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "alarms"]);
    expect(manifest.permissions).not.toEqual(expect.arrayContaining(["tabs", "scripting", "debugger"]));
    expect(manifest.content_scripts?.[0]?.matches).toEqual(
      expect.arrayContaining(["https://www.leboncoin.fr/", "https://www.leboncoin.fr/recherche*"]),
    );
    expect(context.serviceWorkers()).toHaveLength(1);

    const dashboardPromise = context.waitForEvent("page");
    await page.getByRole("button", { name: "Open dashboard" }).click();
    const dashboard = await dashboardPromise;
    await expect(dashboard).toHaveURL(extensionUrl(extensionId, "dashboard.html"));
    await expect(dashboard.getByRole("heading", { name: "Search filters" })).toBeVisible();
    await expect(dashboard.getByRole("textbox", { name: "Location", exact: true })).toBeVisible();
    await dashboard.locator("details.advanced-panel > summary").click();
    await expect(dashboard.getByRole("checkbox", { name: "Collect detail pages" })).toBeVisible();
    await expect(dashboard.getByLabel("Source URL")).toHaveCount(0);
    await expect(dashboard.getByRole("button", { name: "Start collection" })).toBeEnabled();

    await dashboard.getByLabel("Price min").fill("200000");
    const priceMax = dashboard.getByLabel("Price max");
    await priceMax.fill("120000");
    await expect(priceMax).toHaveAttribute("aria-invalid", "true");
    await expect(dashboard.getByText(
      "The price maximum must be greater than or equal to its minimum.",
      { exact: true },
    )).toBeVisible();
    const start = dashboard.getByRole("button", { name: "Start collection" });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(priceMax).toBeFocused();
    await expect(dashboard.getByText(
      "Fix the invalid search filters before starting collection.",
      { exact: true },
    )).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });

  test("keeps the real content-script extractor contract on synthetic search and detail fixtures", async ({
    context,
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await context.route("https://www.leboncoin.fr/recherche**", (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: SEARCH_PAGE_HTML }),
    );
    await context.route(DETAIL_URL, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: DETAIL_PAGE_HTML }),
    );

    const searchPage = await context.newPage();
    await searchPage.goto("https://www.leboncoin.fr/recherche?fixture=extractor");
    await expect
      .poll(() => sendContentMessage(page, "https://www.leboncoin.fr/recherche*", {
        type: "LBC_COLLECT_SEARCH_RESULTS",
        limit: 1,
      }))
      .toMatchObject({
        type: "LBC_SEARCH_RESULTS",
        captcha: false,
        ready: true,
        listings: [{
          id: "3007106066",
          title: "Maison familiale à Brest",
          priceEuros: 110_000,
          rooms: 3,
          surfaceM2: 82,
        }],
      });

    const detailPage = await context.newPage();
    await detailPage.goto(DETAIL_URL);
    await expect
      .poll(() => sendContentMessage(page, DETAIL_URL, { type: "LBC_COLLECT_DETAIL" }))
      .toMatchObject({
        type: "LBC_DETAIL",
        captcha: false,
        ready: true,
        detail: {
          id: "3007106066",
          bedrooms: 2,
          landSurfaceM2: 540,
          energyClass: "C",
          gesClass: "D",
        },
      });
  });

  test("runs dashboard through the editable launcher without treating its controlled listbox as the composer", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const tracker = await routeNativeFlow(context);
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { keywords: "maison avec vue mer" });
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.sawPausedCaptcha = String(document.body.innerText.includes("CAPTCHA pending"));
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes("CAPTCHA pending")) {
          root.dataset.sawPausedCaptcha = "true";
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    expect(context.pages().some((candidate) => candidate.url().startsWith("https://www.leboncoin.fr/"))).toBe(false);
    const pageCountBeforeRun = context.pages().length;

    const start = page.getByRole("button", { name: "Start collection", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();

    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByText(
      "Collected 1 listing summary across one page. Detail tabs were skipped.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("heading", { name: "Maison familiale à Brest" })).toBeVisible();
    const stored = await readStoredRecords(page);
    expect(stored).toEqual([
      expect.objectContaining({ id: "3007106066", status: "listing", listingUrl: DETAIL_URL }),
    ]);

    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(5);
    expect(tracker.detailRequests).toEqual([]);
    const submittedSearchUrl = new URL(tracker.searchRequestUrls[0] ?? "about:blank");
    expect(submittedSearchUrl.searchParams.get("category")).toBe("9");
    expect(submittedSearchUrl.searchParams.get("location")).toBe("Finistère (29)");
    const searchPage = context.pages().find((candidate) => candidate.url().includes("/recherche?"));
    expect(searchPage).toBeDefined();
    const observedSearchUrl = new URL(searchPage?.url() ?? "about:blank");
    expect(observedSearchUrl.searchParams.get("fixture")).toBe("native-search");
    expect(observedSearchUrl.searchParams.get("category")).toBe("9");
    expect(observedSearchUrl.searchParams.get("text")).toBe("maison avec vue mer");
    expect(observedSearchUrl.searchParams.get("location")).toBe("Finistère (29)");
    expect(observedSearchUrl.searchParams.getAll("real_estate_type")).toEqual(["1"]);
    expect(observedSearchUrl.searchParams.get("rooms")).toBe("2-3");
    expect(observedSearchUrl.searchParams.get("filters")).toBe("applied");
    const fixtureJournal = parseFixtureCookies(await searchPage?.evaluate(() => document.cookie) ?? "");
    expect(fixtureJournal).toMatchObject({
      fixture_cookie_accepted: "1",
      fixture_recent_search_opens: "1",
      fixture_home_keyword: "maison avec vue mer",
      fixture_home_submissions: "1",
      fixture_home_category_menu_opens: "1",
      fixture_home_category_group_opens: "1",
      fixture_home_category_selections: "1",
      fixture_home_category: "9",
      fixture_home_submitted_category: "9",
      fixture_home_location_query: "Finistère",
      fixture_home_location_selections: "1",
      fixture_home_location: "Finistère (29)",
      fixture_home_submitted_location: "Finistère (29)",
      fixture_filter_panel_opens: "5",
      fixture_property_type_opens: "1",
      fixture_property_type_validations: "1",
      fixture_room_selections: "2",
      fixture_filter_applications: "1",
      fixture_filter_panel_closes: "1",
      fixture_filter_property_types: "1",
      fixture_filter_price_max: "120000",
      fixture_filter_rooms_min: "2",
      fixture_filter_rooms_max: "3",
    });
    expectHomeFiltersBeforeSingleSubmit(fixtureJournal);
    expect(fixtureJournal).not.toHaveProperty("fixture_location_selections");
    expect(fixtureJournal).not.toHaveProperty("fixture_category_selections");
    expect(fixtureJournal).not.toHaveProperty("fixture_recent_search_selections");
    expect(fixtureJournal).not.toHaveProperty("fixture_bedroom_selections");
    expect(await page.locator("html").getAttribute("data-saw-paused-captcha")).toBe("false");
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    expect(context.pages()).toHaveLength(pageCountBeforeRun + 1);
    await expect.poll(() => activeTabUrl(page)).toBe(extensionUrl(extensionId, "dashboard.html"));

    const run = await readStoredRun(page);
    expect(run).toMatchObject({
      status: "completed",
      searchUrl: expect.stringContaining("/recherche?fixture=native-search"),
      found: 1,
      collected: 1,
    });
  });

  test("completes the exact one-listing smoke contract without touching foreign tabs", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const tracker = await routeNativeFlow(context, { listingCount: 2 });
    await context.route(/^https:\/\/www\.leboncoin\.fr\/recherche\?foreign=untouched$/u, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("foreign-search") }),
    );
    await context.route(FOREIGN_DETAIL_URL, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("foreign-detail") }),
    );
    await context.route(UNRELATED_URL, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("unrelated") }),
    );

    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, {
      maxListings: 1,
      details: true,
      minDelaySeconds: 25,
      maxDelaySeconds: 55,
    });

    const foreignSearch = await context.newPage();
    await foreignSearch.goto(FOREIGN_SEARCH_URL);
    const foreignDetail = await context.newPage();
    await foreignDetail.goto(FOREIGN_DETAIL_URL);
    const unrelated = await context.newPage();
    await unrelated.goto(UNRELATED_URL);
    await page.bringToFront();
    await installTabFocusJournal(page);

    await expect(page.getByLabel("Transaction")).toHaveValue("9");
    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue("Finistère");
    await expect(page.getByRole("button", { name: "House", exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const type of ["Flat", "Land", "Parking", "Other"]) {
      await expect(page.getByRole("button", { name: type, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    await expect(page.getByLabel("Price max")).toHaveValue("120000");
    await expect(page.getByLabel("Rooms min")).toHaveValue("2");
    await expect(page.getByLabel("Rooms max")).toHaveValue("3");
    await expect(page.getByLabel("Max listings")).toHaveValue("1");
    await expect(page.getByRole("checkbox", { name: "Collect detail pages" })).toBeChecked();
    await expect(page.getByLabel("Delay min sec")).toHaveValue("25");
    await expect(page.getByLabel("Delay max sec")).toHaveValue("55");
    await page.locator("details.intelligence-panel > summary").click();
    await expect(page.getByText("disabled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh default plan" })).toBeVisible();

    const dashboardTab = await page.evaluate(async () => chrome.tabs.getCurrent());
    expect(dashboardTab?.windowId).toBeDefined();
    const pageCountBeforeRun = context.pages().length;
    expect(tracker.searchRequests).toBe(0);
    expect(tracker.detailRequests).toEqual([]);

    const start = page.getByRole("button", { name: "Start collection", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();

    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByText("Collected 1 detailed listing.", { exact: true })).toBeVisible();
    await expectMetricValue(page, "Found", 1);
    await expectMetricValue(page, "Detailed", 1);
    await expectMetricValue(page, "Stored", 1);
    await expect(page.getByRole("heading", { name: "Maison familiale à Brest" })).toBeVisible();

    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(5);
    expect(tracker.detailRequests).toEqual([DETAIL_URL]);
    expect(tracker.maxOpenDetailPages).toBe(1);
    expect(context.pages().filter((candidate) => candidate.url() === DETAIL_URL)).toHaveLength(0);

    const ownedSearchPages = context.pages().filter((candidate) =>
      candidate.url().includes("/recherche?") && candidate.url().includes("fixture=native-search")
    );
    expect(ownedSearchPages).toHaveLength(1);
    const observedSearchUrl = ownedSearchPages[0].url();
    expect(new URL(observedSearchUrl).searchParams.get("category")).toBe("9");
    expect(new URL(observedSearchUrl).searchParams.get("location")).toBe("Finistère (29)");
    expect(new URL(observedSearchUrl).searchParams.getAll("real_estate_type")).toEqual(["1"]);
    expect(new URL(observedSearchUrl).searchParams.get("rooms")).toBe("2-3");
    expect(context.pages()).toHaveLength(pageCountBeforeRun + 1);

    expect(foreignSearch.url()).toBe(FOREIGN_SEARCH_URL);
    expect(await foreignSearch.evaluate(() => document.body.dataset.foreignMarker)).toBe("foreign-search");
    expect(foreignDetail.url()).toBe(FOREIGN_DETAIL_URL);
    expect(await foreignDetail.evaluate(() => document.body.dataset.foreignMarker)).toBe("foreign-detail");
    expect(unrelated.url()).toBe(UNRELATED_URL);
    expect(await unrelated.evaluate(() => document.body.dataset.foreignMarker)).toBe("unrelated");

    const run = await readStoredRun(page);
    expect(run).toMatchObject({
      status: "completed",
      searchUrl: observedSearchUrl,
      found: 1,
      collected: 1,
      filterWarnings: [],
    });
    expect(run.searchUrl).toBe(observedSearchUrl);
    expect(run.filterWarnings).toEqual([]);

    const records = await readStoredRecords(page);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "3007106066",
      source: "leboncoin",
      listingUrl: DETAIL_URL,
      title: "Maison familiale à Brest",
      priceEuros: 110_000,
      propertyType: "Maison",
      rooms: 3,
      bedrooms: 2,
      surfaceM2: 82,
      landSurfaceM2: 540,
      location: expect.stringContaining("Brest 29200"),
      energyClass: "C",
      gesClass: "D",
      status: "detailed",
    });
    expect(records[0].evaluation).toBeUndefined();
    expect(records[0].planEvaluation).toBeUndefined();

    const fixtureJournal = parseFixtureCookies(await ownedSearchPages[0].evaluate(() => document.cookie));
    expect(fixtureJournal).toMatchObject({
      fixture_home_category_selections: "1",
      fixture_home_category: "9",
      fixture_home_location_query: "Finistère",
      fixture_home_location_selections: "1",
      fixture_home_location: "Finistère (29)",
      fixture_home_submitted_category: "9",
      fixture_home_submitted_location: "Finistère (29)",
      fixture_filter_panel_opens: "5",
      fixture_home_submissions: "1",
      fixture_property_type_opens: "1",
      fixture_property_type_validations: "1",
      fixture_room_selections: "2",
      fixture_filter_applications: "1",
      fixture_filter_property_types: "1",
      fixture_filter_price_max: "120000",
      fixture_filter_rooms_min: "2",
      fixture_filter_rooms_max: "3",
    });
    expectHomeFiltersBeforeSingleSubmit(fixtureJournal);
    expect(fixtureJournal).not.toHaveProperty("fixture_location_selections");
    expect(fixtureJournal).not.toHaveProperty("fixture_category_selections");

    await expect.poll(() => activeTabUrl(page)).toBe(extensionUrl(extensionId, "dashboard.html"));
    const focusJournal = await readTabFocusJournal(page);
    for (const expectedUrl of [HOME_URL, observedSearchUrl, DETAIL_URL]) {
      expect(focusJournal.some((entry) => entry.url === expectedUrl)).toBe(true);
    }
    expect(focusJournal.some((entry) =>
      entry.url === FOREIGN_SEARCH_URL || entry.url === FOREIGN_DETAIL_URL || entry.url === UNRELATED_URL
    )).toBe(false);
    expect(focusJournal.filter((entry) =>
      [HOME_URL, observedSearchUrl, DETAIL_URL].includes(entry.url)
    ).every((entry) => entry.windowId === dashboardTab?.windowId)).toBe(true);
  });

  test("completes the same native flow after an SPA-style home navigation", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const tracker = await routeNativeFlow(context, { spaNavigation: true });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { keywords: "maison bretonne" });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });

    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(4);
    const searchPage = context.pages().find((candidate) => candidate.url().includes("/recherche?"));
    expect(searchPage).toBeDefined();
    const observedSearchUrl = new URL(searchPage?.url() ?? "about:blank");
    expect(observedSearchUrl.searchParams.get("category")).toBe("9");
    expect(observedSearchUrl.searchParams.get("text")).toBe("maison bretonne");
    expect(observedSearchUrl.searchParams.get("location")).toBe("Finistère (29)");
    expect(observedSearchUrl.searchParams.getAll("real_estate_type")).toEqual(["1"]);
    expect(observedSearchUrl.searchParams.get("rooms")).toBe("2-3");
    expect(observedSearchUrl.searchParams.get("filters")).toBe("applied");
    expect(parseFixtureCookies(await searchPage?.evaluate(() => document.cookie) ?? "")).toMatchObject({
      fixture_home_category_selections: "1",
      fixture_home_category: "9",
      fixture_home_location_selections: "1",
      fixture_home_location: "Finistère (29)",
      fixture_home_submitted_category: "9",
      fixture_home_submitted_location: "Finistère (29)",
      fixture_filter_panel_opens: "5",
      fixture_home_submissions: "1",
      fixture_property_type_opens: "1",
      fixture_property_type_validations: "1",
      fixture_room_selections: "2",
      fixture_filter_applications: "1",
      fixture_filter_property_types: "1",
      fixture_filter_price_max: "120000",
      fixture_filter_rooms_min: "2",
      fixture_filter_rooms_max: "3",
    });
  });

  test("collects 70 unique listings across three native result pages without touching foreign tabs", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(90_000);
    const searchPages = [
      fixtureListings(3_007_106_001, 30),
      fixtureListings(3_007_106_031, 35),
      [
        ...fixtureListings(3_007_106_001, 10),
        ...fixtureListings(3_007_106_066, 5),
      ],
    ];
    const tracker = await routeNativeFlow(context, { searchPages });
    await context.route(/^https:\/\/www\.leboncoin\.fr\/recherche\?foreign=untouched$/u, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("foreign-search") }),
    );
    await context.route(FOREIGN_DETAIL_URL, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("foreign-detail") }),
    );
    await context.route(UNRELATED_URL, (route) =>
      route.fulfill({ status: 200, headers: htmlHeaders(), body: foreignMarkerPageHtml("unrelated") }),
    );

    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { maxListings: 70 });
    await expect(page.getByLabel("Max listings")).toHaveValue("70");
    await expect(page.getByRole("checkbox", { name: "Collect detail pages" })).not.toBeChecked();

    const foreignSearch = await context.newPage();
    await foreignSearch.goto(FOREIGN_SEARCH_URL);
    const foreignDetail = await context.newPage();
    await foreignDetail.goto(FOREIGN_DETAIL_URL);
    const unrelated = await context.newPage();
    await unrelated.goto(UNRELATED_URL);
    await page.bringToFront();
    await installTabFocusJournal(page);

    const dashboardTab = await page.evaluate(async () => chrome.tabs.getCurrent());
    const pageCountBeforeRun = context.pages().length;
    const start = page.getByRole("button", { name: "Start collection", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();

    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 85_000 });
    await expect(page.getByText(
      "Collected 70 listing summaries across 3 pages. Detail tabs were skipped.",
      { exact: true },
    )).toBeVisible();
    await expectMetricValue(page, "Found", 70);
    await expectMetricValue(page, "Pages", 3);
    await expectMetricValue(page, "Collected", 70);

    expect(tracker.searchRequests).toBe(7);
    expect(tracker.detailRequests).toEqual([]);
    expect(tracker.maxOpenDetailPages).toBe(0);
    const paginationRequests = tracker.searchRequestUrls.filter((url) =>
      new URL(url).searchParams.has("page")
    );
    expect(paginationRequests.map((url) => new URL(url).searchParams.get("page"))).toEqual(["2", "3"]);

    const ownedSearchPages = context.pages().filter((candidate) =>
      candidate.url().includes("/recherche?") && candidate.url().includes("fixture=native-search")
    );
    expect(ownedSearchPages).toHaveLength(1);
    await expect(ownedSearchPages[0]).toHaveURL(/(?:\?|&)page=3(?:&|$)/u);
    expect(context.pages()).toHaveLength(pageCountBeforeRun + 1);
    expect(context.pages().filter((candidate) => isDetailUrl(candidate.url()))).toHaveLength(0);

    const fixtureJournal = parseFixtureCookies(await ownedSearchPages[0].evaluate(() => document.cookie));
    expect(fixtureJournal).toMatchObject({
      fixture_home_submissions: "1",
      fixture_pagination_next_clicks: "2",
      fixture_pagination_next_pages: "2|3",
    });
    expectHomeFiltersBeforeSingleSubmit(fixtureJournal);

    const run = await readStoredRun(page);
    expect(run).toMatchObject({
      status: "completed",
      target: 70,
      found: 70,
      pagesVisited: 3,
      collected: 70,
    });
    const initialObservedUrl = String(run.searchUrl ?? "");
    expect(initialObservedUrl).not.toBe("");
    const initialObservedSearch = new URL(initialObservedUrl);
    expect(initialObservedSearch.pathname).toBe("/recherche");
    expect(initialObservedSearch.searchParams.get("page")).toBeNull();
    expect(initialObservedSearch.searchParams.get("category")).toBe("9");
    expect(initialObservedSearch.searchParams.get("location")).toBe("Finistère (29)");
    expect(initialObservedSearch.searchParams.getAll("real_estate_type")).toEqual(["1"]);
    const lastUnpaginatedRequest = [...tracker.searchRequestUrls]
      .reverse()
      .find((url) => !new URL(url).searchParams.has("page"));
    expect(initialObservedUrl).toBe(lastUnpaginatedRequest);

    const records = await readStoredRecords(page);
    expect(records).toHaveLength(70);
    expect(new Set(records.map((record) => record.id)).size).toBe(70);
    expect(records.filter((record) => record.id === "3007106001")).toHaveLength(1);
    expect(records.filter((record) => record.id === "3007106070")).toHaveLength(1);

    expect(foreignSearch.url()).toBe(FOREIGN_SEARCH_URL);
    expect(await foreignSearch.evaluate(() => document.body.dataset.foreignMarker)).toBe("foreign-search");
    expect(foreignDetail.url()).toBe(FOREIGN_DETAIL_URL);
    expect(await foreignDetail.evaluate(() => document.body.dataset.foreignMarker)).toBe("foreign-detail");
    expect(unrelated.url()).toBe(UNRELATED_URL);
    expect(await unrelated.evaluate(() => document.body.dataset.foreignMarker)).toBe("unrelated");
    await expect.poll(() => activeTabUrl(page)).toBe(extensionUrl(extensionId, "dashboard.html"));
    const focusJournal = await readTabFocusJournal(page);
    expect(focusJournal.some((entry) =>
      entry.url === FOREIGN_SEARCH_URL || entry.url === FOREIGN_DETAIL_URL || entry.url === UNRELATED_URL
    )).toBe(false);
    expect(focusJournal.filter((entry) => entry.url.includes("www.leboncoin.fr/recherche"))
      .every((entry) => entry.windowId === dashboardTab?.windowId)).toBe(true);
  });

  test("completes a native search with zero results without opening detail tabs", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const tracker = await routeNativeFlow(context, { listingCount: 0 });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { details: true });

    const start = page.getByRole("button", { name: "Start collection", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();

    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByText("Collected 0 detailed listings.", { exact: true })).toBeVisible();
    await expectMetricValue(page, "Found", 0);
    await expectMetricValue(page, "Detailed", 0);
    await expectMetricValue(page, "Stored", 0);

    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(5);
    expect(tracker.detailRequests).toEqual([]);
    expect(tracker.maxOpenDetailPages).toBe(0);
    expect(context.pages().filter((candidate) => isDetailUrl(candidate.url()))).toHaveLength(0);

    const searchPage = context.pages().find((candidate) =>
      candidate.url().includes("/recherche?") && candidate.url().includes("fixture=native-search")
    );
    expect(searchPage).toBeDefined();
    await expect(searchPage!.getByRole("status", { name: "Résultats de recherche" })).toContainText(
      "Aucune annonce",
    );

    expect(await readStoredRecords(page)).toEqual([]);
    expect(await readStoredRun(page)).toMatchObject({
      status: "completed",
      searchUrl: searchPage!.url(),
      found: 0,
      collected: 0,
    });
    await expect.poll(() => activeTabUrl(page)).toBe(extensionUrl(extensionId, "dashboard.html"));
  });

  test("fails before submission when the observed native submit control is absent", async ({
    context,
    page,
    extensionId,
  }) => {
    const tracker = await routeNativeFlow(context, { includeHomeSubmit: false });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { keywords: "maison" });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("failed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("alert")).toContainText(/home search controls did not open|native search submit control was not found/iu);
    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(0);
    await expect.poll(() => activeTabUrl(page)).toBe(HOME_URL);
  });

  test("opens two owned detail tabs sequentially and closes only successful extractions", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(70_000);
    const tracker = await routeNativeFlow(context, { listingCount: 2 });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { maxListings: 2, details: true });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 65_000 });
    await expect(page.getByText("Collected 2 detailed listings.")).toBeVisible();

    expect(tracker.detailRequests).toEqual([DETAIL_URL, SECOND_DETAIL_URL]);
    expect(tracker.maxOpenDetailPages).toBe(1);
    expect(context.pages().filter((candidate) => isDetailUrl(candidate.url()))).toHaveLength(0);
    expect(context.pages().filter((candidate) => candidate.url().includes("/recherche?"))).toHaveLength(1);
    expect(await readStoredRecords(page)).toEqual([
      expect.objectContaining({ id: "3007106067", status: "detailed" }),
      expect.objectContaining({ id: "3007106066", status: "detailed" }),
    ]);
    await expect.poll(() => activeTabUrl(page)).toBe(extensionUrl(extensionId, "dashboard.html"));
  });

  test("continues after an unavailable optional results filter and renders one warning", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    await routeNativeFlow(context, { omitOwnerType: true });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { ownerType: "private" });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByRole("status")).toContainText("Seller");
    await expect(page.getByRole("status")).toContainText("seller control");
    const run = await readStoredRun(page);
    expect(run.filterWarnings).toEqual([
      expect.objectContaining({ field: "ownerType" }),
    ]);
  });

  test("fails on an ambiguous native home location before submitting it", async ({
    context,
    page,
    extensionId,
  }) => {
    const tracker = await routeNativeFlow(context, {
      locationSuggestions: ["Paris (75)", "Paris 15e"],
    });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { location: "Paris" });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("failed", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("alert")).toContainText("Location \"Paris\" is ambiguous");
    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(0);
    const homePage = context.pages().find((candidate) => candidate.url() === HOME_URL);
    expect(homePage).toBeDefined();
    const fixtureJournal = parseFixtureCookies(await homePage?.evaluate(() => document.cookie) ?? "");
    expect(fixtureJournal).toMatchObject({
      fixture_home_category_selections: "1",
      fixture_home_location_query: "Paris",
    });
    expect(fixtureJournal).not.toHaveProperty("fixture_home_location_selections");
    expect(fixtureJournal).not.toHaveProperty("fixture_home_submissions");
    await expect.poll(() => activeTabUrl(page)).toBe(HOME_URL);
  });

  test("disables double Start and cancels without submitting or touching another Leboncoin tab", async ({
    context,
    page,
    extensionId,
  }) => {
    const tracker = await routeNativeFlow(context);
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { keywords: "maison familiale avec jardin", location: "Finistère" });

    const foreign = await context.newPage();
    await foreign.goto("https://www.leboncoin.fr/recherche?foreign=untouched");
    await foreign.evaluate(() => { document.body.dataset.foreignMarker = "untouched"; });
    const foreignUrl = foreign.url();
    const searchRequestsBeforeRun = tracker.searchRequests;
    const start = page.getByRole("button", { name: "Start collection", exact: true });
    await start.click();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();
    await expect(page.getByText("configuring search", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByText("cancelled", { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(tracker.homeRequests).toBe(1);
    expect(tracker.searchRequests).toBe(searchRequestsBeforeRun);
    expect(foreign.url()).toBe(foreignUrl);
    expect(await foreign.evaluate(() => document.body.dataset.foreignMarker)).toBe("untouched");
  });

  test("pauses for a home captcha and resumes only after explicit user action", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const tracker = await routeNativeFlow(context, { homeHtml: CAPTCHA_PAGE_HTML });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page);

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByRole("banner").getByText("CAPTCHA pending", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    expect(tracker.searchRequests).toBe(0);

    const homePage = context.pages().find((candidate) => candidate.url() === HOME_URL);
    expect(homePage).toBeDefined();
    await homePage?.setContent(homePageHtml(), { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Resume" }).click();

    await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
    expect(tracker.searchRequests).toBe(5);
  });

  test("revalidates the same results tab once and pauses again when its captcha persists", async ({
    context,
    page,
    extensionId,
  }) => {
    const tracker = await routeNativeFlow(context, { searchHtml: CAPTCHA_PAGE_HTML });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page);

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByRole("banner").getByText("CAPTCHA pending", { exact: true })).toBeVisible({ timeout: 20_000 });
    const searchUrl = context.pages().find((candidate) => candidate.url().includes("/recherche?"))?.url();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
    await expect(page.getByRole("banner").getByText("CAPTCHA pending", { exact: true })).toBeVisible();
    expect(context.pages().find((candidate) => candidate.url().includes("/recherche?"))?.url()).toBe(searchUrl);
    expect(tracker.searchRequests).toBe(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("cancelled", { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("stops terminally on a blocked detail and preserves the focused review tab", async ({
    context,
    page,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    await routeNativeFlow(context, { detailHtml: ACTIVITY_BLOCK_PAGE_HTML });
    await openCleanDashboard(page, extensionId);
    await configureNativeSearch(page, { details: true });

    await page.getByRole("button", { name: "Start collection" }).click();
    await expect(page.getByText("activity blocked", { exact: true })).toBeVisible({ timeout: 55_000 });
    await expect(page.getByRole("button", { name: "Start collection" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(context.pages().some((candidate) => candidate.url() === DETAIL_URL)).toBe(true);
    await expect.poll(() => activeTabUrl(page)).toBe(DETAIL_URL);
  });

  test(
    "publishes a recipe and default plan, then keeps one MV3 capture until API and web converge",
    runFunctionalProductFlow,
  );
});

interface NativeFlowOptions {
  listingCount?: 0 | 1 | 2;
  locationSuggestions?: string[];
  omitOwnerType?: boolean;
  includeHomeCategory?: boolean;
  includeHomeLocation?: boolean;
  includeHomeSubmit?: boolean;
  spaNavigation?: boolean;
  homeHtml?: string;
  searchHtml?: string;
  searchPages?: SearchListingFixture[][];
  detailHtml?: string;
}

interface NativeFlowTracker {
  homeRequests: number;
  searchRequests: number;
  searchRequestUrls: string[];
  detailRequests: string[];
  maxOpenDetailPages: number;
}

async function routeNativeFlow(
  context: BrowserContext,
  options: NativeFlowOptions = {},
): Promise<NativeFlowTracker> {
  const tracker: NativeFlowTracker = {
    homeRequests: 0,
    searchRequests: 0,
    searchRequestUrls: [],
    detailRequests: [],
    maxOpenDetailPages: 0,
  };

  await context.route(/^https:\/\/www\.leboncoin\.fr\/?$/, async (route) => {
    tracker.homeRequests += 1;
    await route.fulfill({
      status: 200,
      headers: htmlHeaders(),
      body: options.homeHtml ?? homePageHtml({
        locationSuggestions: options.locationSuggestions,
        includeCategory: options.includeHomeCategory,
        includeLocation: options.includeHomeLocation,
        includeSubmit: options.includeHomeSubmit,
        navigationMode: options.spaNavigation ? "spa" : "document",
      }),
    });
  });
  await context.route("https://www.leboncoin.fr/recherche**", async (route) => {
    tracker.searchRequests += 1;
    tracker.searchRequestUrls.push(route.request().url());
    const requestedPage = Math.max(
      1,
      Number(new URL(route.request().url()).searchParams.get("page") ?? "1"),
    );
    await route.fulfill({
      status: 200,
      headers: htmlHeaders(),
      body: options.searchHtml ?? searchPageHtml({
        listingCount: options.listingCount,
        listings: options.searchPages?.[requestedPage - 1],
        locationSuggestions: options.locationSuggestions,
        omitOwnerType: options.omitOwnerType,
        pageNumber: requestedPage,
        totalPages: options.searchPages?.length ?? 1,
        currentSearchUrl: route.request().url(),
      }),
    });
  });
  await context.route(DETAIL_URL, async (route) => {
    tracker.detailRequests.push(DETAIL_URL);
    tracker.maxOpenDetailPages = Math.max(
      tracker.maxOpenDetailPages,
      openDetailPageCount(
        context,
        requestPageOrUndefined(route),
        route.request().url(),
      ),
    );
    await route.fulfill({
      status: 200,
      headers: htmlHeaders(),
      body: options.detailHtml ?? DETAIL_PAGE_HTML,
    });
  });
  await context.route(SECOND_DETAIL_URL, async (route) => {
    tracker.detailRequests.push(SECOND_DETAIL_URL);
    tracker.maxOpenDetailPages = Math.max(
      tracker.maxOpenDetailPages,
      openDetailPageCount(
        context,
        requestPageOrUndefined(route),
        route.request().url(),
      ),
    );
    await route.fulfill({ status: 200, headers: htmlHeaders(), body: SECOND_DETAIL_PAGE_HTML });
  });
  return tracker;
}

interface ConfigureSearchOptions {
  location?: string;
  keywords?: string;
  maxListings?: number;
  details?: boolean;
  ownerType?: "all" | "private" | "pro";
  minDelaySeconds?: number;
  maxDelaySeconds?: number;
}

async function configureNativeSearch(page: Page, options: ConfigureSearchOptions = {}): Promise<void> {
  await page.getByRole("textbox", { name: "Location", exact: true }).fill(options.location ?? "Finistère");
  if (options.keywords) await page.getByLabel("Keywords").fill(options.keywords);
  const apartment = page.getByRole("button", { name: "Flat", exact: true });
  if (await apartment.getAttribute("aria-pressed") === "true") await apartment.click();
  await page.getByLabel("Price max").fill("120000");
  await page.getByLabel("Rooms min").fill("2");
  await page.getByLabel("Rooms max").fill("3");
  const advancedSettings = page.locator("details.advanced-panel");
  if (await advancedSettings.getAttribute("open") === null) {
    await advancedSettings.locator("summary").click();
  }
  await page.getByLabel("Max listings").fill(String(options.maxListings ?? 1));
  await page.getByLabel("Seller").selectOption(options.ownerType ?? "all");
  await page.getByLabel("Delay min sec").fill(String(options.minDelaySeconds ?? 5));
  await page.getByLabel("Delay max sec").fill(String(options.maxDelaySeconds ?? 5));
  if (options.details) await page.getByText("Collect detail pages", { exact: true }).click();
}

async function openCleanDashboard(page: Page, extensionId: string): Promise<void> {
  await page.goto(extensionUrl(extensionId, "dashboard.html"));
  await clearExtensionStorage(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Denicheur Breizh" })).toBeVisible();
}

async function readStoredRecords(page: Page): Promise<Array<Record<string, unknown>>> {
  const storage = await readExtensionStorage(page);
  return (storage["denicheur:crawler:records"] ?? []) as Array<Record<string, unknown>>;
}

async function readStoredRun(page: Page): Promise<Record<string, unknown>> {
  const storage = await readExtensionStorage(page);
  return (storage["denicheur:crawler:run"] ?? {}) as Record<string, unknown>;
}

async function activeTabUrl(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const currentTab = await chrome.tabs.getCurrent();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) return tab.url;
    return tab?.id === currentTab?.id ? window.location.href : undefined;
  });
}

function requestPageOrUndefined(route: Route): Page | undefined {
  try {
    return route.request().frame().page();
  } catch {
    return undefined;
  }
}

function openDetailPageCount(
  context: BrowserContext,
  currentRequestPage?: Page,
  currentRequestUrl?: string,
): number {
  const detailPages = new Set(context.pages().filter((candidate) => isDetailUrl(candidate.url())));
  if (currentRequestPage) detailPages.add(currentRequestPage);
  else if (
    currentRequestUrl &&
    ![...detailPages].some((candidate) => candidate.url() === currentRequestUrl)
  ) {
    return detailPages.size + 1;
  }
  return detailPages.size;
}

function isDetailUrl(value: string): boolean {
  return value === DETAIL_URL || value === SECOND_DETAIL_URL;
}

function htmlHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self' data: https://img.leboncoin.fr; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  };
}

function parseFixtureCookies(cookieHeader: string): Record<string, string> {
  return Object.fromEntries(
    cookieHeader
      .split("; ")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        const name = separator >= 0 ? entry.slice(0, separator) : entry;
        const value = separator >= 0 ? entry.slice(separator + 1) : "";
        return [name, decodeURIComponent(value)];
      }),
  );
}

function expectHomeFiltersBeforeSingleSubmit(journal: Record<string, string>): void {
  const actions = (journal.fixture_home_actions ?? "").split("|").filter(Boolean);
  const categoryIndex = actions.indexOf("category:9");
  const locationIndex = actions.indexOf("location:Finistère (29)");
  const submitIndex = actions.indexOf("submit");

  expect(categoryIndex).toBeGreaterThanOrEqual(0);
  expect(locationIndex).toBeGreaterThanOrEqual(0);
  expect(submitIndex).toBeGreaterThan(categoryIndex);
  expect(submitIndex).toBeGreaterThan(locationIndex);
  expect(actions.filter((action) => action === "submit")).toHaveLength(1);
  expect(journal.fixture_home_submissions).toBe("1");
}

interface TabFocusJournalEntry {
  event: "activated" | "updated";
  tabId: number;
  windowId: number;
  url: string;
}

async function installTabFocusJournal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.tabFocusJournal = "[]";
    const append = (entry: {
      event: "activated" | "updated";
      tabId: number;
      windowId: number;
      url: string;
    }) => {
      const journal = JSON.parse(root.dataset.tabFocusJournal ?? "[]") as Array<typeof entry>;
      journal.push(entry);
      root.dataset.tabFocusJournal = JSON.stringify(journal);
    };

    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
      void chrome.tabs.get(tabId).then((tab) => {
        append({ event: "activated", tabId, windowId, url: tab.url ?? "" });
      }).catch(() => undefined);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!tab.active || (!changeInfo.url && changeInfo.status !== "complete")) return;
      append({
        event: "updated",
        tabId,
        windowId: tab.windowId,
        url: changeInfo.url ?? tab.url ?? "",
      });
    });
  });
}

async function readTabFocusJournal(page: Page): Promise<TabFocusJournalEntry[]> {
  return page.evaluate(() => JSON.parse(
    document.documentElement.dataset.tabFocusJournal ?? "[]",
  ) as TabFocusJournalEntry[]);
}

async function expectMetricValue(page: Page, label: string, value: number): Promise<void> {
  const metric = page.locator(".metric").filter({ has: page.getByText(label, { exact: true }) });
  await expect(metric).toHaveCount(1);
  await expect(metric.locator("strong")).toHaveText(String(value));
}

function foreignMarkerPageHtml(marker: string): string {
  return `<!doctype html><html lang="fr"><body data-foreign-marker="${marker}"><main><h1>${marker}</h1></main></body></html>`;
}

function fixtureListings(firstId: number, count: number): SearchListingFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const id = String(firstId + index);
    return { id, title: `Maison fixture ${id}` };
  });
}
