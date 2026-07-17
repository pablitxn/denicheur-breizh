import { formatNumber as formatIntlNumber } from "@denicheur-breizh/i18n";
import { bcp47Locales, type LocaleCode } from "../intl/locales";

export function formatPrice(value: number, locale: LocaleCode = "fr") {
  return new Intl.NumberFormat(bcp47Locales[locale], {
    style: "currency",
    currency: "EUR",
    currencyDisplay: "narrowSymbol",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPricePerM2(price: number, surfaceM2: number, locale: LocaleCode = "fr") {
  const pricePerSquareMeter = new Intl.NumberFormat(bcp47Locales[locale], {
    style: "currency",
    currency: "EUR",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(price / surfaceM2);
  return `${pricePerSquareMeter}\u00a0/m²`;
}

export function formatPostedDays(days: number, locale: LocaleCode = "fr") {
  return new Intl.RelativeTimeFormat(bcp47Locales[locale], { numeric: "auto" })
    .format(-Math.max(0, Math.round(days)), "day");
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
  return formatIntlNumber(value, locale, {
    style: "unit",
    unit: "kilometer",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  });
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
