import { describe, expect, it } from "vitest";

import { FILTER_API_HOST, isChromeExtensionOrigin, loadConfig } from "../src/config.js";

const VALID_EXTENSION_ORIGIN = "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi";

describe("loadConfig", () => {
  it("binds to loopback and allows only the pinned extension origin by default", () => {
    const config = loadConfig({});

    expect(config.host).toBe(FILTER_API_HOST);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4310);
    expect(config.databasePath).toBe(".data/denicheur.sqlite");
    expect(config.replicaCount).toBe(1);
    expect(config.evaluatorVersion).toBe("3.0.0");
    expect(config.openAiTimeoutMs).toBe(60_000);
    expect(config.realtimeEnabled).toBe(false);
    expect(config.openAiGlobalBudget).toMatchObject({
      maxProviderCalls: 200,
      windowMs: 60_000,
    });
    expect(config.allowedOrigins).toContain(VALID_EXTENSION_ORIGIN);
    expect(config.allowedOrigins).not.toContain("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("switches to exact-origin mode when an allowlist is configured", () => {
    const config = loadConfig({ FILTER_API_ALLOWED_ORIGINS: VALID_EXTENSION_ORIGIN });

    expect(config.allowedOrigins).toEqual(new Set([VALID_EXTENSION_ORIGIN]));
  });

  it("canonicalizes accepted trailing slashes to browser Origin header form", () => {
    const config = loadConfig({
      FILTER_API_ALLOWED_ORIGINS: `${VALID_EXTENSION_ORIGIN}/,http://localhost:5173/`,
    });

    expect(config.allowedOrigins).toEqual(new Set([
      VALID_EXTENSION_ORIGIN,
      "http://localhost:5173",
    ]));
  });

  it("rejects public HTTP origins", () => {
    expect(() => loadConfig({ FILTER_API_ALLOWED_ORIGINS: "https://example.com" })).toThrow(
      /only accepts localhost HTTP origins/i,
    );
  });

  it("accepts a configured port and pinned model", () => {
    const config = loadConfig({
      FILTER_API_HOST: "0.0.0.0",
      FILTER_API_PORT: "4500",
      OPENAI_FILTER_MODEL: "gpt-fixed-snapshot",
      DENICHEUR_DB_PATH: ":memory:",
    });

    expect(config.port).toBe(4500);
    expect(config.host).toBe("0.0.0.0");
    expect(config.openAiModel).toBe("gpt-fixed-snapshot");
    expect(config.databasePath).toBe(":memory:");
  });

  it("rejects arbitrary bind hosts", () => {
    expect(() => loadConfig({ FILTER_API_HOST: "192.0.2.10" })).toThrow();
  });

  it("rejects fine-tuned models that cannot honor the strict schema keywords", () => {
    expect(() => loadConfig({ OPENAI_FILTER_MODEL: "ft:gpt-5-mini:org:custom" })).toThrow(
      /fine-tuned models are not supported/i,
    );
  });

  it("requires complete MinIO settings in production", () => {
    const operatorToken = "test-operator-token-with-at-least-32-chars";
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/OPERATOR_TOKEN is required/i);
    expect(() => loadConfig({ NODE_ENV: "production", OPERATOR_TOKEN: operatorToken }))
      .toThrow(/MEDIA_STORAGE_MODE=minio is required/i);
    expect(() => loadConfig({ NODE_ENV: "production", OPERATOR_TOKEN: operatorToken, MEDIA_STORAGE_MODE: "minio" }))
      .toThrow(/MEDIA_S3_ENDPOINT is required/i);

    const config = loadConfig({
      NODE_ENV: "production",
      API_REPLICA_COUNT: "1",
      OPERATOR_TOKEN: operatorToken,
      MEDIA_STORAGE_MODE: "minio",
      MEDIA_S3_ENDPOINT: "https://minio.shared-databases.svc.cluster.local:9000",
      MEDIA_S3_BUCKET: "denicheur-breizh-media",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_ACCESS_KEY_ID: "media-user",
      MEDIA_S3_SECRET_ACCESS_KEY: "test-only-secret",
    });

    expect(config.media).toMatchObject({
      mode: "minio",
      bucket: "denicheur-breizh-media",
      forcePathStyle: true,
      workerConcurrency: 2,
    });
    expect(config.operatorToken).toBe(operatorToken);
  });

  it("requires explicit production pricing and maps resource ceilings", () => {
    const production = {
      NODE_ENV: "production",
      API_REPLICA_COUNT: "1",
      OPERATOR_TOKEN: "test-operator-token-with-at-least-32-chars",
      OPENAI_API_KEY: "test-openai-key-with-at-least-twenty-chars",
      MEDIA_STORAGE_MODE: "minio",
      MEDIA_S3_ENDPOINT: "https://minio.shared-databases.svc.cluster.local:9000",
      MEDIA_S3_BUCKET: "denicheur-breizh-media",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_ACCESS_KEY_ID: "media-user",
      MEDIA_S3_SECRET_ACCESS_KEY: "test-only-secret",
    } as const;

    expect(() => loadConfig(production)).toThrow(/explicit non-zero input and output token prices/i);
    const config = loadConfig({
      ...production,
      OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS: "250000",
      OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS: "2000000",
      EVALUATION_MAX_PROVIDER_CALLS: "7",
      OPENAI_GLOBAL_MAX_PROVIDER_CALLS: "11",
      OPENAI_GLOBAL_BUDGET_WINDOW_MS: "120000",
      MEDIA_MAX_PENDING_JOBS: "9",
    });

    expect(config.evaluationBudget).toMatchObject({
      maxProviderCalls: 7,
      inputPriceMicroUsdPerMillionTokens: 250_000,
      outputPriceMicroUsdPerMillionTokens: 2_000_000,
    });
    expect(config.openAiGlobalBudget).toMatchObject({
      maxProviderCalls: 11,
      windowMs: 120_000,
      inputPriceMicroUsdPerMillionTokens: 250_000,
      outputPriceMicroUsdPerMillionTokens: 2_000_000,
    });
    expect(config.media.admission.maxPendingJobs).toBe(9);
  });

  it("requires one explicit API replica and HTTPS media storage in production", () => {
    const production = {
      NODE_ENV: "production",
      OPERATOR_TOKEN: "test-operator-token-with-at-least-32-chars",
      MEDIA_STORAGE_MODE: "minio",
      MEDIA_S3_ENDPOINT: "https://minio.shared-databases.svc.cluster.local:9000",
      MEDIA_S3_BUCKET: "denicheur-breizh-media",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_ACCESS_KEY_ID: "media-user",
      MEDIA_S3_SECRET_ACCESS_KEY: "test-only-secret",
    } as const;

    expect(() => loadConfig(production)).toThrow(/API_REPLICA_COUNT=1/i);
    expect(() => loadConfig({ ...production, API_REPLICA_COUNT: "2" })).toThrow(/single API replica/i);
    expect(() => loadConfig({
      ...production,
      API_REPLICA_COUNT: "1",
      DENICHEUR_DB_PATH: ":memory:",
    })).toThrow(/persistent storage in production/i);
    expect(() => loadConfig({
      ...production,
      API_REPLICA_COUNT: "1",
      OPENAI_REALTIME_ENABLED: "true",
    })).toThrow(/Realtime is disabled in production/i);
    expect(() => loadConfig({
      ...production,
      API_REPLICA_COUNT: "1",
      MEDIA_S3_ENDPOINT: "http://minio.shared-databases.svc.cluster.local:9000",
    })).toThrow(/MEDIA_S3_ENDPOINT must use HTTPS in production/i);

    expect(loadConfig({
      NODE_ENV: "test",
      MEDIA_STORAGE_MODE: "minio",
      MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000",
      MEDIA_S3_BUCKET: "denicheur-breizh-media",
      MEDIA_S3_REGION: "us-east-1",
      MEDIA_S3_ACCESS_KEY_ID: "media-user",
      MEDIA_S3_SECRET_ACCESS_KEY: "test-only-secret",
    }).media.endpoint).toBe("http://127.0.0.1:9000");
  });

  it("rejects a per-asset media reservation larger than total capacity", () => {
    expect(() => loadConfig({
      MEDIA_MAX_RESERVED_BYTES: "10",
      MEDIA_RESERVED_BYTES_PER_ASSET: "11",
    })).toThrow(/cannot exceed MEDIA_MAX_RESERVED_BYTES/i);
  });
});

describe("isChromeExtensionOrigin", () => {
  it("accepts only syntactically valid extension origins", () => {
    expect(isChromeExtensionOrigin(VALID_EXTENSION_ORIGIN)).toBe(true);
    expect(isChromeExtensionOrigin("chrome-extension://not-an-extension-id")).toBe(false);
    expect(isChromeExtensionOrigin(`${VALID_EXTENSION_ORIGIN}/page.html`)).toBe(false);
  });
});
