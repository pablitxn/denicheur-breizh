import { describe, expect, it } from "vitest";
import {
  formatDecimal,
  formatDistanceKm,
  formatPercentage,
  formatPostedDays,
  formatPrice,
  formatPricePerM2,
  formatPropertyCount,
  formatRooms,
  percentDelta,
} from "./format";

describe("format utilities", () => {
  it("formats property prices in French compact thousands", () => {
    expect(formatPrice(264000)).toBe("264 k€");
    expect(formatPrice(1250000)).toBe("1,3 M€");
    expect(formatPrice(1250000, "en")).toBe("1.3 M€");
  });

  it("formats price per square meter", () => {
    expect(formatPricePerM2(264000, 96).replace(/\s/g, " ")).toBe("2 750 €/m²");
  });

  it("formats listing recency", () => {
    expect(formatPostedDays(1)).toBe("il y a 1 jour");
    expect(formatPostedDays(4)).toBe("il y a 4 jours");
    expect(formatPostedDays(1, "es")).toBe("hace 1 día");
    expect(formatPostedDays(4, "es")).toBe("hace 4 días");
    expect(formatPostedDays(0, "en")).toBe("today");
    expect(formatPostedDays(4, "en")).toBe("4 days ago");
  });

  it("formats locale-specific UI counts", () => {
    expect(formatRooms(1)).toBe("1 pièce");
    expect(formatRooms(4, "es")).toBe("4 habitaciones");
    expect(formatPropertyCount(1)).toBe("1 bien");
    expect(formatPropertyCount(3, "es")).toBe("3 propiedades");
    expect(formatRooms(1, "en")).toBe("1 room");
    expect(formatPropertyCount(3, "en")).toBe("3 properties");
  });

  it("formats decimals, distances and percentages with locale conventions", () => {
    expect(formatDecimal(8.2, "fr")).toBe("8,2");
    expect(formatDecimal(8.2, "en")).toBe("8.2");
    expect(formatDistanceKm(0.8, "es")).toBe("0,8 km");
    expect(formatPercentage(12, "fr").replace(/\s/g, " ")).toBe("+12 %");
    expect(formatPercentage(-18, "en")).toBe("-18%");
  });

  it("computes percentage deltas", () => {
    expect(percentDelta(90, 100)).toBe(-10);
    expect(percentDelta(112, 100)).toBe(12);
  });
});
