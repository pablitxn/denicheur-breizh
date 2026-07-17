import {
  clearExtensionStorage,
  expect,
  extensionUrl,
  test,
} from "./fixtures.js";

test.describe("Denicheur extension UX regressions", () => {
  test("keeps the dashboard usable at 320px and persists an explicit theme", async ({
    page,
    extensionId,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page, "fr");
    await page.evaluate(async () => chrome.storage.sync.clear());
    await page.reload();

    await expect(page.getByRole("heading", { name: "Filtres de recherche" })).toBeVisible();
    await expectNoUnexpectedHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Aller au contenu principal" })).toBeFocused();

    const theme = page.getByRole("combobox", { name: "Thème de l’interface" });
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => page.evaluate(async () => {
      const values = await chrome.storage.sync.get("denicheur:theme");
      return values["denicheur:theme"];
    })).toBe("dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(theme).toHaveValue("dark");
    await expectNoUnexpectedHorizontalOverflow(page);
  });

  test("preserves a dirty filter draft when storage changes externally", async ({
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page);
    await page.reload();

    const location = page.getByRole("textbox", { name: "Location", exact: true });
    await location.fill("Saved location");
    await page.getByRole("button", { name: "Save filters" }).click();
    await expect(page.getByRole("status")).toContainText("Filters saved.");

    await location.fill("Local draft");
    await page.evaluate(async () => {
      const key = "denicheur:crawler:filters";
      const values = await chrome.storage.local.get(key);
      await chrome.storage.local.set({
        [key]: { ...(values[key] as Record<string, unknown>), locationQuery: "External value" },
      });
    });

    await expect(location).toHaveValue("Local draft");
    await expect(page.getByRole("status")).toContainText(
      "External changes were detected. Your local draft was preserved.",
    );

    await page.getByRole("button", { name: "Save filters" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const values = await chrome.storage.local.get("denicheur:crawler:filters");
      return (values["denicheur:crawler:filters"] as { locationQuery?: string } | undefined)?.locationQuery;
    })).toBe("Local draft");
  });

  test("paginates and searches every stored result instead of truncating the list", async ({
    context,
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page);
    await page.evaluate(async () => {
      const records = Array.from({ length: 55 }, (_, index) => {
        const number = index + 1;
        return {
          id: `fixture-${number}`,
          source: "leboncoin",
          listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${3_100_000_000 + number}`,
          title: `Fixture property ${number}`,
          location: number === 55 ? "Unique Plouha" : "Bretagne",
          features: [],
          scrapedAt: "2026-07-17T10:00:00.000Z",
          searchRunId: "ux-pagination",
          status: "listing",
          rawTextSample: `Fixture property ${number}`,
        };
      });
      await chrome.storage.local.set({ "denicheur:crawler:records": records });
    });
    await page.reload();

    await expect(page.getByRole("listitem")).toHaveCount(24);
    await expect(page.getByRole("navigation", { name: "Page 1 of 3" })).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/(?:\?|&)page=2(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(24);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/(?:\?|&)page=3(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(7);

    await page.reload();
    await expect(page).toHaveURL(/(?:\?|&)page=3(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(7);

    const popup = await context.newPage();
    await popup.goto(extensionUrl(extensionId, "popup.html"));
    await popup.getByRole("button", { name: "Open dashboard" }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(() => context.pages().filter((candidate) => {
      const url = new URL(candidate.url());
      return url.protocol === "chrome-extension:" && url.pathname === "/dashboard.html";
    }).length).toBe(1);
    await expect(page).toHaveURL(/(?:\?|&)page=3(?:&|$)/u);

    await page.getByRole("searchbox", { name: "Search stored listings" }).fill("Unique Plouha");
    await expect(page.getByRole("heading", { name: "Fixture property 55" })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page).toHaveURL(/(?:\?|&)q=Unique\+Plouha(?:&|$)/u);
    await expect(page).not.toHaveURL(/(?:\?|&)page=/u);
  });
});

async function expectNoUnexpectedHorizontalOverflow(
  page: import("@playwright/test").Page,
): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 320, scrollWidth: 320 });
}
