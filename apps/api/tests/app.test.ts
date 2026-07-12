import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig, type ApiConfig } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import type { LogEntry } from "../src/logger.js";
import { createRequest, createResponse } from "./fixtures.js";

const VALID_EXTENSION_ORIGIN = "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi";

describe("HTTP API", () => {
  it("reports health without invoking the evaluator or exposing credential state", async () => {
    const { app, filter } = createTestApp();

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok", service: "denicheur-filter-api" });
    expect(response.body).not.toHaveProperty("openAiApiKey");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(filter).not.toHaveBeenCalled();
  });

  it("classifies a valid batch and returns a request id", async () => {
    const input = createRequest();
    const expected = createResponse(input);
    const { app, filter } = createTestApp({ response: expected });

    const response = await request(app)
      .post("/v1/listings/filter")
      .set("Origin", VALID_EXTENSION_ORIGIN)
      .send(input)
      .expect(200);

    expect(response.body).toEqual(expected);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["access-control-allow-origin"]).toBe(VALID_EXTENSION_ORIGIN);
    expect(filter).toHaveBeenCalledWith(input, { requestId: response.headers["x-request-id"] });
  });

  it("rejects an invalid payload before invoking the evaluator", async () => {
    const input = createRequest();
    input.recipe.criteria = [];
    const { app, filter } = createTestApp();

    const response = await request(app).post("/v1/listings/filter").send(input).expect(400);

    expect(response.body.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "The request body is invalid.",
      issues: expect.any(Array),
    });
    expect(filter).not.toHaveBeenCalled();
  });

  it("returns a normalized invalid JSON error", async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post("/v1/listings/filter")
      .set("Content-Type", "application/json")
      .send('{"runId"')
      .expect(400);

    expect(response.body.error).toMatchObject({ code: "INVALID_JSON", message: "The request body is not valid JSON." });
  });

  it("rejects oversized payloads with a normalized error", async () => {
    const { app } = createTestApp({ config: { requestBodyLimit: "100b" } });

    const response = await request(app).post("/v1/listings/filter").send(createRequest()).expect(413);

    expect(response.body.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: "The request body is too large.",
    });
  });

  it("allows valid extension origins by default and blocks unrelated origins", async () => {
    const { app } = createTestApp();

    await request(app).get("/health").set("Origin", VALID_EXTENSION_ORIGIN).expect(200);
    const preflight = await request(app)
      .options("/v1/listings/filter")
      .set("Origin", VALID_EXTENSION_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type")
      .expect(204);
    const blockedExtension = await request(app)
      .get("/health")
      .set("Origin", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      .expect(403);
    const blocked = await request(app).get("/health").set("Origin", "https://example.com").expect(403);

    expect(preflight.headers["access-control-allow-origin"]).toBe(VALID_EXTENSION_ORIGIN);
    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
    expect(blockedExtension.body.error).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(blocked.body.error).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });

  it("rate limits the filter endpoint without rate limiting health", async () => {
    const { app } = createTestApp({ config: { rateLimitMax: 1 } });

    await request(app).post("/v1/listings/filter").send(createRequest()).expect(200);
    const limited = await request(app).post("/v1/listings/filter").send(createRequest()).expect(429);
    await request(app).get("/health").expect(200);

    expect(limited.body.error).toMatchObject({ code: "RATE_LIMITED", message: "Too many filter requests." });
  });

  it("normalizes evaluator failures and never logs or returns secret values", async () => {
    const secret = "sk-test-secret-value";
    const logger = createLogger();
    const evaluatorError = new ApiError(503, "OPENAI_UNAVAILABLE", "The evaluator is temporarily unavailable.", {
      cause: new Error(secret),
    });
    const { app } = createTestApp({ error: evaluatorError, logger });
    const input = {
      ...createRequest(),
      OPENAI_API_KEY: secret,
    };

    const invalidResponse = await request(app).post("/v1/listings/filter").send(input).expect(400);
    expect(JSON.stringify(invalidResponse.body)).not.toContain(secret);

    const upstreamResponse = await request(app).post("/v1/listings/filter").send(createRequest()).expect(503);
    expect(upstreamResponse.body.error).toMatchObject({
      code: "OPENAI_UNAVAILABLE",
      message: "The evaluator is temporarily unavailable.",
    });
    expect(JSON.stringify(upstreamResponse.body)).not.toContain(secret);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  it("returns a normalized 404 response", async () => {
    const { app } = createTestApp();

    const response = await request(app).get("/missing").expect(404);

    expect(response.body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

interface TestAppOptions {
  readonly config?: Partial<ApiConfig>;
  readonly response?: ReturnType<typeof createResponse>;
  readonly error?: Error;
  readonly logger?: ReturnType<typeof createLogger>;
}

function createTestApp(options: TestAppOptions = {}) {
  const baseConfig = loadConfig({});
  const config: ApiConfig = { ...baseConfig, ...options.config };
  const logger = options.logger ?? createLogger();
  const filter = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : vi.fn().mockResolvedValue(options.response ?? createResponse());
  const app = createApp({ config, filterService: { filter }, logger });

  return { app, filter, logger };
}

function createLogger() {
  return {
    info: vi.fn<(entry: LogEntry) => void>(),
    error: vi.fn<(entry: LogEntry) => void>(),
  };
}
