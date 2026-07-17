import { expect, test, type Page } from "@playwright/test";

test.describe("Denicheur web workspace", () => {
  test("covers every view, metadata, persistence and cross-tab locale sync in FR, ES and EN", async ({ context, page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/?view=map");

    for (const locale of localeScenarios) {
      if (locale.switchName) {
        await page.getByRole("button", { name: locale.switchName }).click();
      }

      await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
      await expect(page).toHaveTitle(locale.title);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", locale.description);
      await expect(page.getByRole("navigation", { name: locale.navigation })).toBeVisible();
      await expectKeyboardEntryPoint(page, locale.skipLink);

      for (const [view, label] of Object.entries(locale.views)) {
        await page.getByRole("link", { name: label }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe(view);
        await expect(page.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");

        if (view === "map") {
          await expect(page.locator("canvas.maplibregl-canvas")).toHaveAttribute("aria-label", locale.mapTitle);
          await expect(page.getByRole("button", { name: locale.zoomIn, exact: true })).toBeVisible();
        } else if (view === "properties") {
          await expect(page.getByRole("table", { name: locale.table })).toBeVisible();
        } else if (view === "scorings") {
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        } else if (view === "builder") {
          await expect(page.getByLabel(locale.builderName)).toBeEnabled();
        } else {
          await expect(page.getByRole("region", { name: locale.realtimeRegion })).toBeVisible();
          await expect(page.getByRole("heading", { level: 1, name: locale.realtimeTitle })).toBeVisible();
        }

        await expectNoUnexpectedHorizontalOverflow(page, `${locale.lang}/${view}`);
      }
    }

    const peer = await context.newPage();
    await peer.goto("/?view=properties");
    await expect(peer.locator("html")).toHaveAttribute("lang", "en-GB");
    await expect(peer.getByRole("navigation", { name: "Primary view" })).toBeVisible();

    await page.getByRole("button", { name: "French" }).click();
    await expect(peer.locator("html")).toHaveAttribute("lang", "fr-FR");
    await expect(peer.getByRole("navigation", { name: "Vue principale" })).toBeVisible();
    await peer.reload();
    await expect(peer.locator("html")).toHaveAttribute("lang", "fr-FR");
    await expect(peer).toHaveTitle(/Décision immobilière/u);

    await page.getByRole("button", { name: "Passer au thème clair", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(pageErrors).toEqual([]);
    await peer.close();
  });

  test("preserves unsaved Builder weights and filters while localizing their labels", async ({ page }) => {
    await page.goto("/?view=builder");

    await page.getByLabel("Poids Accès littoral").fill("34");
    await page.getByLabel("Poids Calme nuit").fill("26");
    await page.getByRole("tab", { name: "Filtres durs" }).click();
    await page.getByLabel("Valeur du filtre prix").first().fill("470000");

    await page.getByRole("button", { name: "Espagnol" }).click();

    await expect(page.getByRole("tab", { name: "Filtros duros" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Valor del filtro precio").first()).toHaveValue("470000");
    await page.getByRole("tab", { name: "Ponderación" }).click();
    await expect(page.getByLabel("Peso de Acceso al litoral")).toHaveValue("34");
    await expect(page.getByLabel("Peso de Calma nocturna")).toHaveValue("26");
  });

  test("edits and saves a scoring recipe through the mock API boundary", async ({ page }) => {
    await page.goto("/?view=builder");

    const nameInput = page.getByLabel("Nom du scoring");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeEnabled();
    await nameInput.fill("Escapade bretonne E2E");
    await page.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByText("Enregistré", { exact: true })).toBeVisible();
    await expect(nameInput).toHaveValue("Escapade bretonne E2E");
    await expect(page.getByRole("tab", { name: "Pondération" })).toHaveAttribute("aria-selected", "true");
  });
});

const localeScenarios = [
  {
    switchName: undefined,
    lang: "fr-FR",
    title: /Décision immobilière/u,
    description: /Espace de décision immobilière/u,
    navigation: "Vue principale",
    skipLink: "Aller au contenu",
    views: { map: "Carte", properties: "Biens", scorings: "Scores", builder: "Atelier", realtime: "Voix" },
    mapTitle: "Carte des biens immobiliers",
    zoomIn: "Zoomer",
    table: "Table",
    builderName: "Nom du scoring",
    realtimeRegion: "Agent vocal en temps réel",
    realtimeTitle: "Espagnol vers français",
  },
  {
    switchName: "Espagnol",
    lang: "es-ES",
    title: /Decisión inmobiliaria/u,
    description: /Espacio de decisión inmobiliaria/u,
    navigation: "Vista principal",
    skipLink: "Ir al contenido",
    views: { map: "Mapa", properties: "Propiedades", scorings: "Puntuaciones", builder: "Constructor", realtime: "Voz" },
    mapTitle: "Mapa de propiedades inmobiliarias",
    zoomIn: "Acercar",
    table: "Tabla",
    builderName: "Nombre de la puntuación",
    realtimeRegion: "Agente de voz en tiempo real",
    realtimeTitle: "Español a francés",
  },
  {
    switchName: "Inglés",
    lang: "en-GB",
    title: /Property decisions/u,
    description: /property decision workspace/u,
    navigation: "Primary view",
    skipLink: "Skip to content",
    views: { map: "Map", properties: "Properties", scorings: "Scorings", builder: "Builder", realtime: "Voice" },
    mapTitle: "Map of property listings",
    zoomIn: "Zoom in",
    table: "Table",
    builderName: "Scoring name",
    realtimeRegion: "Realtime voice agent",
    realtimeTitle: "Spanish to French",
  },
] as const;

async function expectKeyboardEntryPoint(page: Page, skipLinkName: string) {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: skipLinkName })).toBeFocused();
  await page.evaluate(() => document.body.removeAttribute("tabindex"));
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
      const isIntentionalHorizontalScroller = (element: HTMLElement) => {
        const overflowX = getComputedStyle(element).overflowX;
        return (overflowX === "auto" || overflowX === "scroll") &&
          element.scrollWidth > element.clientWidth + tolerance;
      };
      const hasIntentionalHorizontalScroller = (element: HTMLElement) => {
        let current: HTMLElement | null = element;
        while (current && current !== document.body) {
          if (isIntentionalHorizontalScroller(current)) return true;
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
        if (
          !isVisible(element) ||
          element.closest(".maplibregl-map") ||
          element.closest('[aria-hidden="true"]')
        ) {
          continue;
        }

        const rect = element.getBoundingClientRect();
        const insideHorizontalScroller = hasIntentionalHorizontalScroller(element);
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
