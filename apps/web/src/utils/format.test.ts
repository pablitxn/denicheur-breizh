import { describe, expect, it } from "vitest";
import { formatPostedDays, formatPrice, formatPricePerM2, formatPropertyCount, formatRooms, percentDelta } from "./format";

describe("format utilities", () => {
  it("formats property prices in French compact thousands", () => {
    expect(formatPrice(264000)).toBe("264 k€");
    expect(formatPrice(1250000)).toBe("1,3 M€");
  });

  it("formats price per square meter", () => {
    expect(formatPricePerM2(264000, 96).replace(/\s/g, " ")).toBe("2 750 €/m²");
  });

  it("formats listing recency", () => {
    expect(formatPostedDays(1)).toBe("il y a 1 jour");
    expect(formatPostedDays(4)).toBe("il y a 4 jours");
    expect(formatPostedDays(1, "es")).toBe("hace 1 día");
    expect(formatPostedDays(4, "es")).toBe("hace 4 días");
  });

  it("formats locale-specific UI counts", () => {
    expect(formatRooms(1)).toBe("1 pièce");
    expect(formatRooms(4, "es")).toBe("4 habitaciones");
    expect(formatPropertyCount(1)).toBe("1 bien");
    expect(formatPropertyCount(3, "es")).toBe("3 propiedades");
  });

  it("computes percentage deltas", () => {
    expect(percentDelta(90, 100)).toBe(-10);
    expect(percentDelta(112, 100)).toBe(12);
  });
});
