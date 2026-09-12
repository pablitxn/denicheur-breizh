import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LOCALE_METADATA, translate, type MessageValues } from "@denicheur-breizh/i18n";
import { isLocaleCode, localeNames, resolveLocale, type LocaleCode } from "./locales";
import { messages, type MessageId } from "./messages";

export const localeStorageKey = "denicheur:locale";
const legacyStorageKey = "denicheur.locale";

interface AppIntlContextValue {
  locale: LocaleCode;
  localeName: string;
  setLocale: (locale: LocaleCode) => void;
  t: (id: MessageId, values?: MessageValues) => string;
}

const AppIntlContext = createContext<AppIntlContextValue | null>(null);

export function getInitialLocale(): LocaleCode {
  if (typeof window === "undefined") return "fr";

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(localeStorageKey) ?? window.localStorage.getItem(legacyStorageKey);
  } catch {
    // Browser locale detection still works when storage is unavailable.
  }

  return resolveLocale([stored, ...window.navigator.languages, window.navigator.language]);
}

export function AppIntlProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(getInitialLocale);

  const t = useCallback(
    (id: MessageId, values?: MessageValues) => translate(messages, locale, id, values),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = LOCALE_METADATA[locale].bcp47;
    document.title = t("app.meta.title");
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t("app.meta.description"));

    try {
      window.localStorage.setItem(localeStorageKey, locale);
      window.localStorage.removeItem(legacyStorageKey);
    } catch {
      // Locale still works for the current session if storage is unavailable.
    }
  }, [locale, t]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === localeStorageKey && isLocaleCode(event.newValue)) {
        setLocaleState(event.newValue);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setLocale = useCallback((nextLocale: LocaleCode) => {
    window.localStorage.setItem(localeStorageKey, nextLocale);
    setLocaleState(nextLocale);
  }, []);

  const value = useMemo<AppIntlContextValue>(
    () => ({
      locale,
      localeName: localeNames[locale],
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <AppIntlContext.Provider value={value}>{children}</AppIntlContext.Provider>;
}

export function useAppIntl() {
  const context = useContext(AppIntlContext);
  if (!context) {
    throw new Error("useAppIntl must be used inside AppIntlProvider");
  }
  return context;
}
