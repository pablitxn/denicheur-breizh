export const SUPPORTED_LOCALES = ["fr", "es", "en"] as const;
export { SETTINGS_LABELS } from "./settings.js";

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: LocaleCode = "fr";

export interface LocaleMetadata {
  label: string;
  nativeName: string;
  bcp47: string;
}

export const LOCALE_METADATA: Record<LocaleCode, LocaleMetadata> = {
  fr: { label: "FR", nativeName: "Français", bcp47: "fr-FR" },
  es: { label: "ES", nativeName: "Español", bcp47: "es-ES" },
  en: { label: "EN", nativeName: "English", bcp47: "en-GB" },
};

export type MessageValues = Record<string, string | number>;

export interface PluralMessage {
  zero?: string;
  one: string;
  other: string;
}

export type MessageEntry = string | PluralMessage;
export type MessageCatalog<MessageId extends string> = Record<MessageId, MessageEntry>;

export interface MessageDescriptor<MessageId extends string = string> {
  id: MessageId;
  values?: MessageValues;
  technicalDetail?: string;
}

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && SUPPORTED_LOCALES.some((locale) => locale === value);
}

export function matchSupportedLocale(value: string | null | undefined): LocaleCode | undefined {
  if (!value) return undefined;

  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  return SUPPORTED_LOCALES.find((locale) => normalized === locale || normalized.startsWith(`${locale}-`));
}

export function normalizeLocale(value: string | null | undefined): LocaleCode {
  return matchSupportedLocale(value) ?? DEFAULT_LOCALE;
}

export function resolveLocale(candidates: readonly (string | null | undefined)[]): LocaleCode {
  for (const candidate of candidates) {
    const locale = matchSupportedLocale(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function translate<MessageId extends string>(
  catalogs: Record<LocaleCode, MessageCatalog<MessageId>>,
  locale: LocaleCode,
  id: MessageId,
  values?: MessageValues,
): string {
  const entry = catalogs[locale][id] ?? catalogs[DEFAULT_LOCALE][id];
  const template = selectMessageTemplate(entry, locale, values);
  return interpolate(template, values);
}

export function translateDescriptor<MessageId extends string>(
  catalogs: Record<LocaleCode, MessageCatalog<MessageId>>,
  locale: LocaleCode,
  descriptor: MessageDescriptor<MessageId>,
): string {
  return translate(catalogs, locale, descriptor.id, descriptor.values);
}

export function interpolate(message: string, values?: MessageValues): string {
  if (!values) return message;

  return message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

export function formatNumber(
  value: number,
  locale: LocaleCode,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(LOCALE_METADATA[locale].bcp47, options).format(value);
}

export function formatDateTime(
  value: Date | number | string,
  locale: LocaleCode,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(LOCALE_METADATA[locale].bcp47, options).format(date);
}

export function formatList(
  values: readonly string[],
  locale: LocaleCode,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(LOCALE_METADATA[locale].bcp47, options).format(values);
}

function selectMessageTemplate(
  entry: MessageEntry,
  locale: LocaleCode,
  values?: MessageValues,
): string {
  if (typeof entry === "string") return entry;

  const count = Number(values?.count);
  if (count === 0 && entry.zero !== undefined) return entry.zero;
  const rule = new Intl.PluralRules(LOCALE_METADATA[locale].bcp47).select(count);
  return rule === "one" ? entry.one : entry.other;
}
