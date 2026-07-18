import { expect, test, type Page } from "@playwright/test";

import { FIXTURE_TIME, ingestListings, listingFixture, testToken } from "./realApiFixture.js";

const mobileViewports = [
  { width: 320, height: 844 },
  { width: 390, height: 844 },
] as const;

const coreViews = [
  { id: "map", name: "Carte" },
  { id: "properties", name: "Biens" },
  { id: "scorings", name: "Évaluations" },
  { id: "builder", name: "Atelier" },
] as const;

test.describe("integrated web responsive navigation", () => {
  for (const viewport of mobileViewports) {
    test(`${viewport.width}x${viewport.height} keeps every enabled real-data view reachable without overflow`, async ({ page, request }, testInfo) => {
      const token = testToken(testInfo, `responsive-${viewport.width}`);
      const listing = listingFixture(token, "responsive", {
        title: `Responsive ${viewport.width} ${token}`,
        propertyType: `Responsive ${token}`,
        coordinates: {
          latitude: 48.391,
          longitude: -4.486,
          verifiedAt: FIXTURE_TIME,
          provenance: `Fixture responsive ${token}`,
        },
      });
      await ingestListings(request, `web-responsive-${token}`, [listing]);

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setViewportSize(viewport);
      await page.goto("/?view=map");

      await expect(page.getByText("API connectée", { exact: true })).toBeVisible();
      const navigation = page.getByRole("navigation", { name: "Vue principale", exact: true });
      await expect(navigation).toBeVisible();

      const enabledViews: Array<{ id: string; name: string }> = [...coreViews];
      if (await navigation.getByRole("link", { name: "Voix", exact: true }).count()) {
        enabledViews.push({ id: "realtime", name: "Voix" });
      }
      await expect(navigation.getByRole("link")).toHaveCount(enabledViews.length);

      for (const view of enabledViews) {
        const link = navigation.getByRole("link", { name: view.name, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute("href", new RegExp(`[?&]view=${view.id}(?:&|$)`, "u"));
        await link.click();
        await expectSearchParam(page, "view", view.id);
        await expect(link).toHaveAttribute("aria-current", "page");
        await expectViewReady(page, view.id);
        await expectNoUnexpectedHorizontalOverflow(page, `${viewport.width}x${viewport.height}/${view.id}`);
      }

      expect(pageErrors).toEqual([]);
    });
  }
});

async function expectViewReady(page: Page, view: string): Promise<void> {
  if (view === "map") {
    await expect(page.getByRole("region", { name: "Carte des biens immobiliers", exact: true })).toBeVisible();
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
