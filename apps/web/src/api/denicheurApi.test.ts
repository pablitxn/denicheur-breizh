import { afterEach, describe, expect, it, vi } from "vitest";
import { denicheurApi } from "./denicheurApi";

afterEach(() => {
  vi.useRealTimers();
});

describe("denicheurApi property filters", () => {
  it("treats an explicitly empty provider or property-type selection as no results", async () => {
    await expect(denicheurApi.listProperties({ providers: [] })).resolves.toEqual([]);
    await expect(denicheurApi.listProperties({ propertyTypes: [] })).resolves.toEqual([]);
  });

  it("applies the selected property type in mock mode", async () => {
    vi.useFakeTimers();
    const request = denicheurApi.listProperties({ propertyTypes: ["apartment"] });
    await vi.advanceTimersByTimeAsync(120);
    const listings = await request;

    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((property) => property.propertyType === "apartment")).toBe(true);
  });
});
