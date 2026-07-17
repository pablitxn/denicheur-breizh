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

test("@live crawls search and detail pages, calls the local API and stores OpenAI results", async ({
  context,
  page,
  extensionId,
}) => {
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
  await page.getByText("Enable", { exact: true }).click();
  await page.getByRole("button", { name: "Add criterion" }).click();
  await page.getByLabel("Recipe name").fill("Live extension integration");
  await page.getByLabel("Criterion 1 name").fill("Surface minimale");
  await page.getByLabel("Criterion 1 description").fill("La surface habitable doit être au moins 80 m².");
  await page.getByLabel("Criterion 1 weight").fill("10");
  await page.getByText("Required evidence", { exact: true }).click();

  await page.getByRole("button", { name: "Start collection" }).click();

  await expect(page.getByText("completed", { exact: true })).toBeVisible({ timeout: 130_000 });
  await expect(page.getByText("Collected 1 listings and evaluated 1.", { exact: true })).toBeVisible();
  const evaluation = page.getByRole("region", { name: "Intelligence evaluation" });
  await expect(evaluation).toBeVisible();
  await expect(evaluation).toContainText("gpt-5-mini-2025-08-07");

  await expect
    .poll(async () => {
      const storage = await readExtensionStorage(page);
      return storage["denicheur:crawler:records"];
    })
    .toEqual([
      expect.objectContaining({
        id: "3007106066",
        status: "detailed",
        evaluation: expect.objectContaining({
          listingId: "3007106066",
          evaluator: expect.objectContaining({
            provider: "openai",
            model: "gpt-5-mini-2025-08-07",
          }),
          criteria: [expect.objectContaining({ criterionId: expect.any(String) })],
        }),
      }),
    ]);
});

function htmlHeaders(): Record<string, string> {
  return { "content-type": "text/html; charset=utf-8" };
}
