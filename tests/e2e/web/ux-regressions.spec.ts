import { expect, test, type Locator, type Page } from "@playwright/test";

import { FIXTURE_TIME, ingestListings, listingFixture, testToken } from "./realApiFixture.js";

const responsiveViewports = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
  { width: 1024, height: 844 },
] as const;

const coreViews = [
  { id: "map", name: "Carte" },
  { id: "properties", name: "Biens" },
  { id: "scorings", name: "Évaluations" },
  { id: "builder", name: "Atelier" },
] as const;

test.describe("integrated web responsive navigation", () => {
  for (const viewport of responsiveViewports) {
    test(`${viewport.width}x${viewport.height} keeps every enabled real-data view reachable without overflow`, async ({ page, request }, testInfo) => {
      const token = testToken(testInfo, `responsive-${viewport.width}`);
      const listing = listingFixture(token, "responsive", {
        title: `Responsive ${viewport.width} ${token}`,
        propertyType: `Responsive ${token}`,
        coordinates: {
          latitude: 48.391,
          longitude: -4.486,
          verifiedAt: FIXTURE_TIME,
          locationKind: "source-property",
          provenance: JSON.stringify({
            site: "fixture",
            container: "#__NEXT_DATA__",
            path: `props.pageProps.ad.location.${token}`,
            locationSource: "city",
            provider: "fixture",
          }),
        },
      });
      await ingestListings(request, `web-responsive-${token}`, [listing]);

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize(viewport);
      await page.goto("/?view=map");

      await expect(page).toHaveTitle("dénicheur·breizh — Décision immobilière en Bretagne");
      await expect(page.getByRole("banner").getByText("dénicheur·breizh", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Paramètres", exact: true })).toBeVisible();
      const navigation = page.getByRole("navigation", { name: "Vue principale", exact: true });
      await expect(navigation).toBeVisible();

      const enabledViews: Array<{ id: string; name: string }> = [...coreViews];
      if (await navigation.getByRole("link", { name: "Voix", exact: true }).count()) {
        enabledViews.push({ id: "realtime", name: "Voix" });
      }
      await expect(navigation.getByRole("link")).toHaveCount(enabledViews.length);
      await expectHeaderLayout(page);

      for (const view of enabledViews) {
        const link = navigation.getByRole("link", { name: view.name, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", new RegExp(`[?&]view=${view.id}(?:&|$)`, "u"));
        await link.click();
        await expectSearchParam(page, "view", view.id);
        await expect(link).toHaveAttribute("aria-current", "page");
        await expectViewReady(page, view.id);
        await expectViewFitsWidth(page, `${viewport.width}x${viewport.height}/${view.id}`);
        await expectNoUnexpectedHorizontalOverflow(page, `${viewport.width}x${viewport.height}/${view.id}`);
        await expectNoClippedText(page, `${viewport.width}x${viewport.height}/${view.id}`);
      }

      expect(pageErrors).toEqual([]);
    });
  }
});

test.describe("responsive Bretagne map", () => {
  for (const viewport of responsiveViewports) {
    test(`${viewport.width}x${viewport.height} keeps map markers anchored without overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/?view=map");
      await expectViewReady(page, "map");

      const map = page.getByRole("region", {
        name: "Carte de Bretagne et des biens immobiliers",
        exact: true,
      });
      await map.scrollIntoViewIfNeeded();
      const pointeDuRaz = map.getByRole("button", { name: "Découvrir Pointe du Raz", exact: true });
      await expect(pointeDuRaz).toBeVisible();
      await expect.poll(() => pointeDuRaz.evaluate((element) => getComputedStyle(element).position))
        .toBe("absolute");
      await expectViewFitsWidth(page, `${viewport.width}x${viewport.height}/map-only`);
      await expectNoUnexpectedHorizontalOverflow(page, `${viewport.width}x${viewport.height}/map-only`);
      await expectNoClippedText(page, `${viewport.width}x${viewport.height}/map-only`);
    });
  }
});

test.describe("responsive property gallery", () => {
  for (const viewport of responsiveViewports) {
    test(`${viewport.width}x${viewport.height} navigates card photos without overflow`, async ({ page, request }, testInfo) => {
      const token = testToken(testInfo, `responsive-gallery-${viewport.width}`);
      const title = `Galerie responsive ${viewport.width} ${token}`;
      const imageUrls = [1, 2].map((index) => `https://fixtures.invalid/${token}/responsive-${index}.svg`);
      const listing = listingFixture(token, "responsive-gallery", { title, imageUrls });

      await page.route("https://fixtures.invalid/**", (route) => route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12"><rect width="16" height="12" fill="#7257d4"/></svg>',
      }));
      await ingestListings(request, `web-responsive-gallery-${token}`, [listing]);
      await page.setViewportSize(viewport);
      await page.goto("/?view=properties&pmode=cards");
      await expectViewReady(page, "properties");

      const selectCard = page.getByRole("button", {
        name: `Afficher le détail de ${title}`,
        exact: true,
      });
      const gallery = page.locator("article").filter({ has: selectCard }).getByRole("group", {
        name: `Galerie photos de ${title}`,
        exact: true,
      });
      await gallery.scrollIntoViewIfNeeded();
      await expectLoadedImage(
        gallery.getByRole("img", { name: `Photo 1 sur 2 : ${title}`, exact: true }),
        imageUrls[0],
      );
      await gallery.getByRole("button", { name: `Photo suivante de ${title}`, exact: true }).click();
      await expectLoadedImage(
        gallery.getByRole("img", { name: `Photo 2 sur 2 : ${title}`, exact: true }),
        imageUrls[1],
      );
      await expectViewFitsWidth(page, `${viewport.width}x${viewport.height}/properties-gallery`);
      await expectNoUnexpectedHorizontalOverflow(page, `${viewport.width}x${viewport.height}/properties-gallery`);
      await expectNoClippedText(page, `${viewport.width}x${viewport.height}/properties-gallery`);
    });
  }
});

async function expectHeaderLayout(page: Page): Promise<void> {
  await expect.poll(() => page.getByRole("banner").evaluate((banner) => {
    const tolerance = 2;
    const bannerRect = banner.getBoundingClientRect();
    const visibleDescendants = [...banner.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const outside = visibleDescendants.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top < bannerRect.top - tolerance || rect.bottom > bannerRect.bottom + tolerance;
    }).map((element) => element.tagName.toLowerCase());
    const links = [...banner.querySelectorAll<HTMLElement>("nav a")];
    const linkTops = links.map((link) => Math.round(link.getBoundingClientRect().top));
    const rowCounts = [...linkTops.reduce((rows, top) => rows.set(top, (rows.get(top) ?? 0) + 1), new Map<number, number>()).values()];
    const overflowingLabels = links.filter((link) => {
      const label = link.querySelector<HTMLElement>("span");
      if (!label) return false;
      const linkRect = link.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return labelRect.left < linkRect.left - tolerance || labelRect.right > linkRect.right + tolerance;
    }).length;

    const navigationBalanced = rowCounts.length === 1
      || (links.length === 5 && rowCounts.length === 2 && rowCounts[0] === 3 && rowCounts[1] === 2);

    return { outside, navigationBalanced, overflowingLabels };
  })).toEqual({ outside: [], navigationBalanced: true, overflowingLabels: 0 });
}

