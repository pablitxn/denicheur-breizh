export const PRODUCTION_API_BASE_URL = "https://denicheur-breizh.orchid-labs.xyz/api";
const LOCAL_DEFAULT_API_BASE_URL = "http://127.0.0.1:4310";
const LOCAL_API_HOSTS = new Set(["127.0.0.1", "localhost"]);
export const DEFAULT_API_BASE_URL = normalizeAllowedApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL || LOCAL_DEFAULT_API_BASE_URL,
);

export const RUNTIME_API_STORAGE_KEYS = {
  baseUrl: "denicheur:runtime-api-base-url",
  credential: "denicheur:runtime-api-credential",
  legacyOperatorToken: "denicheur:runtime-operator-token",
} as const;

export interface RuntimeApiCredential {
  endpoint: string;
  token: string;
}

export type RuntimeApiConfig = {
  baseUrl: string;
  credential?: undefined;
} | {
  baseUrl: string;
  credential: RuntimeApiCredential;
};

export interface RuntimeApiConfigInput {
  baseUrl: string;
  operatorToken?: string;
}

export interface RuntimeConfigStorage {
  get(keys: string[], callback: (values: Record<string, unknown>) => void): void;
  set(values: Record<string, unknown>, callback: () => void): void;
  remove(keys: string[], callback: () => void): void;
}

export function normalizeAllowedApiBaseUrl(value: string): string {
  const candidate = value.trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("The API URL is invalid.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The API URL cannot contain credentials, a query, or a fragment.");
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const isLocalHttp = url.protocol === "http:" && LOCAL_API_HOSTS.has(url.hostname);
  const isExactProduction = url.protocol === "https:" &&
    url.hostname === "denicheur-breizh.orchid-labs.xyz" &&
    url.port === "" &&
    normalizedPath === "/api";

  if (!isLocalHttp && !isExactProduction) {
    throw new Error("Use an HTTP localhost URL or the Denicheur Breizh production API URL.");
  }

  if (isExactProduction) return PRODUCTION_API_BASE_URL;
  return `${url.origin}${normalizedPath}`;
}

export async function loadRuntimeApiConfig(
  storage?: RuntimeConfigStorage,
): Promise<RuntimeApiConfig> {
  const area = resolveStorage(storage);
  if (!area) return { baseUrl: DEFAULT_API_BASE_URL };

  const values = await getStorage(area, Object.values(RUNTIME_API_STORAGE_KEYS));
  const rawBaseUrl = values[RUNTIME_API_STORAGE_KEYS.baseUrl];
  const storedBaseUrl = typeof rawBaseUrl === "string"
    ? rawBaseUrl
    : undefined;

  let baseUrl = DEFAULT_API_BASE_URL;
  let storedBaseUrlIsAllowed = false;
  if (storedBaseUrl) {
    try {
      baseUrl = normalizeAllowedApiBaseUrl(storedBaseUrl);
      storedBaseUrlIsAllowed = true;
    } catch {
      // Fail closed to loopback without forwarding a token if storage is corrupted.
    }
  }

  const credential = parseStoredCredential(values[RUNTIME_API_STORAGE_KEYS.credential]);
  const rawLegacyToken = values[RUNTIME_API_STORAGE_KEYS.legacyOperatorToken];
  if (rawLegacyToken !== undefined) {
    await removeStorage(area, [RUNTIME_API_STORAGE_KEYS.legacyOperatorToken]);
  }

  return {
    baseUrl,
    ...(storedBaseUrlIsAllowed && credential?.endpoint === baseUrl ? { credential } : {}),
  };
}

export async function resolveRuntimeApiConfig(
  explicitBaseUrl?: string,
  storage?: RuntimeConfigStorage,
): Promise<RuntimeApiConfig> {
  const config = await loadRuntimeApiConfig(storage);
  if (!explicitBaseUrl) return config;

  const baseUrl = normalizeAllowedApiBaseUrl(explicitBaseUrl);
  return config.credential?.endpoint === baseUrl
    ? { baseUrl, credential: config.credential }
    : { baseUrl };
}

export async function saveRuntimeApiConfig(
  config: RuntimeApiConfigInput,
  storage?: RuntimeConfigStorage,
): Promise<RuntimeApiConfig> {
  const area = requireStorage(storage);
  const baseUrl = normalizeAllowedApiBaseUrl(config.baseUrl);
  const operatorToken = config.operatorToken?.trim() ?? "";
  const credential = operatorToken
    ? { endpoint: baseUrl, token: operatorToken }
    : undefined;

  if (!credential) {
    await removeStorage(area, [
      RUNTIME_API_STORAGE_KEYS.credential,
      RUNTIME_API_STORAGE_KEYS.legacyOperatorToken,
    ]);
    await setStorage(area, { [RUNTIME_API_STORAGE_KEYS.baseUrl]: baseUrl });
    return { baseUrl };
  }

  await setStorage(area, {
    [RUNTIME_API_STORAGE_KEYS.baseUrl]: baseUrl,
    [RUNTIME_API_STORAGE_KEYS.credential]: credential,
  });
  await removeStorage(area, [RUNTIME_API_STORAGE_KEYS.legacyOperatorToken]);
  return { baseUrl, credential };
}

export async function clearRuntimeApiConfig(storage?: RuntimeConfigStorage): Promise<void> {
  await removeStorage(requireStorage(storage), Object.values(RUNTIME_API_STORAGE_KEYS));
}

export function withOperatorAuthorization(
  headers: Record<string, string>,
  config: RuntimeApiConfig,
): Record<string, string> {
  const operatorToken = config.credential?.endpoint === config.baseUrl
    ? config.credential.token
    : undefined;
  return {
    ...headers,
    ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}),
  };
}

function parseStoredCredential(value: unknown): RuntimeApiCredential | undefined {
  if (!isRecord(value) || typeof value.endpoint !== "string" || typeof value.token !== "string") {
    return undefined;
  }

  const token = value.token.trim();
  if (!token) return undefined;
  try {
    return {
      endpoint: normalizeAllowedApiBaseUrl(value.endpoint),
      token,
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveStorage(storage?: RuntimeConfigStorage): RuntimeConfigStorage | undefined {
  if (storage) return storage;
  if (typeof chrome === "undefined" || !chrome.storage?.local) return undefined;
  return chrome.storage.local;
}

function requireStorage(storage?: RuntimeConfigStorage): RuntimeConfigStorage {
  const area = resolveStorage(storage);
  if (!area) throw new Error("Chrome local storage is unavailable.");
  return area;
}

function getStorage(
  storage: RuntimeConfigStorage,
  keys: string[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    storage.get(keys, (values) => {
      const error = runtimeError();
      if (error) reject(new Error(error));
      else resolve(values);
    });
  });
}

function setStorage(storage: RuntimeConfigStorage, values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.set(values, () => {
      const error = runtimeError();
      if (error) reject(new Error(error));
      else resolve();
    });
  });
}

function removeStorage(storage: RuntimeConfigStorage, keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    storage.remove(keys, () => {
      const error = runtimeError();
      if (error) reject(new Error(error));
      else resolve();
    });
  });
}

function runtimeError(): string | undefined {
  if (typeof chrome === "undefined") return undefined;
  return chrome.runtime?.lastError?.message;
}
