import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemePreference,
  EXTENSION_THEME_STORAGE_KEY,
  isThemePreference,
  loadThemePreference,
  resolveThemePreference,
  saveThemePreference,
} from "./theme";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

describe("extension theme preference", () => {
  it("validates stored preferences and resolves the system theme", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("light", true)).toBe("light");
  });

  it("applies the resolved theme before React renders", () => {
    expect(applyThemePreference("system", true)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("loads and persists the preference in synchronized extension storage", async () => {
    const get = vi.fn(async () => ({ [EXTENSION_THEME_STORAGE_KEY]: "light" }));
    const set = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { storage: { sync: { get, set } } });

    await expect(loadThemePreference()).resolves.toBe("light");
    await saveThemePreference("dark");

    expect(get).toHaveBeenCalledWith(EXTENSION_THEME_STORAGE_KEY);
    expect(set).toHaveBeenCalledWith({ [EXTENSION_THEME_STORAGE_KEY]: "dark" });
  });

  it("falls back to system when storage is invalid or unavailable", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ [EXTENSION_THEME_STORAGE_KEY]: "sepia" })
      .mockRejectedValueOnce(new Error("storage unavailable"));
    vi.stubGlobal("chrome", { storage: { sync: { get } } });

    await expect(loadThemePreference()).resolves.toBe("system");
    await expect(loadThemePreference()).resolves.toBe("system");
  });
});
