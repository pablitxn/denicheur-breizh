import { expect, test, type Locator, type Page } from "@playwright/test";

const mobileViewports = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
] as const;

const primaryViews = [
  { id: "map", name: "Carte" },
  { id: "properties", name: "Biens" },
  { id: "scorings", name: "Scores" },
  { id: "builder", name: "Atelier" },
  { id: "realtime", name: "Voix" },
] as const;

test.describe("integrated web UX regressions", () => {
  for (const viewport of mobileViewports) {
    test(`${viewport.width}x${viewport.height} keeps all five views reachable without unexpected overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/?view=map");

      const navigation = page.getByRole("navigation", { name: "Vue principale" });
      await expect(navigation).toBeVisible();
      await expect(navigation.getByRole("link")).toHaveCount(primaryViews.length);

      for (const view of primaryViews) {
        const link = navigation.getByRole("link", { name: view.name, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", new RegExp(`[?&]view=${view.id}(?:&|$)`, "u"));
      }

      for (const view of primaryViews) {
        const link = navigation.getByRole("link", { name: view.name, exact: true });
        await link.click();
        await expectSearchParams(page, { view: view.id });
        await expect(link).toHaveAttribute("aria-current", "page");
        await expectViewReady(page, view.id);
        await expectNoUnexpectedHorizontalOverflow(page, `${viewport.width}x${viewport.height}/${view.id}`);

        if (view.id === "builder") {
          const editorHeading = page.getByRole("heading", { level: 1, name: "Atelier de scoring", exact: true });
          const paletteHeading = page.getByText("Briques disponibles", { exact: true });
          await expect.poll(async () => {
            const editorBox = await editorHeading.boundingBox();
            const paletteBox = await paletteHeading.boundingBox();
            return Boolean(editorBox && paletteBox && editorBox.y < paletteBox.y);
          }).toBe(true);
        }
      }
    });
  }

  test("keeps the 320px shell within the viewport with coarse touch targets", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:14173",
      hasTouch: true,
      isMobile: true,
      locale: "fr-FR",
      viewport: { width: 320, height: 844 },
    });
    const page = await context.newPage();

    try {
      await page.goto("/?view=map");
      await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await expectNoUnexpectedHorizontalOverflow(page, "320x844/coarse-shell");

      const languageGroup = page.getByRole("group", { name: "Langue", exact: true });
      for (const language of ["Français", "Espagnol", "Anglais"]) {
        await expect.poll(async () => (await languageGroup.getByRole("button", { name: language }).boundingBox())?.height)
          .toBeGreaterThanOrEqual(44);
      }
      await expect.poll(async () => (
        await page.getByRole("button", { name: /Passer au thème/u }).boundingBox()
      )?.height).toBeGreaterThanOrEqual(44);
      await expect.poll(async () => (
        await page.getByRole("button", { name: "Réinitialiser", exact: true }).boundingBox()
      )?.height).toBeGreaterThanOrEqual(44);
      await expect.poll(async () => (
        await page.getByRole("button", { name: "SeLoger", exact: true }).boundingBox()
      )?.height).toBeGreaterThanOrEqual(44);
    } finally {
      await context.close();
    }
  });

  test("uses property cards by default on mobile and reveals the selected detail", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=properties");

    await expect(page.getByRole("button", { name: "Cartes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("table", { name: "Table" })).toHaveCount(0);

    const propertyCard = page.getByRole("button", { name: /Longère rénovée/u });
    await expect(propertyCard).toHaveAttribute("aria-pressed", "false");
    await propertyCard.click();

    await expect(propertyCard).toHaveAttribute("aria-pressed", "true");
    await expectSearchParams(page, { pid: "p2" });
    await expect(page.getByRole("heading", { level: 2, name: "Longère rénovée", exact: true })).toBeVisible();
    await expectNoUnexpectedHorizontalOverflow(page, "390x844/properties-selected");
  });

  test("round-trips map filters including empty provider and property-type sets", async ({ page }) => {
    await page.goto("/?view=map");
    await expectViewReady(page, "map");

    const providerGroup = page.getByRole("group").filter({
      has: page.getByRole("button", { name: "Ouest-France", exact: true }),
    });
    await expect(providerGroup).toHaveCount(1);

    for (const provider of ["SeLoger", "Bien'ici", "Leboncoin", "Ouest-France"]) {
      const button = providerGroup.getByRole("button", { name: provider, exact: true });
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "false");
    }

    const typeGroup = page.getByRole("group").filter({
      has: page.getByRole("button", { name: "Terrain", exact: true }),
    });
    await expect(typeGroup).toHaveCount(1);
    const house = typeGroup.getByRole("button", { name: "Maison", exact: true });
    await expect(house).toHaveAttribute("aria-pressed", "true");
    await house.click();
    await expect(house).toHaveAttribute("aria-pressed", "false");

    const maxPrice = page.getByRole("slider", { name: "Prix maximum" });
    const minSurface = page.getByRole("slider", { name: "Surface minimum" });
    await maxPrice.press("Home");
    await minSurface.press("End");
    await page.getByRole("radio", { name: "G", exact: true }).check();

    const expected = {
      view: "map",
      mprov: "-",
      mtype: "-",
      mmax: "160000",
      msurf: "140",
      mdpe: "G",
    } as const;
    await expectSearchParams(page, expected);

    await page.reload();
    await expect(providerGroup).toHaveCount(1);
    for (const provider of ["SeLoger", "Bien'ici", "Leboncoin", "Ouest-France"]) {
      await expect(providerGroup.getByRole("button", { name: provider, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    for (const type of ["Maison", "Appartement", "Terrain"]) {
      await expect(typeGroup.getByRole("button", { name: type, exact: true })).toHaveAttribute("aria-pressed", "false");
    }
    await expect(maxPrice).toHaveValue("160000");
    await expect(minSurface).toHaveValue("140");
    await expect(page.getByRole("radio", { name: "G", exact: true })).toBeChecked();
    await expectSearchParams(page, expected);
  });

  test("round-trips property mode and sorting through the URL", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?view=properties");

    const table = page.getByRole("table", { name: "Table" });
    const priceSort = table.getByRole("button", { name: "Prix", exact: true });
    await expect(table).toBeVisible();
    await priceSort.click();
    await expectSearchParams(page, { psort: "price", pdir: null });
    await priceSort.click();
    await expectSearchParams(page, { psort: "price", pdir: "asc" });

    await page.getByRole("button", { name: "Cartes", exact: true }).click();
    await expectSearchParams(page, { pmode: "cards", psort: "price", pdir: "asc" });

    await page.reload();
    const cards = page.getByRole("button", { name: "Cartes", exact: true });
    await expect(cards).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("table", { name: "Table" })).toHaveCount(0);

    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Prix", exact: true })).toHaveAttribute("aria-sort", "ascending");
    await expectSearchParams(page, { pmode: "table", psort: "price", pdir: "asc" });
  });

  test("round-trips the scoring group and selected score through the URL", async ({ page }) => {
    await page.goto("/?view=scorings");

    const groupNavigation = page.getByRole("navigation").filter({
      has: page.getByRole("button", { name: /^Environnement/u }),
    });
    const environment = groupNavigation.getByRole("button", { name: /^Environnement/u });
    await expect(environment).toBeVisible();
    await environment.click();
    await expectSearchParams(page, { sgroup: "Environnement", sid: "quiet" });

    await page.reload();
    await expect(environment).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^Calme nuit/u })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { level: 2, name: "Calme nuit", exact: true })).toBeVisible();
    await expectSearchParams(page, { sgroup: "Environnement", sid: "quiet" });
  });

  test("round-trips the Builder recipe and active tab through the URL", async ({ page }) => {
    await page.goto("/?view=builder");
    await expect(page.getByLabel("Nom du scoring")).toBeEnabled();

    const familyRecipe = page.getByRole("button", { name: /^Maison famille/u });
    await familyRecipe.click();
    await expect(familyRecipe).toHaveAttribute("aria-pressed", "true");

    const formulaTab = page.getByRole("tab", { name: "Formule", exact: true });
    await formulaTab.click();
    await expect(formulaTab).toHaveAttribute("aria-selected", "true");
    await expectSearchParams(page, { brid: "family", btab: "formula" });

    await page.reload();
    await expect(familyRecipe).toHaveAttribute("aria-pressed", "true");
    await expect(formulaTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Formule", exact: true })).toBeVisible();
    await expectSearchParams(page, { brid: "family", btab: "formula" });
  });

  test("persists theme and shortlist choices across a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=properties");

    const propertyCard = page.getByRole("button", { name: /Longère rénovée/u });
    await propertyCard.click();
    await expect(page.getByRole("heading", { level: 2, name: "Longère rénovée", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Ajouter aux favoris", exact: true }).click();
    await expect(page.getByRole("button", { name: "Ajouté aux favoris", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Passer au thème clair", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "Passer au thème sombre", exact: true })).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "Passer au thème sombre", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Longère rénovée", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ajouté aux favoris", exact: true })).toBeVisible();
  });

  test("supports Arrow, Home and End keyboard navigation across Builder tabs", async ({ page }) => {
    await page.goto("/?view=builder");
    await expect(page.getByLabel("Nom du scoring")).toBeEnabled();

    const tabList = page.getByRole("tablist");
    const weights = tabList.getByRole("tab", { name: "Pondération", exact: true });
    const filters = tabList.getByRole("tab", { name: "Filtres durs", exact: true });
    const qa = tabList.getByRole("tab", { name: "Test et qualité", exact: true });

    await weights.focus();
    await weights.press("ArrowRight");
    await expectSelectedAndFocused(filters);
    await expectSearchParams(page, { btab: "filters" });

    await filters.press("End");
    await expectSelectedAndFocused(qa);
    await expectSearchParams(page, { btab: "qa" });

    await qa.press("Home");
    await expectSelectedAndFocused(weights);
    await expectSearchParams(page, { btab: null });

    await weights.press("ArrowLeft");
    await expectSelectedAndFocused(qa);
    await expectSearchParams(page, { btab: "qa" });
  });
});

async function expectSelectedAndFocused(tab: Locator) {
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toBeFocused();
}

async function expectViewReady(page: Page, view: (typeof primaryViews)[number]["id"]) {
  if (view === "map") {
    await expect(page.getByRole("button", { name: "Ajouter aux favoris", exact: true })).toBeAttached();
    return;
  }
  if (view === "properties") {
    await expect(page.getByRole("button", { name: /Longère rénovée/u })).toBeAttached();
    return;
  }
  if (view === "scorings") {
    await expect(page.getByRole("button", { name: /^Calme nuit/u })).toBeAttached();
    return;
  }
  if (view === "builder") {
    await expect(page.getByLabel("Nom du scoring")).toBeEnabled();
    return;
  }
  await expect(page.getByRole("region", { name: "Agent vocal en temps réel" })).toBeVisible();
}

async function expectSearchParams(
  page: Page,
  expected: Readonly<Record<string, string | null>>,
) {
  const entries = Object.entries(expected);
  await expect.poll(
    () => {
      const search = new URL(page.url()).searchParams;
      return Object.fromEntries(entries.map(([key]) => [key, search.get(key)]));
    },
    { message: `expected URL state ${JSON.stringify(expected)}` },
  ).toEqual(expected);
}

async function expectNoUnexpectedHorizontalOverflow(page: Page, context: string) {
  await expect.poll(
    () => page.evaluate(() => {
      const tolerance = 2;
      const viewportWidth = document.documentElement.clientWidth;
      const issues: Array<Record<string, string | number>> = [];

      const describe = (element: HTMLElement) => {
        const id = element.id ? `#${element.id}` : "";
        const classes = [...element.classList].slice(0, 2).map((name) => `.${name}`).join("");
        return `${element.tagName.toLowerCase()}${id}${classes}`;
      };
      const isVisible = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const isHorizontalScroller = (element: HTMLElement) => {
        const overflowX = getComputedStyle(element).overflowX;
        return (overflowX === "auto" || overflowX === "scroll") &&
          element.scrollWidth > element.clientWidth + tolerance;
      };
      const hasHorizontalScroller = (element: HTMLElement) => {
        let current: HTMLElement | null = element;
        while (current && current !== document.body) {
          if (isHorizontalScroller(current)) return true;
          current = current.parentElement;
        }
        return false;
      };

      if (document.documentElement.scrollWidth > viewportWidth + tolerance) {
        issues.push({
          element: "html",
          reason: "document overflow",
          clientWidth: viewportWidth,
          scrollWidth: document.documentElement.scrollWidth,
        });
      }

      for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
        if (!isVisible(element) || element.closest(".maplibregl-map") || element.closest('[aria-hidden="true"]')) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const insideHorizontalScroller = hasHorizontalScroller(element);
        if (!insideHorizontalScroller && (rect.left < -tolerance || rect.right > viewportWidth + tolerance)) {
          issues.push({
            element: describe(element),
            reason: "outside viewport",
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            viewportWidth,
          });
        }

        const style = getComputedStyle(element);
        const clipsHorizontally = style.overflowX === "hidden" || style.overflowX === "clip";
        const intentionallyEllipsized = style.textOverflow === "ellipsis";
        const isFormControl = element.matches("input, textarea, select");
        if (
          clipsHorizontally &&
          !isFormControl &&
          !intentionallyEllipsized &&
          !insideHorizontalScroller &&
          element.scrollWidth > element.clientWidth + tolerance
        ) {
          issues.push({
            element: describe(element),
            reason: "clipped horizontal content",
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          });
        }

        if (issues.length >= 20) break;
      }

      return issues;
    }),
    { message: `unexpected horizontal overflow in ${context}` },
  ).toEqual([]);
}
