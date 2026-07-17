import { useCallback, useEffect, useState } from "react";

export const EXTENSION_THEME_STORAGE_KEY = "denicheur:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (prefersDark ? "dark" : "light") : preference;
}

export function applyThemePreference(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  const resolved = resolveThemePreference(preference, prefersDark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim());
  return resolved;
}

export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    const values = await chrome.storage.sync.get(EXTENSION_THEME_STORAGE_KEY);
    return isThemePreference(values[EXTENSION_THEME_STORAGE_KEY])
      ? values[EXTENSION_THEME_STORAGE_KEY]
      : "system";
  } catch {
    return "system";
  }
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
  await chrome.storage.sync.set({ [EXTENSION_THEME_STORAGE_KEY]: preference });
}

export function useThemePreference(initialPreference: ThemePreference = "system") {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemePreference(initialPreference, systemPrefersDark()),
  );

  useEffect(() => {
    const media = systemThemeMedia();
    const apply = () => setResolvedTheme(applyThemePreference(preference, media?.matches ?? false));
    apply();
    media?.addEventListener("change", apply);
    return () => media?.removeEventListener("change", apply);
  }, [preference]);

  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "sync" || !(EXTENSION_THEME_STORAGE_KEY in changes)) return;
      const nextValue = changes[EXTENSION_THEME_STORAGE_KEY]?.newValue;
      setPreferenceState(isThemePreference(nextValue) ? nextValue : "system");
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const setPreference = useCallback(async (nextPreference: ThemePreference) => {
    const previous = preference;
    setPreferenceState(nextPreference);
    try {
      await saveThemePreference(nextPreference);
    } catch (error) {
      setPreferenceState(previous);
      throw error;
    }
  }, [preference]);

  return { preference, resolvedTheme, setPreference };
}

function systemThemeMedia(): MediaQueryList | undefined {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia("(prefers-color-scheme: dark)");
}

function systemPrefersDark(): boolean {
  return systemThemeMedia()?.matches ?? false;
}
