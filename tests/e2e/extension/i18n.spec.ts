import {
  clearExtensionStorage,
  expect,
  extensionUrl,
  test,
} from "./fixtures.js";

test.describe("Denicheur MV3 interface locales", () => {
  test("packages native locales and synchronizes FR to ES to EN across popup and dashboard", async ({
    context,
    page: popup,
    extensionId,
  }) => {
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(extensionUrl(extensionId, "popup.html"));
    await clearExtensionStorage(popup, "fr");
    await popup.reload();

    const dashboard = await context.newPage();
    await dashboard.goto(extensionUrl(extensionId, "dashboard.html"));

    await expect(popup.locator("html")).toHaveAttribute("lang", "fr-FR");
    await expect(dashboard.locator("html")).toHaveAttribute("lang", "fr-FR");
    await expect(popup.getByRole("button", { name: "Ouvrir le tableau de bord" })).toBeVisible();
    await expect(dashboard.getByRole("heading", { name: "Filtres de recherche" })).toBeVisible();
    await expectNoHorizontalOverflow(popup);
    await expectKeyboardFocusOnFirstLocaleControl(
      popup,
      "Afficher l’interface en Français",
    );

    await popup.getByRole("button", { name: /Español/u }).click();
    await expect(popup.locator("html")).toHaveAttribute("lang", "es-ES");
    await expect(dashboard.locator("html")).toHaveAttribute("lang", "es-ES");
    await expect(popup.getByRole("button", { name: "Abrir panel" })).toBeVisible();
    await expect(dashboard.getByRole("heading", { name: "Filtros de búsqueda" })).toBeVisible();
    await expectNoHorizontalOverflow(popup);
    await popup.reload();
    await expect(popup.locator("html")).toHaveAttribute("lang", "es-ES");
    await expectKeyboardFocusOnFirstLocaleControl(
      popup,
      "Mostrar la interfaz en Français",
    );

    await dashboard.getByRole("button", { name: /English/u }).click();
    await expect(popup.locator("html")).toHaveAttribute("lang", "en-GB");
    await expect(dashboard.locator("html")).toHaveAttribute("lang", "en-GB");
    await expect(popup.getByRole("button", { name: "Open dashboard" })).toBeVisible();
    await expect(dashboard.getByRole("heading", { name: "Search filters" })).toBeVisible();
    await expectNoHorizontalOverflow(popup);
    await popup.reload();
    await expect(popup.locator("html")).toHaveAttribute("lang", "en-GB");
    await expectKeyboardFocusOnFirstLocaleControl(
      popup,
      "Show the interface in Français",
    );

    await expect.poll(() => popup.evaluate(async () => {
      const values = await chrome.storage.local.get("denicheur:locale");
      return values["denicheur:locale"];
    })).toBe("en");

    await popup.close();
    const reopenedPopup = await context.newPage();
    await reopenedPopup.setViewportSize({ width: 360, height: 640 });
    await reopenedPopup.goto(extensionUrl(extensionId, "popup.html"));
    await expect(reopenedPopup.locator("html")).toHaveAttribute("lang", "en-GB");
    await expect(reopenedPopup.getByRole("button", { name: "Open dashboard" })).toBeVisible();
    await expectNoHorizontalOverflow(reopenedPopup);

    const packaged = await reopenedPopup.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const localeFiles = await Promise.all(["fr", "es", "en"].map(async (locale) => {
        const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
        const messages = await response.json() as Record<string, { message?: string }>;
        return {
          locale,
          ok: response.ok,
          keys: Object.keys(messages).sort(),
          hasValues: Object.values(messages).every((entry) => Boolean(entry.message)),
        };
      }));
      return {
        defaultLocale: manifest.default_locale,
        actionTitle: manifest.action?.default_title,
        localeFiles,
      };
    });

    expect(packaged.defaultLocale).toBe("fr");
    expect(packaged.actionTitle).toBeTruthy();
    expect(packaged.localeFiles).toEqual([
      expectedLocaleFile("fr"),
      expectedLocaleFile("es"),
      expectedLocaleFile("en"),
    ]);
  });

  test("keeps an existing narrative in its original language without automatic reevaluation", async ({
    context,
    page: dashboard,
    extensionId,
  }) => {
    let apiRequests = 0;
    context.on("request", (request) => {
      if (request.url().includes("/v1/listings/filter")) apiRequests += 1;
    });

    await dashboard.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(dashboard, "fr");
    await seedFrenchEvaluation(dashboard);
    await dashboard.reload();

    await expect(dashboard.getByText("Résumé français immuable.", { exact: true })).toBeVisible();
    await dashboard.getByRole("button", { name: /Español/u }).click();

    await expect(dashboard.getByText("Résumé français immuable.", { exact: true })).toBeVisible();
    await expect(dashboard.getByText(/Esta evaluación se generó en francés/u)).toBeVisible();
    await expect(dashboard.getByRole("button", { name: "Reevaluar guardados" })).toBeEnabled();
    await dashboard.getByText("Evidencia por criterio", { exact: true }).click();
    await expect(dashboard.getByText("Raison française immuable.", { exact: true })).toBeVisible();
    await expect(dashboard.getByText("jardin privatif", { exact: true })).toBeVisible();

    await dashboard.getByRole("button", { name: /English/u }).click();
    await expect(dashboard.getByText(/This evaluation was generated in French/u)).toBeVisible();
    await expect(dashboard.getByRole("button", { name: "Reevaluate stored" })).toBeEnabled();
    expect(apiRequests).toBe(0);
  });
});

async function seedFrenchEvaluation(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const listingId = "3007106066";
    await chrome.storage.local.set({
      "denicheur:intelligence:recipe": {
        id: "personal-fit",
        version: 1,
        name: "Personal fit",
        threshold: 70,
        enabled: true,
        criteria: [{
          id: "garden",
          name: "Jardin privé",
          description: "Le bien décrit un jardin privé.",
          weight: 100,
          required: true,
        }],
      },
      "denicheur:crawler:records": [{
        id: listingId,
        source: "leboncoin",
        listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${listingId}`,
        title: "Maison avec jardin",
        description: "Maison familiale avec jardin privatif.",
        features: ["Jardin"],
        scrapedAt: "2026-07-16T12:00:00.000Z",
        searchRunId: "run-fr",
        status: "detailed",
        rawTextSample: "Maison avec jardin privatif",
        evaluation: {
          listingId,
          decision: "relevant",
          score: 91,
          summary: "Résumé français immuable.",
          criteria: [{
            criterionId: "garden",
            verdict: "pass",
            reason: "Raison française immuable.",
            evidence: ["jardin privatif"],
          }],
          missingData: [],
          evaluatedAt: "2026-07-16T12:01:00.000Z",
          evaluator: { provider: "openai", model: "fixture-model", version: "filter-v1" },
          recipeId: "personal-fit",
          recipeVersion: 1,
          locale: "fr",
        },
      }],
    });
  });
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({
    clientWidth: 360,
    scrollWidth: 360,
  }));
}

async function expectKeyboardFocusOnFirstLocaleControl(
  page: import("@playwright/test").Page,
  accessibleName: string,
): Promise<void> {
  const firstLocaleControl = page.getByRole("button", {
    name: accessibleName,
    exact: true,
  });
  await expect(firstLocaleControl).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(firstLocaleControl).toBeFocused();
}

function expectedLocaleFile(locale: string) {
  return {
    locale,
    ok: true,
    keys: ["extensionActionTitle", "extensionDescription", "extensionName"],
    hasValues: true,
  };
}
