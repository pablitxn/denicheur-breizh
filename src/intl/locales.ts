export const supportedLocales = ["fr", "es"] as const;

export type LocaleCode = (typeof supportedLocales)[number];

export const localeLabels: Record<LocaleCode, string> = {
  fr: "FR",
  es: "ES",
};

export const localeNames: Record<LocaleCode, string> = {
  fr: "Français",
  es: "Español",
};

export const bcp47Locales: Record<LocaleCode, string> = {
  fr: "fr-FR",
  es: "es-ES",
};

export function isLocaleCode(value: string | null | undefined): value is LocaleCode {
  return supportedLocales.some((locale) => locale === value);
}

export function normalizeLocale(value: string | null | undefined): LocaleCode {
  if (!value) return "fr";
  const normalized = value.toLowerCase();
  if (normalized.startsWith("es")) return "es";
  return "fr";
}
