import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSearchFilters } from "../lib/leboncoinSearch";
import {
  enCatalog,
  esCatalog,
  EXTENSION_LOCALE_STORAGE_KEY,
  extensionCatalogs,
  filterWarningFieldLabel,
  frCatalog,
  loadExtensionLocale,
  resolveLocalizedText,
  resolvePreferredLocale,
  localeDisplayName,
  translateExtension,
  translateFilterValidationIssue,
  translateLegacyText,
} from ".";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension locale resolution", () => {
  it("prefers stored locale, then browser UI, then navigator, then French", () => {
    expect(resolvePreferredLocale("es", "en-US", ["fr-FR"])).toBe("es");
    expect(resolvePreferredLocale(undefined, "en-US", ["es-ES"])).toBe("en");
    expect(resolvePreferredLocale(undefined, "de-DE", ["es-MX", "en-US"])).toBe("es");
    expect(resolvePreferredLocale(undefined, "de-DE", ["it-IT"])).toBe("fr");
  });

  it("normalizes regional and underscore browser locale strings", () => {
    expect(resolvePreferredLocale("fr_CA", "es-ES")).toBe("fr");
    expect(resolvePreferredLocale(undefined, "es-AR")).toBe("es");
    expect(resolvePreferredLocale(undefined, "en_GB")).toBe("en");
  });

  it("loads the persisted extension preference before the browser UI locale", async () => {
    const get = vi.fn(async () => ({ [EXTENSION_LOCALE_STORAGE_KEY]: "es" }));
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "en-US" },
      storage: { local: { get } },
    });

    await expect(loadExtensionLocale()).resolves.toBe("es");
    expect(get).toHaveBeenCalledWith(EXTENSION_LOCALE_STORAGE_KEY);
  });
});

describe("extension catalogs", () => {
  it("keeps exact FR, ES and EN key parity", () => {
    const canonicalKeys = Object.keys(frCatalog).sort();
    expect(Object.keys(esCatalog).sort()).toEqual(canonicalKeys);
    expect(Object.keys(enCatalog).sort()).toEqual(canonicalKeys);
    expect(Object.keys(extensionCatalogs)).toEqual(["fr", "es", "en"]);
  });

  it("interpolates and pluralizes UI messages", () => {
    expect(translateExtension("es", "popup.records", { count: 1 })).toBe("1 anuncio");
    expect(translateExtension("es", "popup.records", { count: 3 })).toBe("3 anuncios");
    expect(translateExtension("en", "run.openingListing", { current: 2, total: 5 }))
      .toBe("Opening listing 2 of 5.");
  });
});

describe("localized runtime messages", () => {
  const t = (id: Parameters<typeof translateExtension>[1], values?: Parameters<typeof translateExtension>[2]) =>
    translateExtension("es", id, values);

  it("renders stable descriptors and preserves their technical diagnostic", () => {
    expect(resolveLocalizedText({
      id: "error.apiUnavailable",
      technicalDetail: "ECONNREFUSED 127.0.0.1:4310",
    }, t)).toEqual({
      text: "La API inteligente no está disponible. Comprueba que el servicio local esté iniciado.",
      technicalDetail: "ECONNREFUSED 127.0.0.1:4310",
    });
  });

  it("wraps legacy diagnostics without losing their original text", () => {
    expect(resolveLocalizedText({
      id: "legacy.message",
      technicalDetail: "old stored diagnostic",
    }, t)).toEqual({
      text: "Diagnóstico heredado",
      technicalDetail: "old stored diagnostic",
    });
  });

  it("uses localized fallback copy for unknown descriptors and keeps the raw diagnosis as detail", () => {
    expect(resolveLocalizedText({
      id: "vendor.timeout",
      technicalDetail: "socket closed",
    }, t)).toEqual({
      text: "No se pudo localizar un diagnóstico externo.",
      technicalDetail: "socket closed",
    });
  });

  it("localizes evaluation languages and persisted warning field identifiers", () => {
    expect(localeDisplayName("fr", t)).toBe("francés");
    expect(localeDisplayName("en", t)).toBe("inglés");
    expect(filterWarningFieldLabel("ownerType", t)).toBe("Vendedor");
    expect(filterWarningFieldLabel("detail:3007106066", t)).toBe("Detalle del anuncio 3007106066");
    expect(filterWarningFieldLabel("futureField", t)).toBe("Otro filtro");
  });

  it("localizes known legacy runtime strings and leaves unknown source diagnostics intact", () => {
    expect(translateLegacyText("Opening listing 2 of 4.", t)).toBe("Abriendo anuncio 2 de 4.");
    expect(translateLegacyText("opaque external diagnostic", t)).toBe("opaque external diagnostic");
  });

  it("localizes deterministic filter validation", () => {
    const filters = { ...createDefaultSearchFilters(), roomsMin: 9 };
    const issue = {
      field: "roomsMin" as const,
      message: "Minimum rooms must be an integer between 1 and 8.",
    };
    expect(translateFilterValidationIssue(issue, filters, t))
      .toBe("Estancias mínimas debe ser un entero entre 1 y 8.");
  });
});
