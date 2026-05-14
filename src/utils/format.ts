import { bcp47Locales, type LocaleCode } from "../intl/locales";

export function formatPrice(value: number, locale: LocaleCode = "fr") {
  const bcp47Locale = bcp47Locales[locale];

  if (value >= 1000000) {
    return `${new Intl.NumberFormat(bcp47Locale, { maximumFractionDigits: 1 }).format(value / 1000000)} M€`;
  }

  return `${Math.round(value / 1000).toLocaleString(bcp47Locale)} k€`;
}

export function formatPricePerM2(price: number, surfaceM2: number, locale: LocaleCode = "fr") {
  return `${Math.round(price / surfaceM2).toLocaleString(bcp47Locales[locale])} €/m²`;
}

export function formatPostedDays(days: number, locale: LocaleCode = "fr") {
  if (locale === "es") {
    return `hace ${days} día${days === 1 ? "" : "s"}`;
  }

  return `il y a ${days} jour${days > 1 ? "s" : ""}`;
}

export function formatRooms(count: number, locale: LocaleCode = "fr") {
  if (locale === "es") {
    return `${count} ${count === 1 ? "habitación" : "habitaciones"}`;
  }

  return `${count} pièce${count > 1 ? "s" : ""}`;
}

export function formatPropertyCount(count: number, locale: LocaleCode = "fr") {
  if (locale === "es") {
    return `${count} propiedad${count === 1 ? "" : "es"}`;
  }

  return `${count} bien${count > 1 ? "s" : ""}`;
}

export function percentDelta(value: number, reference: number) {
  return ((value - reference) / reference) * 100;
}
