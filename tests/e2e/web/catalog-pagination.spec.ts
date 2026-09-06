import { expect, test } from "@playwright/test";
import { ingestListings, listingFixture, testToken } from "./realApiFixture.js";

test("keeps catalog pages stable during ingestion and bounds table and map rendering", async ({ page, request }, testInfo) => {
  const token = testToken(testInfo, "catalog-pages");
  const propertyType = `Catalog ${token}`;
  const fixtures = Array.from({ length: 120 }, (_, index) => listingFixture(token, String(index), {
    title: `00000 ${token} ${String(index).padStart(3, "0")}`,
    propertyType, priceEuros: 100000 + index, surfaceM2: 80,
    coordinates: { latitude: 47.996, longitude: -4.102, verifiedAt: "2026-09-06T10:00:00.000Z", provenance: "isolated catalog fixture", locationKind: "source-property" },
  }));
  for (let offset = 0; offset < fixtures.length; offset += 20) {
    await ingestListings(request, `catalog-${token}-${offset}`, fixtures.slice(offset, offset + 20));
  }
  await page.goto("/?view=properties&pmode=table&psort=title&pdir=asc");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText(fixtures[0]!.title!);
  await expect(page.getByRole("heading", { level: 2, name: fixtures[0]!.title!, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Suivant", exact: true }).click();
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText(fixtures[50]!.title!);
  await ingestListings(request, `catalog-new-${token}`, [listingFixture(token, "insert", { title: `00000 ${token} -inserted` })]);
  await page.getByRole("button", { name: "Suivant", exact: true }).click();
  await expect(rows.first()).toContainText(fixtures[100]!.title!);
  await expect(page.getByRole("heading", { level: 2, name: fixtures[0]!.title!, exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Actualiser/u }).click();
  await expect(rows.first()).toContainText(`00000 ${token} -inserted`);
  await expect(page.getByRole("button", { name: "Précédent", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("catalog-paged-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cartes", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Trier les biens", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suivant", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("catalog-paged-mobile.png"), fullPage: false });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?view=map&mtype=${encodeURIComponent(propertyType)}`);
  const results = page.getByRole("list", { name: "Résultats", exact: true });
  await expect(results.getByRole("button")).toHaveCount(30);
  const firstLabel = await results.getByRole("button").first().getAttribute("aria-label");
  await page.getByRole("button", { name: "Suivant", exact: true }).click();
  await expect(results.getByRole("button")).toHaveCount(30);
  await expect(results.getByRole("button").first()).not.toHaveAttribute("aria-label", firstLabel!);
  await results.getByRole("button").first().click();
  await expect(page.getByRole("complementary", { name: "Détails du bien sélectionné", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Carte de Bretagne et des biens immobiliers", exact: true })).toHaveAttribute("aria-busy", "false");
  await page.screenshot({ path: testInfo.outputPath("map-paged-desktop.png"), fullPage: true });
});
