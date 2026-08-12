import { describe, expect, it } from "vitest";
import { resolveApiBaseUrl } from "./apiBaseUrl";

describe("resolveApiBaseUrl", () => {
  it("keeps the direct loopback API for local Vite development", () => {
    expect(resolveApiBaseUrl(undefined, { development: true })).toBe("http://127.0.0.1:4310");
  });

  it("defaults production bundles to the same-origin gateway", () => {
    expect(resolveApiBaseUrl(undefined, { development: false })).toBe("/api");
    expect(resolveApiBaseUrl(" /api/ ", { development: false })).toBe("/api");
  });

  it("preserves the explicit loopback URL used by the isolated E2E bundle", () => {
    expect(resolveApiBaseUrl("http://127.0.0.1:14310", { development: false }))
      .toBe("http://127.0.0.1:14310");
  });

  it.each([
    "//attacker.example/api",
    "https://user:password@example.com/api",
    "https://example.com/api?token=bad",
    "javascript:alert(1)",
  ])("rejects an unsafe API base: %s", (candidate) => {
    expect(() => resolveApiBaseUrl(candidate, { development: false })).toThrow(/VITE_API_BASE_URL/);
  });
});
