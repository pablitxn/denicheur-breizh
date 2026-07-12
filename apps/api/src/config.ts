import { z } from "zod";

export const DEFAULT_FILTER_MODEL = "gpt-5-mini-2025-08-07";
export const FILTER_API_HOST = "127.0.0.1";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi",
];

const envSchema = z.object({
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_FILTER_MODEL: z.string().trim().min(1).max(128).default(DEFAULT_FILTER_MODEL),
  FILTER_API_PORT: z.preprocess(
    (value) => (value === undefined || value === "" ? 4310 : value),
    z.coerce.number().int().min(1).max(65_535),
  ),
  FILTER_API_ALLOWED_ORIGINS: z.string().optional(),
});

export interface ApiConfig {
  readonly host: typeof FILTER_API_HOST;
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly openAiApiKey: string | undefined;
  readonly openAiModel: string;
  readonly evaluatorVersion: string;
  readonly requestBodyLimit: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly openAiTimeoutMs: number;
  readonly openAiMaxRetries: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(environment);
  const configuredOrigins = parsed.FILTER_API_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const rawOrigins = configuredOrigins?.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
  const origins = rawOrigins.map(normalizeSafeLocalOrigin);

  return {
    host: FILTER_API_HOST,
    port: parsed.FILTER_API_PORT,
    allowedOrigins: new Set(origins),
    openAiApiKey: parsed.OPENAI_API_KEY,
    openAiModel: parsed.OPENAI_FILTER_MODEL,
    evaluatorVersion: "1.0.0",
    requestBodyLimit: "256kb",
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    openAiTimeoutMs: 30_000,
    openAiMaxRetries: 1,
  };
}

function normalizeSafeLocalOrigin(origin: string): string {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    throw new Error(`FILTER_API_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
  }

  const hasOnlyOriginComponents =
    (url.pathname === "" || url.pathname === "/") && !url.search && !url.hash && !url.username && !url.password;
  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  const isChromeExtension = isChromeExtensionOrigin(origin);

  if (!hasOnlyOriginComponents || (!isLocalHttp && !isChromeExtension)) {
    throw new Error(
      `FILTER_API_ALLOWED_ORIGINS only accepts localhost HTTP origins or exact Chrome extension origins: ${origin}`,
    );
  }

  return isChromeExtension ? `chrome-extension://${url.hostname}` : url.origin;
}

export function isChromeExtensionOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "chrome-extension:" &&
      /^[a-p]{32}$/.test(url.hostname) &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
