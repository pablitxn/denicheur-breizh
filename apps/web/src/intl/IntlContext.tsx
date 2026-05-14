import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLocaleCode, localeNames, normalizeLocale, type LocaleCode } from "./locales";
import { messages, type MessageId } from "./messages";

const storageKey = "denicheur.locale";

type MessageValues = Record<string, string | number>;

interface AppIntlContextValue {
  locale: LocaleCode;
  localeName: string;
  setLocale: (locale: LocaleCode) => void;
  t: (id: MessageId, values?: MessageValues) => string;
}

const AppIntlContext = createContext<AppIntlContextValue | null>(null);

function getInitialLocale() {
  if (typeof window === "undefined") return "fr";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (isLocaleCode(stored)) return stored;
  } catch {
    return normalizeLocale(window.navigator.language);
  }
  return normalizeLocale(window.navigator.language);
}

function interpolate(message: string, values?: MessageValues) {
  if (!values) return message;

  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

export function AppIntlProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(getInitialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem(storageKey, locale);
    } catch {
      // Locale still works for the current session if storage is unavailable.
    }
  }, [locale]);

  const setLocale = useCallback((nextLocale: LocaleCode) => {
    setLocaleState(nextLocale);
  }, []);

  const t = useCallback(
    (id: MessageId, values?: MessageValues) => interpolate(messages[locale][id], values),
    [locale],
  );

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
