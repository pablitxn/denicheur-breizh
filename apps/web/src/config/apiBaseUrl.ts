const LOCAL_API_BASE_URL = "http://127.0.0.1:4310";
const PRODUCTION_API_BASE_URL = "/api";

interface ApiBaseUrlOptions {
  development: boolean;
}

export function resolveApiBaseUrl(
  configuredValue: string | undefined,
  { development }: ApiBaseUrlOptions,
): string {
  const configured = configuredValue?.trim();
  if (!configured) return development ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL;

  const normalized = configured.replace(/\/+$/, "");
  if (normalized.startsWith("/")) {
    if (!normalized.startsWith("//") && !normalized.includes("?") && !normalized.includes("#")) return normalized;
    throw new Error("VITE_API_BASE_URL must be a same-origin path or an absolute HTTP(S) URL.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("VITE_API_BASE_URL must be a same-origin path or an absolute HTTP(S) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_API_BASE_URL must be a credential-free HTTP(S) URL without a query or fragment.");
  }
  return normalized;
}

export const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, {
  development: import.meta.env.DEV,
});
