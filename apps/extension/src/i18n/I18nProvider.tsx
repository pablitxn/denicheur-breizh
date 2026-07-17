import {
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  formatDateTime as formatSharedDateTime,
  formatList as formatSharedList,
  formatNumber as formatSharedNumber,
  isLocaleCode,
  resolveLocale,
  type LocaleCode,
  type MessageValues,
} from "@denicheur-breizh/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  translateExtension,
  type ExtensionMessageId,
  type ExtensionTranslate,
} from "./messages";
import {
  resolveLocalizedText,
  type ResolvedLocalizedText,
} from "./runtime";

export const EXTENSION_LOCALE_STORAGE_KEY = "denicheur:locale";

export type ExtensionSurface = "popup" | "dashboard";

interface ExtensionI18nContextValue {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => Promise<void>;
  t: ExtensionTranslate;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDateTime: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatList: (values: readonly string[], options?: Intl.ListFormatOptions) => string;
  resolveText: (
    value: unknown,
    fallbackId?: ExtensionMessageId,
  ) => ResolvedLocalizedText;
}

const ExtensionI18nContext = createContext<ExtensionI18nContextValue | undefined>(undefined);

interface ExtensionI18nProviderProps {
  surface: ExtensionSurface;
  initialLocale?: LocaleCode;
  children: ReactNode;
}

export function ExtensionI18nProvider({
  surface,
  initialLocale,
  children,
}: ExtensionI18nProviderProps) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => initialLocale ?? detectBrowserLocale());

  useEffect(() => {
    let mounted = true;

    void loadExtensionLocale().then((storedLocale) => {
      if (mounted) setLocaleState(storedLocale);
    });

    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "local" || !(EXTENSION_LOCALE_STORAGE_KEY in changes)) return;
      const nextValue = changes[EXTENSION_LOCALE_STORAGE_KEY]?.newValue;
      setLocaleState(isLocaleCode(nextValue) ? nextValue : detectBrowserLocale());
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const t = useCallback<ExtensionTranslate>(
    (id, values) => translateExtension(locale, id, values),
    [locale],
  );

  useEffect(() => {
    const titleId = surface === "dashboard" ? "app.dashboardTitle" : "app.popupTitle";
    const descriptionId = surface === "dashboard"
      ? "meta.dashboardDescription"
      : "meta.popupDescription";
    document.documentElement.lang = LOCALE_METADATA[locale].bcp47;
    document.documentElement.dataset.accent = "sea";
    document.documentElement.dataset.surface = surface;
    if (surface === "popup") {
      document.documentElement.dataset.density = "compact";
    } else {
      delete document.documentElement.dataset.density;
    }
    document.title = t(titleId);
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
      "content",
      t(descriptionId),
    );
  }, [locale, surface, t]);

  const setLocale = useCallback(async (nextLocale: LocaleCode) => {
    setLocaleState(nextLocale);
    await chrome.storage.local.set({ [EXTENSION_LOCALE_STORAGE_KEY]: nextLocale });
  }, []);

  const value = useMemo<ExtensionI18nContextValue>(() => ({
    locale,
    setLocale,
    t,
    formatNumber: (number, options) => formatSharedNumber(number, locale, options),
    formatDateTime: (date, options) => formatSharedDateTime(date, locale, options),
    formatList: (values, options) => formatSharedList(values, locale, options),
    resolveText: (message, fallbackId) => resolveLocalizedText(message, t, fallbackId),
  }), [locale, setLocale, t]);

  return (
    <ExtensionI18nContext.Provider value={value}>
      {children}
    </ExtensionI18nContext.Provider>
  );
}

export function useExtensionI18n(): ExtensionI18nContextValue {
  const value = useContext(ExtensionI18nContext);
  if (!value) throw new Error("useExtensionI18n must be used inside ExtensionI18nProvider.");
  return value;
}

export function resolvePreferredLocale(
  storedLocale: unknown,
  browserUiLocale?: string,
  navigatorLocales: readonly string[] = [],
): LocaleCode {
  return resolveLocale([
    typeof storedLocale === "string" ? storedLocale : undefined,
    browserUiLocale,
    ...navigatorLocales,
  ]);
}

export function detectBrowserLocale(): LocaleCode {
  return resolvePreferredLocale(undefined, browserUiLanguage(), browserLanguages());
}

export async function loadExtensionLocale(): Promise<LocaleCode> {
  try {
    const values = await chrome.storage.local.get(EXTENSION_LOCALE_STORAGE_KEY);
    return resolvePreferredLocale(
      values[EXTENSION_LOCALE_STORAGE_KEY],
      browserUiLanguage(),
      browserLanguages(),
    );
  } catch {
    return detectBrowserLocale();
  }
}

function browserUiLanguage(): string | undefined {
  try {
    return chrome.i18n?.getUILanguage();
  } catch {
    return undefined;
  }
}

function browserLanguages(): readonly string[] {
  return typeof navigator === "undefined" ? [] : navigator.languages;
}

export function extensionMessage(
  id: ExtensionMessageId,
  values?: MessageValues,
): { id: ExtensionMessageId; values?: MessageValues } {
  return values ? { id, values } : { id };
}

export { DEFAULT_LOCALE };
