import { expect, test } from "@playwright/test";
import { FIXTURE_TIME, ingestListings, listingFixture, testToken } from "./realApiFixture.js";

test("map filters survive navigation and reload, with recovery after WebGL startup failure", async ({ page, request }, testInfo) => {
  const token = testToken(testInfo, "map-recovery");
  const propertyType = `Maison ${token}`;
  const title = `Bien récupérable ${token}`;
  await ingestListings(request, `map-recovery-${token}`, [listingFixture(token, "map", {
    title, propertyType,
    coordinates: {
      longitude: -4.486, latitude: 48.391, locationKind: "source-property",
      provenance: "synthetic map recovery fixture", verifiedAt: FIXTURE_TIME,
    },
  })]);

  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
      if (String(args[0]).includes("webgl") && !sessionStorage.getItem("map-webgl-ready")) return null;
      return getContext.apply(this, args);
    } as typeof getContext;
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/?view=map");
  const error = page.getByRole("alert");
  await expect(error).toContainText("La carte n’a pas pu démarrer.");
  await page.getByRole("combobox", { name: "Type de bien" }).selectOption(propertyType);
  await expect.poll(() => new URL(page.url()).searchParams.get("mtype")).toBe(propertyType);
  await expect(page.getByRole("button", { name: `Afficher le détail de ${title}`, exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("map-webgl-ready", "1"));
  await error.getByRole("button", { name: "Réessayer", exact: true }).click();
  const map = page.getByRole("region", { name: "Carte de Bretagne et des biens immobiliers" });
  await expect(map.locator("canvas")).toHaveCount(1);
  await expect(map.locator("canvas")).toBeVisible();
  await expect(map).toHaveAttribute("aria-busy", "false");
  await expect(error).toHaveCount(0);

  const navigation = page.getByRole("navigation", { name: "Vue principale", exact: true });
  await navigation.getByRole("link", { name: "Biens", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Biens", exact: true })).toBeVisible();
  await navigation.getByRole("link", { name: "Carte", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Type de bien" })).toHaveValue(propertyType);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Type de bien" })).toHaveValue(propertyType);
  await expect(map).toHaveAttribute("aria-busy", "false");
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("map-recovered-desktop.png"), fullPage: true });
});