async function expectViewFitsWidth(page: Page, context: string): Promise<void> {
  await expect.poll(
    () => page.locator("main > section").evaluate((view) => view.scrollWidth - view.clientWidth),
    { message: `workspace view should not scroll horizontally in ${context}` },
  ).toBeLessThanOrEqual(2);
}

async function expectViewReady(page: Page, view: string): Promise<void> {
  if (view === "map") {
    await expect(page.getByRole("region", { name: "Carte de Bretagne et des biens immobiliers", exact: true })).toBeVisible();
    return;
  }
  if (view === "properties") {
    await expect(page.getByRole("heading", { level: 1, name: "Biens", exact: true })).toBeVisible();
    return;
  }
  if (view === "scorings") {
    await expect(page.getByRole("heading", { level: 1, name: "Évaluations", exact: true })).toBeVisible();
    return;
  }
  if (view === "builder") {
    await expect(page.getByRole("heading", { level: 1, name: "Atelier de scoring", exact: true })).toBeVisible();
    return;
  }
  await expect(page.getByRole("region", { name: "Agent vocal en temps réel", exact: true })).toBeVisible();
}

async function expectSearchParam(page: Page, key: string, value: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).searchParams.get(key)).toBe(value);
}

async function expectLoadedImage(image: Locator, expectedSrc: string): Promise<void> {
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("src", expectedSrc);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

async function expectNoUnexpectedHorizontalOverflow(page: Page, context: string): Promise<void> {
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
        return (overflowX === "auto" || overflowX === "scroll")
          && element.scrollWidth > element.clientWidth + tolerance;
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
        const clipsOnlyDecorativeContent = element.children.length > 0
          && [...element.children].every((child) => child.matches('[aria-hidden="true"]'));
        if (
          clipsHorizontally
          && !isFormControl
          && !intentionallyEllipsized
          && !clipsOnlyDecorativeContent
          && !insideHorizontalScroller
          && element.scrollWidth > element.clientWidth + tolerance
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

async function expectNoClippedText(page: Page, context: string): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => {
      const tolerance = 2;
      const issues: Array<Record<string, string | number>> = [];
      const candidates = document.querySelectorAll<HTMLElement>(
        "button, a, h1, h2, h3, p, span, strong, small, dt, dd, th, td, label",
      );

      for (const element of candidates) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const text = (element.textContent ?? "").trim().replace(/\s+/gu, " ");
        const intentionallyEllipsized = style.textOverflow === "ellipsis";
        const canScrollVertically = style.overflowY === "auto" || style.overflowY === "scroll";

        if (
          text.length > 0
          && !element.closest(".maplibregl-map")
          && style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0
          && !intentionallyEllipsized
          && !canScrollVertically
          && element.scrollHeight > element.clientHeight + tolerance
        ) {
          issues.push({
            element: element.tagName.toLowerCase(),
            text: text.slice(0, 80),
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          });
        }

        if (issues.length >= 20) break;
      }

      return issues;
    }),
    { message: `unexpected clipped text in ${context}` },
  ).toEqual([]);
}
