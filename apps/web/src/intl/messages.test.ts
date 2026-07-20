import { describe, expect, it } from "vitest";
import { translate } from "@denicheur-breizh/i18n";
import { enMessages, esMessages, frMessages, messages } from "./messages";

describe("intl messages", () => {
  it("keeps all application catalogs aligned with canonical French", () => {
    expect(Object.keys(esMessages).sort()).toEqual(Object.keys(frMessages).sort());
    expect(Object.keys(enMessages).sort()).toEqual(Object.keys(frMessages).sort());
  });

  it("uses locale-aware plurals and interpolation", () => {
    expect(translate(messages, "fr", "properties.count", { count: 1 })).toBe("1 bien");
    expect(translate(messages, "es", "properties.count", { count: 2 })).toBe("2 propiedades");
    expect(translate(messages, "en", "properties.count", { count: 1 })).toBe("1 property");
    expect(translate(messages, "fr", "property.imageAlt", {
      index: 2,
      title: "Maison du port",
      total: 5,
    })).toBe("Photo 2 sur 5 : Maison du port");
  });
});
