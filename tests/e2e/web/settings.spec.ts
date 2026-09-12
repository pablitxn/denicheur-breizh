import { expect, test } from "@playwright/test";

test.describe("shared settings experience", () => {
  test("contains keyboard focus, hides diagnostics by default and restores the trigger", async ({ page }) => {
    await page.goto("/?view=properties");
    const trigger = page.getByRole("button", { name: "Paramètres", exact: true });
    await expect(page.getByText("API connectée", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Apparence" })).toHaveCount(0);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Paramètres" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Fermer les paramètres" })).toBeFocused();
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("Tab");
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.getByRole("button", { name: "Développement", exact: true }).click();
    await expect(dialog.getByText("API connectée", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByRole("combobox", { name: "Apparence" })).toBeVisible();
    await expect(page.getByText("API connectée", { exact: true })).toHaveCount(0);
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("applies system changes and persists preferences across reloads and tabs", async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?view=properties");
    await page.getByRole("button", { name: "Paramètres", exact: true }).click();
    const theme = page.getByRole("combobox", { name: "Apparence" });
    await expect(theme).toHaveValue("system");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await theme.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const other = await context.newPage();
    await other.goto("/?view=properties");
    await page.getByRole("combobox", { name: "Langue" }).selectOption("es");
    await expect(other.locator("html")).toHaveAttribute("lang", "es-ES");
    await page.getByRole("combobox", { name: "Apariencia" }).selectOption("dark");
    await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Configuración", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Apariencia" })).toHaveValue("dark");
    await expect(page.getByRole("combobox", { name: "Idioma" })).toHaveValue("es");
    await other.close();
  });

  test("fits small screens and leaves the close control reachable", async ({ page }) => {
    for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      await page.goto("/?view=properties");
      await page.getByRole("button", { name: "Paramètres", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
      await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.getByRole("button", { name: "Développement", exact: true }).click();
      await expect(page.getByRole("button", { name: "Fermer les paramètres" })).toBeInViewport();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  });
});
