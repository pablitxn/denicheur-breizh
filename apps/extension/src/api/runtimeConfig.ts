export const DEFAULT_API_BASE_URL = "http://127.0.0.1:4310";
export const PRODUCTION_API_BASE_URL = "https://denicheur-breizh.orchid-labs.xyz/api";

export const RUNTIME_API_STORAGE_KEYS = {
  baseUrl: "denicheur:runtime-api-base-url",
  operatorToken: "denicheur:runtime-operator-token",
} as const;

const LOCAL_API_HOSTS = new Set(["127.0.0.1", "localhost"]);

export interface RuntimeApiConfig {
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
  const rawToken = values[RUNTIME_API_STORAGE_KEYS.operatorToken];
  const storedBaseUrl = typeof rawBaseUrl === "string"
    ? rawBaseUrl
    : undefined;
  const storedToken = typeof rawToken === "string"
    ? rawToken.trim()
    : "";

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

  return {
    baseUrl,
    ...(storedToken && storedBaseUrlIsAllowed ? { operatorToken: storedToken } : {}),
  };
}

export async function resolveRuntimeApiConfig(
  explicitBaseUrl?: string,
  storage?: RuntimeConfigStorage,
): Promise<RuntimeApiConfig> {
  const config = await loadRuntimeApiConfig(storage);
  return {
    ...config,
    baseUrl: explicitBaseUrl
      ? normalizeAllowedApiBaseUrl(explicitBaseUrl)
      : config.baseUrl,
  };
}

export async function saveRuntimeApiConfig(
  config: RuntimeApiConfig,
  storage?: RuntimeConfigStorage,
): Promise<RuntimeApiConfig> {
  const area = requireStorage(storage);
  const baseUrl = normalizeAllowedApiBaseUrl(config.baseUrl);
  const operatorToken = config.operatorToken?.trim() ?? "";

  await setStorage(area, {
    [RUNTIME_API_STORAGE_KEYS.baseUrl]: baseUrl,
    ...(operatorToken ? { [RUNTIME_API_STORAGE_KEYS.operatorToken]: operatorToken } : {}),
  });
  if (!operatorToken) {
    await removeStorage(area, [RUNTIME_API_STORAGE_KEYS.operatorToken]);
  }

  return {
    baseUrl,
    ...(operatorToken ? { operatorToken } : {}),
  };
}

export async function clearRuntimeApiConfig(storage?: RuntimeConfigStorage): Promise<void> {
  await removeStorage(requireStorage(storage), Object.values(RUNTIME_API_STORAGE_KEYS));
}

export function withOperatorAuthorization(
  headers: Record<string, string>,
  operatorToken?: string,
): Record<string, string> {
  return {
    ...headers,
    ...(operatorToken ? { Authorization: `Bearer ${operatorToken}` } : {}),
  };
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
