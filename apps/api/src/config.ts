import { z } from "zod";

import type { EvaluationBudgetPolicy } from "./evaluationBudget.js";
import type { GlobalProviderBudgetPolicy } from "./globalProviderBudget.js";
import type { MediaAdmissionPolicy } from "./repository.js";

export const DEFAULT_FILTER_MODEL = "gpt-5-mini-2025-08-07";
export const FILTER_API_HOST = "127.0.0.1";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi",
];

const integerEnvironment = (defaultValue: number, minimum = 1) => z.preprocess(
  (value) => (value === undefined || value === "" ? defaultValue : value),
  z.coerce.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER),
);

const optionalIntegerEnvironment = z.preprocess(
  (value) => (value === undefined || value === "" ? undefined : value),
  z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_REPLICA_COUNT: optionalIntegerEnvironment,
  OPERATOR_TOKEN: z.string().trim().min(32).max(512).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_FILTER_MODEL: z.string().trim().min(1).max(128)
    .refine((model) => !model.startsWith("ft:"), {
      message: "Fine-tuned models are not supported by the strict evaluation schema.",
    })
    .default(DEFAULT_FILTER_MODEL),
  OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS: integerEnvironment(0, 0),
  OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS: integerEnvironment(0, 0),
  OPENAI_GLOBAL_BUDGET_WINDOW_MS: integerEnvironment(60_000),
  OPENAI_GLOBAL_MAX_PROVIDER_CALLS: integerEnvironment(200),
  OPENAI_GLOBAL_MAX_INPUT_TOKENS: integerEnvironment(1_000_000),
  OPENAI_GLOBAL_MAX_OUTPUT_TOKENS: integerEnvironment(1_000_000),
  OPENAI_GLOBAL_MAX_COST_MICRO_USD: integerEnvironment(3_000_000),
  OPENAI_REALTIME_ENABLED: z.enum(["true", "false"]).default("false"),
  EVALUATION_MAX_PROVIDER_CALLS: integerEnvironment(200),
  EVALUATION_MAX_INPUT_TOKENS: integerEnvironment(1_000_000),
  EVALUATION_MAX_OUTPUT_TOKENS: integerEnvironment(1_000_000),
  EVALUATION_MAX_COST_MICRO_USD: integerEnvironment(3_000_000),
  FILTER_API_PORT: z.preprocess(
    (value) => (value === undefined || value === "" ? 4310 : value),
    z.coerce.number().int().min(1).max(65_535),
  ),
  FILTER_API_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default(FILTER_API_HOST),
  FILTER_API_ALLOWED_ORIGINS: z.string().optional(),
  DENICHEUR_DB_PATH: z.string().trim().min(1).default(".data/denicheur.sqlite"),
  MEDIA_STORAGE_MODE: z.enum(["disabled", "minio"]).default("disabled"),
  MEDIA_S3_ENDPOINT: z.string().trim().url().max(2_048)
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "MEDIA_S3_ENDPOINT must use HTTP or HTTPS.",
    })
    .optional(),
  MEDIA_S3_BUCKET: z.string().trim().min(3).max(63).optional(),
  MEDIA_S3_REGION: z.string().trim().min(1).max(128).optional(),
  MEDIA_S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  MEDIA_S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  MEDIA_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true"),
  MEDIA_MAX_ASSETS_PER_RUN: integerEnvironment(500),
  MEDIA_MAX_PENDING_JOBS: integerEnvironment(1_000),
  MEDIA_MAX_RESERVED_BYTES: integerEnvironment(5 * 1024 * 1024 * 1024),
  MEDIA_RESERVED_BYTES_PER_ASSET: integerEnvironment(20 * 1024 * 1024),
  MEDIA_DELIVERY_RATE_LIMIT_MAX: integerEnvironment(120),
  MEDIA_DELIVERY_MAX_CONCURRENT: integerEnvironment(8),
  MEDIA_DELIVERY_MAX_BYTES_PER_MINUTE: integerEnvironment(256 * 1024 * 1024),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.OPERATOR_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["OPERATOR_TOKEN"],
      message: "OPERATOR_TOKEN is required in production.",
    });
  }
  if (environment.NODE_ENV === "production" && environment.MEDIA_STORAGE_MODE !== "minio") {
    context.addIssue({
      code: "custom",
      path: ["MEDIA_STORAGE_MODE"],
      message: "MEDIA_STORAGE_MODE=minio is required in production.",
    });
  }
  if (environment.NODE_ENV === "production" && environment.API_REPLICA_COUNT !== 1) {
    context.addIssue({
      code: "custom",
      path: ["API_REPLICA_COUNT"],
      message: environment.API_REPLICA_COUNT === undefined
        ? "API_REPLICA_COUNT=1 must be set explicitly in production."
        : "Production supports a single API replica; API_REPLICA_COUNT must equal 1.",
    });
  }
  if (environment.NODE_ENV === "production" && environment.DENICHEUR_DB_PATH === ":memory:") {
    context.addIssue({
      code: "custom",
      path: ["DENICHEUR_DB_PATH"],
      message: "DENICHEUR_DB_PATH must use persistent storage in production; :memory: resets provider budgets.",
    });
  }
  if (environment.NODE_ENV === "production" && environment.OPENAI_REALTIME_ENABLED === "true") {
    context.addIssue({
      code: "custom",
      path: ["OPENAI_REALTIME_ENABLED"],
      message: "OpenAI Realtime is disabled in production because session usage cannot be metered by this API.",
    });
  }
  if (
    environment.NODE_ENV === "production"
    && environment.MEDIA_S3_ENDPOINT
    && new URL(environment.MEDIA_S3_ENDPOINT).protocol !== "https:"
  ) {
    context.addIssue({
      code: "custom",
      path: ["MEDIA_S3_ENDPOINT"],
      message: "MEDIA_S3_ENDPOINT must use HTTPS in production.",
    });
  }
  if (
    environment.NODE_ENV === "production"
    && environment.OPENAI_API_KEY
    && (
      environment.OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS === 0
      || environment.OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS === 0
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS"],
      message: "Production OpenAI usage requires explicit non-zero input and output token prices.",
    });
  }
  if (environment.MEDIA_RESERVED_BYTES_PER_ASSET > environment.MEDIA_MAX_RESERVED_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["MEDIA_RESERVED_BYTES_PER_ASSET"],
      message: "MEDIA_RESERVED_BYTES_PER_ASSET cannot exceed MEDIA_MAX_RESERVED_BYTES.",
    });
  }
  if (environment.MEDIA_STORAGE_MODE !== "minio") return;
  const required = [
    "MEDIA_S3_ENDPOINT",
    "MEDIA_S3_BUCKET",
    "MEDIA_S3_REGION",
    "MEDIA_S3_ACCESS_KEY_ID",
    "MEDIA_S3_SECRET_ACCESS_KEY",
  ] as const;
  for (const key of required) {
    if (!environment[key]) {
      context.addIssue({ code: "custom", path: [key], message: `${key} is required when MEDIA_STORAGE_MODE=minio.` });
    }
  }
});

