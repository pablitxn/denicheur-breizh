import {
  LOCALE_METADATA,
  SUPPORTED_LOCALES,
  isLocaleCode,
  normalizeLocale,
  resolveLocale,
  type LocaleCode,
} from "@denicheur-breizh/i18n";

export type { LocaleCode } from "@denicheur-breizh/i18n";
export { isLocaleCode, normalizeLocale, resolveLocale };

export const supportedLocales = SUPPORTED_LOCALES;

export const localeLabels: Record<LocaleCode, string> = {
  fr: LOCALE_METADATA.fr.label,
  es: LOCALE_METADATA.es.label,
  en: LOCALE_METADATA.en.label,
};

export const localeNames: Record<LocaleCode, string> = {
  fr: LOCALE_METADATA.fr.nativeName,
  es: LOCALE_METADATA.es.nativeName,
  en: LOCALE_METADATA.en.nativeName,
};

export const bcp47Locales: Record<LocaleCode, string> = {
  fr: LOCALE_METADATA.fr.bcp47,
  es: LOCALE_METADATA.es.bcp47,
  en: LOCALE_METADATA.en.bcp47,
};
