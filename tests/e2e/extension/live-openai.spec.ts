import {
  DETAIL_PAGE_HTML,
  clearExtensionStorage,
  extensionUrl,
  HOME_URL,
  homePageHtml,
  readExtensionStorage,
  SEARCH_PAGE_HTML,
  test,
  expect,
} from "./fixtures.js";

const liveEnabled = process.env.RUN_LIVE_OPENAI_E2E === "1";
const DETAIL_URL = "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066";
const API_BASE_URL = "http://127.0.0.1:14310";

test("@live crawls search and detail pages, calls the local API and stores OpenAI results", async ({
  context,
  page,
  extensionId,
}, testInfo) => {
  test.skip(!liveEnabled, "Set RUN_LIVE_OPENAI_E2E=1 to use the approved local OpenAI API key.");
  test.setTimeout(150_000);

  await context.route(HOME_URL, (route) =>
    route.fulfill({ status: 200, headers: htmlHeaders(), body: homePageHtml() }),
  );
  await context.route("https://www.leboncoin.fr/recherche**", (route) =>
    route.fulfill({ status: 200, headers: htmlHeaders(), body: SEARCH_PAGE_HTML }),
  );
  await context.route(DETAIL_URL, (route) =>
    route.fulfill({ status: 200, headers: htmlHeaders(), body: DETAIL_PAGE_HTML }),
  );

  const recipeId = `live-extension-integration-r${testInfo.retry}`;
  const planId = `live-extension-plan-r${testInfo.retry}`;
  const savedRecipe = await context.request.put(`${API_BASE_URL}/v1/recipes/${recipeId}`, {
    data: {
      name: "Live extension integration",
      threshold: 70,
      criteria: [{
        id: "minimum-surface",
        name: "Surface minimale",
        description: "La surface habitable doit être au moins 80 m².",
        weight: 10,
        required: true,
        evidenceRequired: true,
      }],
    },
  });
  expect(savedRecipe.status()).toBe(201);
  const savedPlan = await context.request.put(`${API_BASE_URL}/v1/evaluation-plans/${planId}`, {
    data: {
      name: "Live extension plan",
      operator: "all",
      recipes: [{ recipeId, recipeVersion: 1 }],
    },
  });
  expect(savedPlan.status()).toBe(201);
  const setDefault = await context.request.post(`${API_BASE_URL}/v1/evaluation-plans/${planId}/set-default`, {
    data: { version: 1 },
  });
  expect(setDefault.ok()).toBe(true);

  await page.goto(extensionUrl(extensionId, "dashboard.html"));
  await clearExtensionStorage(page);
  await page.reload();
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Finistère");
  const apartment = page.getByRole("button", { name: "Flat", exact: true });
  if (await apartment.getAttribute("aria-pressed") === "true") await apartment.click();
  await page.locator("details.advanced-panel > summary").click();
  await page.getByLabel("Max listings").fill("1");
  await page.getByLabel("Delay min sec").fill("5");
  await page.getByLabel("Delay max sec").fill("5");
  await page.locator("details.intelligence-panel > summary").click();
  await page.getByRole("button", { name: "Refresh default plan" }).click();
  await expect(page.getByText("Default plan refreshed from the API.", { exact: true })).toBeVisible();
  await expect(page.getByText("Live extension plan", { exact: true })).toBeVisible();
  await expect(page.getByText("Live extension integration", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const storage = await readExtensionStorage(page);
    const state = storage["denicheur:sync:state"] as {
      activePlan?: { status?: string; planId?: string; planVersion?: number };
    } | undefined;
    const plan = storage["denicheur:intelligence:plan"] as {
      id?: string;
      version?: number;
      recipes?: Array<{ recipeId?: string; recipeVersion?: number }>;
    } | undefined;
    return { activePlan: state?.activePlan, plan };
  }).toMatchObject({
    activePlan: { status: "cached", planId, planVersion: 1 },
    plan: {
      id: planId,
      version: 1,
      recipes: [{ recipeId, recipeVersion: 1 }],
    },
  });

  await page.getByRole("button", { name: "Start collection" }).click();

  await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 130_000 });
  await expect
    .poll(async () => {
      const storage = await readExtensionStorage(page);
      return storage["denicheur:crawler:records"];
    }, { timeout: 120_000 })
    .toEqual([
      expect.objectContaining({
        id: "3007106066",
        status: "detailed",
        planEvaluation: expect.objectContaining({
          executionId: expect.any(String),
          listingId: "3007106066",
          planId,
          planVersion: 1,
          decision: "relevant",
          steps: [expect.objectContaining({
            recipeId,
            recipeVersion: 1,
            status: expect.stringMatching(/^(succeeded|cached)$/),
            evaluator: {
              provider: "openai",
              model: "gpt-5-mini-2025-08-07",
              version: "3.0.0",
            },
            evaluation: expect.objectContaining({
              listingId: "3007106066",
              criteria: [expect.objectContaining({ criterionId: "minimum-surface" })],
            }),
          })],
        }),
      }),
    ]);
  const persisted = await readExtensionStorage(page);
  const [record] = persisted["denicheur:crawler:records"] as Array<Record<string, unknown>>;
  expect(record).not.toHaveProperty("evaluation");

  await expect(page.getByText("Evaluated 1 detailed listings.", { exact: true })).toBeVisible();
  const evaluation = page.getByRole("region", { name: "Intelligence evaluation" });
  await expect(evaluation).toBeVisible();
  await expect(evaluation).toContainText(`${recipeId} v1 · succeeded`);
  await expect(evaluation).toContainText("gpt-5-mini-2025-08-07");
  await expect(evaluation).toContainText("3.0.0");
});

function htmlHeaders(): Record<string, string> {
  return { "content-type": "text/html; charset=utf-8" };
}