export interface MediaConfig {
  readonly mode: "disabled" | "minio";
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly region?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly forcePathStyle: boolean;
  readonly workerConcurrency: 2;
  readonly admission: MediaAdmissionPolicy;
  readonly deliveryRateLimitMax: number;
  readonly deliveryMaxConcurrent: number;
  readonly deliveryMaxBytesPerWindow: number;
  readonly deliveryWindowMs: 60_000;
}

export interface ApiConfig {
  readonly replicaCount: number;
  readonly host: "127.0.0.1" | "0.0.0.0";
  readonly port: number;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly operatorToken: string | undefined;
  readonly openAiApiKey: string | undefined;
  readonly realtimeEnabled: boolean;
  readonly databasePath: string;
  readonly openAiModel: string;
  readonly evaluatorVersion: string;
  readonly requestBodyLimit: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly openAiTimeoutMs: number;
  readonly evaluationBudget: EvaluationBudgetPolicy;
  readonly openAiGlobalBudget: GlobalProviderBudgetPolicy;
  readonly media: MediaConfig;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.parse(environment);
  const configuredOrigins = parsed.FILTER_API_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const rawOrigins = configuredOrigins?.length ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
  const origins = rawOrigins.map(normalizeSafeLocalOrigin);

  return {
    replicaCount: parsed.API_REPLICA_COUNT ?? 1,
    host: parsed.FILTER_API_HOST,
    port: parsed.FILTER_API_PORT,
    allowedOrigins: new Set(origins),
    operatorToken: parsed.OPERATOR_TOKEN,
    openAiApiKey: parsed.OPENAI_API_KEY,
    realtimeEnabled: parsed.OPENAI_REALTIME_ENABLED === "true",
    databasePath: parsed.DENICHEUR_DB_PATH,
    openAiModel: parsed.OPENAI_FILTER_MODEL,
    evaluatorVersion: "3.0.0",
    requestBodyLimit: "256kb",
    rateLimitMax: 30,
    rateLimitWindowMs: 60_000,
    openAiTimeoutMs: 60_000,
    evaluationBudget: {
      maxProviderCalls: parsed.EVALUATION_MAX_PROVIDER_CALLS,
      maxInputTokens: parsed.EVALUATION_MAX_INPUT_TOKENS,
      maxOutputTokens: parsed.EVALUATION_MAX_OUTPUT_TOKENS,
      maxCostMicroUsd: parsed.EVALUATION_MAX_COST_MICRO_USD,
      inputPriceMicroUsdPerMillionTokens: parsed.OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS,
      outputPriceMicroUsdPerMillionTokens: parsed.OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS,
    },
    openAiGlobalBudget: {
      maxProviderCalls: parsed.OPENAI_GLOBAL_MAX_PROVIDER_CALLS,
      maxInputTokens: parsed.OPENAI_GLOBAL_MAX_INPUT_TOKENS,
      maxOutputTokens: parsed.OPENAI_GLOBAL_MAX_OUTPUT_TOKENS,
      maxCostMicroUsd: parsed.OPENAI_GLOBAL_MAX_COST_MICRO_USD,
      inputPriceMicroUsdPerMillionTokens: parsed.OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS,
      outputPriceMicroUsdPerMillionTokens: parsed.OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS,
      windowMs: parsed.OPENAI_GLOBAL_BUDGET_WINDOW_MS,
    },
    media: {
      mode: parsed.MEDIA_STORAGE_MODE,
      ...(parsed.MEDIA_S3_ENDPOINT ? { endpoint: parsed.MEDIA_S3_ENDPOINT } : {}),
      ...(parsed.MEDIA_S3_BUCKET ? { bucket: parsed.MEDIA_S3_BUCKET } : {}),
      ...(parsed.MEDIA_S3_REGION ? { region: parsed.MEDIA_S3_REGION } : {}),
      ...(parsed.MEDIA_S3_ACCESS_KEY_ID ? { accessKeyId: parsed.MEDIA_S3_ACCESS_KEY_ID } : {}),
      ...(parsed.MEDIA_S3_SECRET_ACCESS_KEY ? { secretAccessKey: parsed.MEDIA_S3_SECRET_ACCESS_KEY } : {}),
      forcePathStyle: parsed.MEDIA_S3_FORCE_PATH_STYLE === "true",
      workerConcurrency: 2,
      admission: {
        maxAssetsPerRun: parsed.MEDIA_MAX_ASSETS_PER_RUN,
        maxPendingJobs: parsed.MEDIA_MAX_PENDING_JOBS,
        maxReservedBytes: parsed.MEDIA_MAX_RESERVED_BYTES,
        reservedBytesPerAsset: parsed.MEDIA_RESERVED_BYTES_PER_ASSET,
      },
      deliveryRateLimitMax: parsed.MEDIA_DELIVERY_RATE_LIMIT_MAX,
      deliveryMaxConcurrent: parsed.MEDIA_DELIVERY_MAX_CONCURRENT,
      deliveryMaxBytesPerWindow: parsed.MEDIA_DELIVERY_MAX_BYTES_PER_MINUTE,
      deliveryWindowMs: 60_000,
    },
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
