import { describe, expect, it } from "vitest";
import {
  clearRuntimeApiConfig,
  DEFAULT_API_BASE_URL,
  loadRuntimeApiConfig,
  normalizeAllowedApiBaseUrl,
  PRODUCTION_API_BASE_URL,
  resolveRuntimeApiConfig,
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

  it("persists the token as a credential bound to the normalized endpoint", async () => {
    const { storage, values } = memoryStorage();

    await expect(saveRuntimeApiConfig({
      baseUrl: `${PRODUCTION_API_BASE_URL}/`,
      operatorToken: "  operator-secret  ",
    }, storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      credential: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    });
    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      credential: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    });
    expect(values).toEqual({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: PRODUCTION_API_BASE_URL,
      [RUNTIME_API_STORAGE_KEYS.credential]: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    });

    await clearRuntimeApiConfig(storage);
    expect(values).toEqual({});
    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({ baseUrl: DEFAULT_API_BASE_URL });
  });

  it("discards a legacy production token instead of binding it to localhost", async () => {
    const { storage, values } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: DEFAULT_API_BASE_URL,
      [RUNTIME_API_STORAGE_KEYS.legacyOperatorToken]: "  production-operator-secret  ",
    });

    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
    });
    expect(values).toEqual({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: DEFAULT_API_BASE_URL,
    });
  });

  it("discards a legacy token even when the stored endpoint is production", async () => {
    const { storage, values } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: `${PRODUCTION_API_BASE_URL}/`,
      [RUNTIME_API_STORAGE_KEYS.legacyOperatorToken]: "  operator-secret  ",
    });

    await expect(loadRuntimeApiConfig(storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
    });
    expect(values).toEqual({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: `${PRODUCTION_API_BASE_URL}/`,
    });
  });

  it("never attaches a credential to a corrupted or different stored endpoint", async () => {
    const credential = {
      endpoint: PRODUCTION_API_BASE_URL,
      token: "operator-secret",
    };
    const { storage: corruptedStorage } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: "https://attacker.invalid/api",
      [RUNTIME_API_STORAGE_KEYS.credential]: credential,
    });
    const { storage: mismatchedStorage } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: DEFAULT_API_BASE_URL,
      [RUNTIME_API_STORAGE_KEYS.credential]: credential,
    });

    await expect(loadRuntimeApiConfig(corruptedStorage)).resolves.toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
    });
    await expect(loadRuntimeApiConfig(mismatchedStorage)).resolves.toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
    });
  });

  it("drops a stored credential for a different explicit endpoint override", async () => {
    const { storage } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: `${PRODUCTION_API_BASE_URL}/`,
      [RUNTIME_API_STORAGE_KEYS.credential]: {
        endpoint: `${PRODUCTION_API_BASE_URL}/`,
        token: "operator-secret",
      },
    });

    await expect(resolveRuntimeApiConfig(`${PRODUCTION_API_BASE_URL}/`, storage)).resolves.toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      credential: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    });
    await expect(resolveRuntimeApiConfig(DEFAULT_API_BASE_URL, storage)).resolves.toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
    });
  });

  it("preserves a local endpoint without a token and removes an old credential", async () => {
    const { storage, values } = memoryStorage({
      [RUNTIME_API_STORAGE_KEYS.baseUrl]: PRODUCTION_API_BASE_URL,
      [RUNTIME_API_STORAGE_KEYS.credential]: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    });

    await expect(saveRuntimeApiConfig({ baseUrl: `${DEFAULT_API_BASE_URL}/` }, storage))
      .resolves.toEqual({ baseUrl: DEFAULT_API_BASE_URL });
    expect(values).toEqual({ [RUNTIME_API_STORAGE_KEYS.baseUrl]: DEFAULT_API_BASE_URL });
  });

  it("adds a bearer token only for its bound endpoint without replacing other headers", () => {
    const config = {
      baseUrl: PRODUCTION_API_BASE_URL,
      credential: {
        endpoint: PRODUCTION_API_BASE_URL,
        token: "operator-secret",
      },
    };
    const headers = withOperatorAuthorization({
      "Content-Type": "application/json",
      "Idempotency-Key": "operation-1",
    }, config);

    expect(headers.Authorization).toBe("Bearer operator-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("operation-1");
    expect(withOperatorAuthorization({}, {
      baseUrl: DEFAULT_API_BASE_URL,
      credential: config.credential,
    })).not.toHaveProperty("Authorization");
    expect(withOperatorAuthorization({}, { baseUrl: DEFAULT_API_BASE_URL }))
      .not.toHaveProperty("Authorization");
  });
});
