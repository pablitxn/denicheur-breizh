import { formatNumber as formatIntlNumber } from "@denicheur-breizh/i18n";
import type { LocaleCode } from "../intl/locales";

export function formatPrice(value: number, locale: LocaleCode = "fr") {
  if (value >= 1000000) {
    return `${formatIntlNumber(value / 1000000, locale, { maximumFractionDigits: 1 })} M€`;
  }

  return `${formatIntlNumber(Math.round(value / 1000), locale)} k€`;
}

export function formatPricePerM2(price: number, surfaceM2: number, locale: LocaleCode = "fr") {
  return `${formatIntlNumber(Math.round(price / surfaceM2), locale)} €/m²`;
}

export function formatPostedDays(days: number, locale: LocaleCode = "fr") {
  if (locale === "en") {
    return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`;
  }

  if (locale === "es") {
    return days === 0 ? "hoy" : `hace ${days} día${days === 1 ? "" : "s"}`;
  }

  return days === 0 ? "aujourd’hui" : `il y a ${days} jour${days === 1 ? "" : "s"}`;
}

export function formatRooms(count: number, locale: LocaleCode = "fr") {
  if (locale === "en") {
    return `${formatIntlNumber(count, locale)} room${count === 1 ? "" : "s"}`;
  }

  if (locale === "es") {
    return `${formatIntlNumber(count, locale)} ${count === 1 ? "habitación" : "habitaciones"}`;
  }

  return `${formatIntlNumber(count, locale)} pièce${count === 1 ? "" : "s"}`;
}

export function formatPropertyCount(count: number, locale: LocaleCode = "fr") {
  if (locale === "en") {
    return `${formatIntlNumber(count, locale)} propert${count === 1 ? "y" : "ies"}`;
  }

  if (locale === "es") {
    return `${formatIntlNumber(count, locale)} propiedad${count === 1 ? "" : "es"}`;
  }

  return `${formatIntlNumber(count, locale)} bien${count === 1 ? "" : "s"}`;
}

export function formatDecimal(value: number, locale: LocaleCode = "fr", fractionDigits = 1) {
  return formatIntlNumber(value, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatInteger(value: number, locale: LocaleCode = "fr") {
  return formatIntlNumber(value, locale, { maximumFractionDigits: 0 });
}

export function formatDistanceKm(value: number, locale: LocaleCode = "fr") {
  return `${formatIntlNumber(value, locale, { maximumFractionDigits: 1 })} km`;
}

export function formatPercentage(value: number, locale: LocaleCode = "fr", fractionDigits = 0) {
  return formatIntlNumber(value / 100, locale, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    signDisplay: value > 0 ? "always" : "auto",
  });
}

export function percentDelta(value: number, reference: number) {
  return ((value - reference) / reference) * 100;
}
