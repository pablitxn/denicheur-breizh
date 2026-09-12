import { useEffect } from "react";
import { create } from "zustand";
import { isLocaleCode, resolveLocale, type LocaleCode } from "@denicheur-breizh/i18n";
import type { ThemePreference } from "@denicheur-breizh/design-system";

const themeKey = "denicheur:workspace";
const localeKey = "denicheur:locale";
const isTheme = (value: unknown): value is ThemePreference => value === "system" || value === "light" || value === "dark";

export function readPreferences() {
  let locale: string | null = null;
  let theme: ThemePreference = "system";
  try {
    locale = localStorage.getItem(localeKey) ?? localStorage.getItem("denicheur.locale");
    const saved = JSON.parse(localStorage.getItem(themeKey) ?? "null");
    if (isTheme(saved?.state?.theme)) theme = saved.state.theme;
  } catch { /* Preferences still work for this session. */ }
  return { locale: resolveLocale([locale, ...navigator.languages]), theme };
}

export function saveTheme(theme: ThemePreference) {
  let saved: { state?: Record<string, unknown>; version?: number } = {};
  try { saved = JSON.parse(localStorage.getItem(themeKey) ?? "{}") ?? {}; } catch { /* Replace invalid JSON only. */ }
  localStorage.setItem(themeKey, JSON.stringify({ ...saved, version: saved.version ?? 2, state: { ...saved.state, theme } }));
}

export const usePreferences = create<{
  locale: LocaleCode; theme: ThemePreference;
  setLocale: (locale: LocaleCode) => void; setTheme: (theme: ThemePreference) => void;
}>((set) => ({
  ...readPreferences(),
  setLocale(locale) { localStorage.setItem(localeKey, locale); set({ locale }); },
  setTheme(theme) { saveTheme(theme); set({ theme }); },
}));

export function useApplyPreferences() {
  const locale = usePreferences((state) => state.locale);
  const theme = usePreferences((state) => state.theme);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? media.matches ? "dark" : "light" : theme; };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === localeKey && isLocaleCode(event.newValue)) usePreferences.setState({ locale: event.newValue });
      if (event.key === themeKey || event.key === null) usePreferences.setState(readPreferences());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
}
