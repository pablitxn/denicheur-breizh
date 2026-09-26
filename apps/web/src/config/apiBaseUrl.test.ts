import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiBaseUrl } from "./apiBaseUrl";

afterEach(() => vi.unstubAllEnvs());

describe("resolveApiBaseUrl", () => {
  it("keeps the direct loopback API for local Vite development", () => {
    expect(resolveApiBaseUrl(undefined, { development: true })).toBe("http://127.0.0.1:4310");
  });

  it("defaults production bundles to the same-origin gateway", () => {
    expect(resolveApiBaseUrl(undefined, { development: false })).toBe("/api");
    expect(resolveApiBaseUrl(" /api/ ", { development: false })).toBe("/api");
  });

  it("cannot enable the development fallback in a production environment", () => {
    vi.stubEnv("DEV", false);
    expect(resolveApiBaseUrl(undefined, { development: true })).toBe("/api");
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
