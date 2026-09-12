import { clearExtensionStorage, expect, extensionUrl, test } from "./fixtures.js";

test("uses the same settings in popup and dashboard, preserves connection drafts between sections", async ({ page, context, extensionId }) => {
  await page.setViewportSize({ width: 360, height: 580 });
  await page.goto(extensionUrl(extensionId, "popup.html"));
  await clearExtensionStorage(page, "en");
  await page.reload();
  const dashboard = await context.newPage();
  await dashboard.goto(extensionUrl(extensionId, "dashboard.html"));
  await expect(page.getByRole("combobox", { name: "Appearance" })).toHaveCount(0);
  await expect(dashboard.getByRole("textbox", { name: /API URL/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Appearance" }).selectOption("dark");
  await expect(dashboard.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Development", exact: true }).click();
  const endpoint = page.locator('[name="runtime-api-base-url"]');
  await expect(endpoint).toBeEnabled();
  await endpoint.fill("http://127.0.0.1:4310");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(endpoint).toHaveValue("http://127.0.0.1:4310");
  await expect.poll(() => page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Close settings" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await dashboard.close();
});
