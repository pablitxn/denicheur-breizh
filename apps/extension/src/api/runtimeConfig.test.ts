import { describe, expect, it } from "vitest";
import {
  clearRuntimeApiConfig,
  DEFAULT_API_BASE_URL,
  loadRuntimeApiConfig,
  normalizeAllowedApiBaseUrl,
  PRODUCTION_API_BASE_URL,
  RUNTIME_API_STORAGE_KEYS,
  saveRuntimeApiConfig,
  type RuntimeConfigStorage,
  withOperatorAuthorization,
} from "./runtimeConfig";

function memoryStorage(seed: Record<string, unknown> = {}) {
  const values = { ...seed };
  const storage: RuntimeConfigStorage = {
    get(keys, callback) {
      callback(Object.fromEntries(keys.map((key) => [key, values[key]])));
    },
    set(patch, callback) {
      Object.assign(values, patch);
      callback();
    },
    remove(keys, callback) {
      for (const key of keys) delete values[key];
      callback();
    },
  };
  return { storage, values };
}

describe("runtime API configuration", () => {
  it("accepts only HTTP loopback URLs and the exact production HTTPS base", () => {
    expect(normalizeAllowedApiBaseUrl("http://127.0.0.1:4310/")).toBe(DEFAULT_API_BASE_URL);
    expect(normalizeAllowedApiBaseUrl("http://localhost:14310/api/")).toBe("http://localhost:14310/api");
    expect(normalizeAllowedApiBaseUrl(`${PRODUCTION_API_BASE_URL}/`)).toBe(PRODUCTION_API_BASE_URL);

    for (const rejected of [
      "https://example.com/api",
      "http://denicheur-breizh.orchid-labs.xyz/api",
      "https://denicheur-breizh.orchid-labs.xyz/other",
      "https://denicheur-breizh.orchid-labs.xyz:444/api",
      "http://localhost.evil.test:4310",
      "http://operator:secret@localhost:4310",
      "http://localhost:4310?token=secret",
    ]) {
      expect(() => normalizeAllowedApiBaseUrl(rejected)).toThrow();
    }
  });

  it("persists the URL and token only in the injected local storage area", async () => {
    const { storage, values } = memoryStorage();

    await expect(saveRuntimeApiConfig({
      baseUrl: PRODUCTION_API_BASE_URL,
      operatorToken: "  operator-secret  ",
    }, storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      operatorToken: "operator-secret",
    });
    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      operatorToken: "operator-secret",
    });

    await clearRuntimeApiConfig(storage);
    expect(values).toEqual({});
    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({ baseUrl: DEFAULT_API_BASE_URL });
  });

  it("falls back to loopback when a stored URL was manually corrupted", async () => {
    const { storage } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: "https://attacker.invalid/api",
      [RUNTIME_API_STORAGE_KEYS.operatorToken]: "operator-secret",
    });

    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
    });
  });

  it("adds a bearer token without replacing existing request headers", () => {
    const headers = withOperatorAuthorization({
      "Content-Type": "application/json",
      "Idempotency-Key": "operation-1",
    }, "operator-secret");

    expect(headers.Authorization).toBe("Bearer operator-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("operation-1");
    expect(withOperatorAuthorization({}, undefined)).not.toHaveProperty("Authorization");
  });
});
