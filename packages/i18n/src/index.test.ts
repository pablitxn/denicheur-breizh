import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  formatDateTime,
  formatList,
  formatNumber,
  interpolate,
  isLocaleCode,
  LOCALE_METADATA,
  matchSupportedLocale,
  normalizeLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
  translate,
  translateDescriptor,
  type MessageCatalog,
  type LocaleCode,
} from "./index.js";

const frCatalog = {
  greeting: "Bonjour {name}",
  records: { zero: "Aucun bien", one: "{count} bien", other: "{count} biens" },
} as const satisfies MessageCatalog<string>;

type TestMessageId = keyof typeof frCatalog;

const catalogs: Record<LocaleCode, MessageCatalog<TestMessageId>> = {
  fr: frCatalog,
  es: {
    greeting: "Hola {name}",
    records: { zero: "Ninguna propiedad", one: "{count} propiedad", other: "{count} propiedades" },
  },
  en: {
    greeting: "Hello {name}",
    records: { zero: "No properties", one: "{count} property", other: "{count} properties" },
  },
};

describe("locale resolution", () => {
  it.each([
    ["fr-FR", "fr"],
    ["es_419", "es"],
    ["en-GB", "en"],
    ["  EN_us  ", "en"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(matchSupportedLocale(input)).toBe(expected);
    expect(normalizeLocale(input)).toBe(expected);
  });

  it("falls back to French and chooses the first supported browser locale", () => {
    expect(normalizeLocale("de-DE")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(["de-DE", "en-US", "es-ES"])).toBe("en");
    expect(resolveLocale([null, undefined, "", "de-DE"])).toBe("fr");
  });

  it("keeps exact locale codes distinct from regional matching", () => {
    expect(SUPPORTED_LOCALES).toEqual(["fr", "es", "en"]);
    expect(DEFAULT_LOCALE).toBe("fr");
    expect(isLocaleCode("fr")).toBe(true);
    expect(isLocaleCode("FR")).toBe(false);
    expect(isLocaleCode("fr-FR")).toBe(false);
    expect(isLocaleCode(null)).toBe(false);
    expect(matchSupportedLocale("FR-ca")).toBe("fr");
    expect(matchSupportedLocale("de-DE")).toBeUndefined();
    expect(matchSupportedLocale("   ")).toBeUndefined();
  });

  it("publishes the requested display order and BCP 47 metadata", () => {
    expect(SUPPORTED_LOCALES.map((locale) => LOCALE_METADATA[locale])).toEqual([
      { label: "FR", nativeName: "Français", bcp47: "fr-FR" },
      { label: "ES", nativeName: "Español", bcp47: "es-ES" },
      { label: "EN", nativeName: "English", bcp47: "en-GB" },
    ]);
  });
});

describe("message formatting", () => {
  it("interpolates named values", () => {
    expect(interpolate("Hello {name}", { name: "Ada" })).toBe("Hello Ada");
    expect(interpolate("{count} for {name}: {missing}", { count: 2, name: "$&" })).toBe(
      "2 for $&: {missing}",
    );
    expect(interpolate("No values")).toBe("No values");
    expect(translate(catalogs, "es", "greeting", { name: "Ada" })).toBe("Hola Ada");
  });

  it("selects locale-aware plural forms including zero", () => {
    expect(translate(catalogs, "fr", "records", { count: 0 })).toBe("Aucun bien");
    expect(translate(catalogs, "en", "records", { count: 1 })).toBe("1 property");
    expect(translate(catalogs, "en", "records", { count: "1" })).toBe("1 property");
    expect(translate(catalogs, "es", "records", { count: 4 })).toBe("4 propiedades");
  });

  it("falls back to the canonical French entry when a runtime catalog entry is absent", () => {
    const catalogsWithRuntimeGap = {
      ...catalogs,
      es: { ...catalogs.es, greeting: undefined },
    } as unknown as Record<LocaleCode, MessageCatalog<TestMessageId>>;

    expect(translate(catalogsWithRuntimeGap, "es", "greeting", { name: "Ada" })).toBe("Bonjour Ada");
  });

  it("translates typed descriptors without leaking technical details into UI copy", () => {
    expect(
      translateDescriptor(catalogs, "en", {
        id: "greeting",
        values: { name: "Ada" },
        technicalDetail: "internal diagnostic",
      }),
    ).toBe("Hello Ada");
  });
});

describe("Intl formatting", () => {
  it.each(SUPPORTED_LOCALES)("formats numbers with %s metadata and caller options", (locale) => {
    const options: Intl.NumberFormatOptions = { style: "currency", currency: "EUR" };

    expect(formatNumber(1_234.5, locale, options)).toBe(
      new Intl.NumberFormat(LOCALE_METADATA[locale].bcp47, options).format(1_234.5),
    );
  });

  it.each([
    new Date("2026-07-16T15:30:00.000Z"),
    Date.parse("2026-07-16T15:30:00.000Z"),
    "2026-07-16T15:30:00.000Z",
  ])("formats Date, timestamp and ISO inputs deterministically", (value) => {
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    };

    expect(formatDateTime(value, "en", options)).toBe(
      new Intl.DateTimeFormat("en-GB", options).format(new Date(value)),
    );
  });

  it.each(SUPPORTED_LOCALES)("formats readonly lists with %s conjunction rules", (locale) => {
    const values = ["Rennes", "Brest", "Quimper"] as const;
    const options: Intl.ListFormatOptions = { style: "long", type: "conjunction" };

    expect(formatList(values, locale, options)).toBe(
      new Intl.ListFormat(LOCALE_METADATA[locale].bcp47, options).format(values),
    );
  });
});
