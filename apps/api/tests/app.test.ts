import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig, type ApiConfig } from "../src/config.js";
import type { FilterListingsRequest, FilterListingsResponse, RunStatus } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import type { LogEntry } from "../src/logger.js";
import { DenicheurRepository } from "../src/repository.js";
import { createRequest, createResponse } from "./fixtures.js";

const VALID_EXTENSION_ORIGIN = "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi";

describe("HTTP API", () => {
  it("reports health without invoking the evaluator or exposing credential state", async () => {
    const { app, filter } = createTestApp();

    const response = await request(app).get("/health").expect(200);

    expect(response.body).toEqual({
      status: "ok",
      service: "denicheur-api",
      database: { status: "ok" },
      openAiConfigured: false,
    });
    expect(response.body).not.toHaveProperty("openAiApiKey");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(filter).not.toHaveBeenCalled();
  });

  it("classifies a valid batch and returns a request id", async () => {
    const input = createRequest(1, "es");
    const expected = createResponse(input);
    const { app, filter } = createTestApp({ response: expected });

    const response = await request(app)
      .post("/v1/listings/filter")
      .set("Origin", VALID_EXTENSION_ORIGIN)
      .send(input)
      .expect(200);

    expect(response.body).toEqual(expected);
    expect(response.body.locale).toBe("es");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["access-control-allow-origin"]).toBe(VALID_EXTENSION_ORIGIN);
    expect(filter).toHaveBeenCalledWith(input, { requestId: response.headers["x-request-id"] });
  });

  it("ingests a sparse listing and exposes it through listing and run reads", async () => {
    const { app } = createTestApp();
    const coordinates = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T09:09:00.000Z",
      provenance: "leboncoin:api:location",
      locationKind: "source-locality",
    };
    const ingestion = {
      run: {
        id: "run-ingestion",
        source: "leboncoin",
        status: "completed",
        startedAt: "2026-07-18T09:00:00.000Z",
      },
      listings: [{
        source: "leboncoin",
        externalId: "2876543210",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
        coordinates,
        status: "listing",
        scrapedAt: "2026-07-18T09:10:00.000Z",
      }],
    };

    await request(app).put("/v1/ingestion/runs/run-ingestion").send(ingestion).expect(200, {
      runId: "run-ingestion",
      accepted: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0,
    });
    const list = await request(app).get("/v1/listings?limit=10&sort=updatedAt&order=desc").expect(200);
    const detail = await request(app).get("/v1/listings/leboncoin/2876543210").expect(200);
    const run = await request(app).get("/v1/runs/run-ingestion").expect(200);

    expect(list.body).toMatchObject({ total: 1, nextCursor: null });
    expect(list.body.items[0]).toMatchObject({ id: "leboncoin:2876543210", lastRunId: "run-ingestion" });
    expect(list.body.items[0].coordinates).toEqual(coordinates);
    expect(list.body.items[0]).not.toHaveProperty("title");
    expect(detail.body.coordinates).toEqual(coordinates);
    expect(detail.body.runs).toEqual([expect.objectContaining({ runId: "run-ingestion" })]);
    expect(run.body.listings[0].coordinates).toEqual(coordinates);
    expect(run.body.listings).toEqual([expect.objectContaining({ id: "leboncoin:2876543210" })]);
  });

  it("rejects coordinate payloads that do not declare a supported location kind", async () => {
    const { app, repository } = createTestApp();
    const ingestion = {
      run: { id: "run-invalid-coordinates", source: "leboncoin", status: "completed" },
      listings: [{
        source: "leboncoin",
        externalId: "2876543210",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
        coordinates: {
          latitude: 47.855831,
          longitude: -3.852705,
          verifiedAt: "2026-07-18T09:09:00.000Z",
          provenance: "leboncoin:api:location",
          locationKind: "city-center",
        },
        status: "listing",
        scrapedAt: "2026-07-18T09:10:00.000Z",
      }],
    };

    const response = await request(app)
      .put("/v1/ingestion/runs/run-invalid-coordinates")
      .send(ingestion)
      .expect(400);

    expect(response.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(repository.listListings({ limit: 20, sort: "updatedAt", order: "desc" }).total).toBe(0);
  });

  it("versions recipes and activates one explicit version", async () => {
    const { app } = createTestApp();
    const draft = {
      name: "Maison avec jardin",
      threshold: 70,
      criteria: [{
        id: "garden",
        name: "Jardin",
        description: "Le bien doit avoir un jardin.",
        weight: 1,
        required: false,
      }],
    };

    const first = await request(app).put("/v1/recipes/recipe-1").send(draft).expect(201);
    const second = await request(app).put("/v1/recipes/recipe-1").send({ ...draft, threshold: 80 }).expect(201);
    const activated = await request(app).post("/v1/recipes/recipe-1/activate").send({ version: 1 }).expect(200);
    const active = await request(app).get("/v1/recipes/active").expect(200);
    const recipes = await request(app).get("/v1/recipes").expect(200);

    expect(first.body).toMatchObject({ id: "recipe-1", version: 1, active: false });
    expect(second.body).toMatchObject({ id: "recipe-1", version: 2, active: false });
    expect(activated.body).toMatchObject({ id: "recipe-1", version: 1, active: true });
    expect(active.body).toEqual(activated.body);
    expect(recipes.body.items).toHaveLength(2);
  });

  it("evaluates stored run listings and exposes persisted evidence", async () => {
    const filterImplementation = async (input: FilterListingsRequest): Promise<FilterListingsResponse> => ({
      runId: input.runId,
      locale: input.locale,
      recipeId: input.recipe.id,
      recipeVersion: input.recipe.version,
      evaluator: { provider: "openai", model: "gpt-test", version: "1.0.0" },
      results: input.listings.map((listing) => ({
        listingId: listing.id,
        decision: "relevant",
        score: 100,
        summary: "Le bien correspond au critère.",
        criteria: [{
          criterionId: "garden",
          verdict: "pass",
          reason: "Le jardin est mentionné.",
          evidence: ["Jardin"],
        }],
        missingData: ["priceEuros", "propertyType", "rooms", "bedrooms", "surfaceM2", "landSurfaceM2", "location", "sellerName", "sellerType", "energyClass", "gesClass"],
        evaluatedAt: "2026-07-18T10:00:00.000Z",
      })),
    });
    const { app, filter } = createTestApp({ filterImplementation });
    await request(app).put("/v1/ingestion/runs/run-evaluation").send({
      run: { id: "run-evaluation", source: "leboncoin", status: "completed" },
      listings: [{
        source: "leboncoin",
        externalId: "2876543210",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
        title: "Maison avec jardin",
        features: ["Jardin"],
        status: "detailed",
        scrapedAt: "2026-07-18T09:10:00.000Z",
      }],
    }).expect(200);
    await request(app).put("/v1/recipes/recipe-1").send({
      name: "Maison avec jardin",
      threshold: 70,
      criteria: [{ id: "garden", name: "Jardin", description: "Jardin requis.", weight: 1, required: false }],
    }).expect(201);

    const evaluation = await request(app).post("/v1/runs/run-evaluation/evaluations").send({
      locale: "fr",
      recipeId: "recipe-1",
      recipeVersion: 1,
      listingIds: ["leboncoin:2876543210"],
    }).expect(200);
    const detail = await request(app).get("/v1/listings/leboncoin/2876543210").expect(200);

    expect(evaluation.body.results[0]).toMatchObject({ listingId: "leboncoin:2876543210", decision: "relevant" });
    expect(detail.body.evaluations).toHaveLength(1);
    expect(detail.body.evaluations[0]).toMatchObject({ runId: "run-evaluation" });
    expect(detail.body.latestEvaluation.criteria[0].evidence).toEqual(["Jardin"]);
    expect(filter).toHaveBeenCalledTimes(1);
  });

  it.each<RunStatus>(["completed", "idle"])(
    "clears collected data for a %s run while preserving recipes and the migrated database",
    async (status) => {
      const { app, repository } = createTestApp();
      const seeded = seedCollectedData(repository, status);

      expect(repository.findEvaluation(seeded.runId, seeded.identity, seeded.evaluationRequest)).toBeDefined();

      const response = await request(app)
        .post("/v1/maintenance/collected-data/clear")
        .send({ confirm: "clear-collected-data" })
        .expect(200);

      expect(response.body).toEqual({
        deleted: {
          listings: 1,
          runs: 1,
          runListings: 1,
          evaluations: 1,
        },
      });
      await request(app).get("/v1/listings?limit=20&sort=updatedAt&order=desc").expect(200, {
        items: [],
        nextCursor: null,
        total: 0,
      });
      await request(app).get("/v1/runs?limit=20&order=desc").expect(200, {
        items: [],
        nextCursor: null,
        total: 0,
      });
      await request(app).get("/health").expect(200);
      const activeRecipe = await request(app).get("/v1/recipes/active").expect(200);

      expect(activeRecipe.body).toMatchObject({ id: seeded.recipeId, version: 1, active: true });
      expect(repository.findEvaluation(seeded.runId, seeded.identity, seeded.evaluationRequest)).toBeUndefined();
    },
  );

  it.each([
    ["missing confirmation", {}],
    ["wrong confirmation", { confirm: "not-the-destructive-confirmation" }],
    ["an unknown field", { confirm: "clear-collected-data", unexpected: true }],
  ])("rejects %s without deleting collected data", async (_case, payload) => {
    const { app, repository } = createTestApp();
    const seeded = seedCollectedData(repository);

    const response = await request(app)
      .post("/v1/maintenance/collected-data/clear")
      .send(payload)
      .expect(400);

    expect(response.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(repository.getRun(seeded.runId)).toBeDefined();
    expect(repository.getListing(seeded.identity)).toBeDefined();
    expect(repository.findEvaluation(seeded.runId, seeded.identity, seeded.evaluationRequest)).toBeDefined();
    expect(repository.getActiveRecipe()).toMatchObject({ id: seeded.recipeId, version: 1, active: true });
  });

  it("rejects maintenance cleanup from a web origin without deleting data", async () => {
    const { app, repository } = createTestApp();
    const seeded = seedCollectedData(repository);

    const response = await request(app)
      .post("/v1/maintenance/collected-data/clear")
      .set("Origin", "http://127.0.0.1:5173")
      .send({ confirm: "clear-collected-data" })
      .expect(403);

    expect(response.body.error).toMatchObject({ code: "MAINTENANCE_ORIGIN_NOT_ALLOWED" });
    expect(repository.getRun(seeded.runId)).toBeDefined();
    expect(repository.getListing(seeded.identity)).toBeDefined();
  });

  it.each<RunStatus>([
    "opening-search",
    "configuring-search",
    "collecting-search",
    "collecting-details",
    "evaluating",
    "paused-captcha",
  ])("refuses cleanup while a %s run is nonterminal", async (status) => {
    const { app, repository } = createTestApp();
    const seeded = seedCollectedData(repository, status);

    const response = await request(app)
      .post("/v1/maintenance/collected-data/clear")
      .send({ confirm: "clear-collected-data" })
      .expect(409);

    expect(response.body.error).toMatchObject({ code: "ACTIVE_RUN" });
    expect(repository.getRun(seeded.runId)).toMatchObject({ status });
    expect(repository.getListing(seeded.identity)).toBeDefined();
    expect(repository.findEvaluation(seeded.runId, seeded.identity, seeded.evaluationRequest)).toBeDefined();
    expect(repository.getActiveRecipe()).toMatchObject({ id: seeded.recipeId, version: 1, active: true });
  });

  it("clears a stale active checkpoint when the configured extension asserts the runner lease", async () => {
    const { app, repository } = createTestApp();
    const seeded = seedCollectedData(repository, "collecting-details");

    const response = await request(app)
      .post("/v1/maintenance/collected-data/clear")
      .set("Origin", VALID_EXTENSION_ORIGIN)
      .send({ confirm: "clear-collected-data", runnerLease: "held" })
      .expect(200);

    expect(response.body.deleted).toEqual({
      listings: 1,
      runs: 1,
      runListings: 1,
      evaluations: 1,
    });
    expect(repository.getRun(seeded.runId)).toBeUndefined();
    expect(repository.getListing(seeded.identity)).toBeUndefined();
    expect(repository.getActiveRecipe()).toMatchObject({ id: seeded.recipeId, version: 1, active: true });
  });

  it("rejects a runner-lease assertion from a local CLI", async () => {
    const { app, repository } = createTestApp();
    const seeded = seedCollectedData(repository, "collecting-details");

    const response = await request(app)
      .post("/v1/maintenance/collected-data/clear")
      .send({ confirm: "clear-collected-data", runnerLease: "held" })
      .expect(403);

    expect(response.body.error).toMatchObject({ code: "RUNNER_LEASE_ORIGIN_REQUIRED" });
    expect(repository.getRun(seeded.runId)).toBeDefined();
    expect(repository.getListing(seeded.identity)).toBeDefined();
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

  it("requires an exact supported locale before invoking the evaluator", async () => {
    const { locale: _locale, ...withoutLocale } = createRequest();
    const { app, filter } = createTestApp();

    const missing = await request(app).post("/v1/listings/filter").send(withoutLocale).expect(400);
    const regional = await request(app)
      .post("/v1/listings/filter")
      .send({ ...createRequest(), locale: "es-ES" })
      .expect(400);

    expect(missing.body.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(regional.body.error).toMatchObject({ code: "INVALID_REQUEST" });
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
  readonly filterImplementation?: (request: FilterListingsRequest) => Promise<FilterListingsResponse>;
}

function createTestApp(options: TestAppOptions = {}) {
  const baseConfig = loadConfig({});
  const config: ApiConfig = { ...baseConfig, ...options.config };
  const logger = options.logger ?? createLogger();
  const filter = options.error
    ? vi.fn().mockRejectedValue(options.error)
    : options.filterImplementation
      ? vi.fn(options.filterImplementation)
      : vi.fn().mockResolvedValue(options.response ?? createResponse());
  const repository = new DenicheurRepository({ path: ":memory:" });
  const app = createApp({ config, filterService: { filter }, repository, logger });

  return { app, filter, logger, repository };
}

function createLogger() {
  return {
    info: vi.fn<(entry: LogEntry) => void>(),
    error: vi.fn<(entry: LogEntry) => void>(),
  };
}

function seedCollectedData(repository: DenicheurRepository, status: RunStatus = "completed") {
  const runId = `run-maintenance-${status}`;
  const identity = { source: "leboncoin" as const, externalId: "2876543210" };
  const recipe = repository.saveRecipe("preserved-recipe", {
    name: "Recette conservée",
    threshold: 70,
    criteria: [{
      id: "garden",
      name: "Jardin",
      description: "Le bien doit disposer d'un jardin.",
      weight: 1,
      required: false,
    }],
  });
  repository.activateRecipe(recipe.id, recipe.version);
  repository.ingest({
    run: {
      id: runId,
      source: "leboncoin",
      status,
      startedAt: "2026-07-18T09:00:00.000Z",
      ...(status === "completed" ? { finishedAt: "2026-07-18T09:30:00.000Z" } : {}),
    },
    listings: [{
      ...identity,
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Maison avec jardin",
      features: ["Jardin"],
      status: "detailed",
      scrapedAt: "2026-07-18T09:20:00.000Z",
    }],
  });
  const listingId = `${identity.source}:${identity.externalId}`;
  const evaluationRequest = {
    locale: "fr" as const,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    listingIds: [listingId],
  };
  repository.saveEvaluationBatch({
    runId,
    locale: evaluationRequest.locale,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    evaluator: { provider: "openai", model: "gpt-test", version: "1.0.0" },
    results: [{
      listingId,
      decision: "relevant",
      score: 100,
      summary: "Le jardin est présent.",
      criteria: [{
        criterionId: "garden",
        verdict: "pass",
        reason: "Le jardin est mentionné.",
        evidence: ["Jardin"],
      }],
      missingData: [],
      evaluatedAt: "2026-07-18T10:00:00.000Z",
    }],
  });

  return { runId, identity, evaluationRequest, recipeId: recipe.id };
}
