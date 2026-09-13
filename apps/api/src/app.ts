import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";

import cors from "cors";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";

import { isChromeExtensionOrigin, type ApiConfig } from "./config.js";
import {
  evaluationExecutionCreateRequestSchema,
  evaluationExecutionRetryRequestSchema,
  evaluationExecutionsQuerySchema,
  evaluationPlanDraftSchema,
  evaluationRequestSchema,
  filterListingsRequestSchema,
  type HealthDetailsResponse,
  idempotencyKeySchema,
  ingestionRequestSchema,
  sourceRecordsRequestSchema,
  sourceRecordsQuerySchema,
  listingIdentitySchema,
  listingsQuerySchema,
  listingsMapQuerySchema,
  recipeDraftSchema,
  runListingsQuerySchema,
  runsQuerySchema,
  setDefaultEvaluationPlanRequestSchema,
} from "./contracts.js";
import { ApiError, type ValidationIssue } from "./errors.js";
import { EvaluationExecutionService, type EvaluationExecutionQueue } from "./evaluationExecutionService.js";
import { EvaluationExecutionWorker } from "./evaluationExecutionWorker.js";
import { StoredEvaluationService } from "./evaluationService.js";
import type { FilterListingsService } from "./filterService.js";
import type { Logger } from "./logger.js";
import { MediaService, type MediaHealth } from "./mediaService.js";
import { requireOperatorForPrivateMethods } from "./operatorAuth.js";
import { RealtimeSessionService, type RealtimeFetch } from "./realtimeSessionService.js";
import type { DenicheurRepository } from "./repository.js";

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly filterService: Pick<FilterListingsService, "filter">;
  readonly repository: DenicheurRepository;
  readonly logger: Logger;
  readonly fetchImpl?: RealtimeFetch;
  readonly evaluationExecutionWorker?: EvaluationExecutionWorkerLifecycle;
  readonly mediaService?: MediaService;
}

export interface EvaluationExecutionWorkerLifecycle extends EvaluationExecutionQueue {
  start(): void;
  dispose(): Promise<void>;
}

const pathIdentifierSchema = z.string().trim().min(1).max(128);
const activationRequestSchema = z.object({ version: z.number().int().min(1).optional() }).strict();
const clearCollectedDataRequestSchema = z.object({
  confirm: z.literal("clear-collected-data"),
  runnerLease: z.literal("held").optional(),
}).strict();

export function createApp({
  config,
  filterService,
  repository,
  logger,
  fetchImpl,
  evaluationExecutionWorker,
  mediaService,
}: AppDependencies): Express {
  const app = express();
  const evaluationService = new StoredEvaluationService(repository, filterService, {
    evaluator: {
      provider: "openai",
      model: config.openAiModel,
      version: config.evaluatorVersion,
    },
  });
  const realtimeSessionService = new RealtimeSessionService({
    enabled: config.realtimeEnabled,
    apiKey: config.openAiApiKey,
    timeoutMs: config.openAiTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const executionWorker = evaluationExecutionWorker ?? new EvaluationExecutionWorker(repository, evaluationService, {
    budgetPolicy: config.evaluationBudget,
  });
  const executionService = new EvaluationExecutionService(repository, executionWorker, config.evaluationBudget);
  const media = mediaService ?? new MediaService({ repository, logger });
  app.locals.evaluationExecutionWorker = executionWorker;
  app.locals.mediaService = media;

  app.disable("x-powered-by");
  app.use(requestContext(logger));
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        callback(new ApiError(403, "ORIGIN_NOT_ALLOWED", "The request origin is not allowed."));
      },
      methods: ["GET", "POST", "PUT"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "If-None-Match"],
      exposedHeaders: ["X-Request-Id", "ETag", "Content-Length", "Cache-Control"],
      maxAge: 600,
    }),
  );
  app.use(requireOperatorForPrivateMethods(config.operatorToken));
  app.use(express.text({ limit: config.requestBodyLimit, type: "application/sdp" }));
  // A serialized extractor payload can expand when nested in its JSON envelope.
  // The extension sends one record at a time; all other API limits stay unchanged.
  app.post("/v1/source-records", express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));
  app.use(express.json({ limit: config.requestBodyLimit, type: ["application/json", "application/*+json"] }));

  const readHealthDetails = (): HealthDetailsResponse => {
    const ready = repository.isReady();
    let mediaHealth: MediaHealth = {
      status: "degraded",
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
    };
    if (ready) {
      try {
        mediaHealth = media.health();
      } catch {
        // Readiness must remain minimal and fail closed if health metadata cannot be read.
      }
    }
    const mediaUnavailable = mediaHealth.status === "degraded"
      || (config.media.mode === "minio" && mediaHealth.status !== "ok");
    return {
      status: !ready ? "error" : mediaUnavailable ? "degraded" : "ok",
      service: "denicheur-api",
      database: { status: ready ? "ok" : "error" },
      media: mediaHealth,
      openAiConfigured: Boolean(config.openAiApiKey),
    };
  };

  app.get("/health", (_request, response) => {
    const health = readHealthDetails();
    response.status(health.status === "ok" ? 200 : 503).json({
      status: health.status,
      service: health.service,
    });
  });

  app.get("/v1/health/details", (_request, response) => {
    const health = readHealthDetails();
    response.status(health.status === "ok" ? 200 : 503).json(health);
  });

  app.use((request, _response, next) => {
    if (
      media.isMaintenanceActive() &&
      request.path !== "/v1/maintenance/collected-data/clear"
    ) {
      next(new ApiError(503, "MAINTENANCE_IN_PROGRESS", "Collected data cleanup is in progress."));
      return;
    }
    next();
  });

  app.post("/v1/maintenance/collected-data/clear", async (request, response) => {
    const origin = request.get("Origin");
    if (origin && !isChromeExtensionOrigin(origin)) {
      throw new ApiError(
        403,
        "MAINTENANCE_ORIGIN_NOT_ALLOWED",
        "Maintenance requests are only accepted from the configured Chrome extension or a local CLI.",
      );
    }
    const input = parseOrThrow(clearCollectedDataRequestSchema.safeParse(request.body));
    if (input.runnerLease && !origin) {
      throw new ApiError(
        403,
        "RUNNER_LEASE_ORIGIN_REQUIRED",
        "Only the configured Chrome extension can assert ownership of the crawler runner lease.",
      );
    }
    response.json({
      deleted: await media.clearCollectedData({ allowActiveRun: input.runnerLease === "held" }),
    });
  });

  app.put("/v1/ingestion/runs/:runId", (request, response) => {
    const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
    const input = parseOrThrow(ingestionRequestSchema.safeParse(request.body));
    if (input.run.id !== runId) {
      throw new ApiError(409, "RUN_ID_MISMATCH", "The route and request body run ids must match.");
    }
    // Validation above gates admission; the archive also needs the pre-transform JSON.
    const result = repository.ingest(request.body);
    media.kick();
    response.json(result);
  });

  app.get("/v1/runs", (request, response) => {
    response.json(repository.listRuns(parseOrThrow(runsQuerySchema.safeParse(request.query))));
  });

  app.post("/v1/source-records", (request, response) => {
    const input = parseOrThrow(sourceRecordsRequestSchema.safeParse(request.body));
    response.json(repository.archiveSourceRecords(input.records));
  });

  app.get("/v1/source-records/:recordId", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.recordId));
    const record = repository.getSourceRecord(id);
    if (!record) throw new ApiError(404, "SOURCE_RECORD_NOT_FOUND", "The requested source record does not exist.");
    response.json(record);
  });

  app.get("/v1/listings/:source/:externalId/source-records", (request, response) => {
    const identity = parseOrThrow(listingIdentitySchema.safeParse({
      source: request.params.source, externalId: request.params.externalId,
    }));
    const query = parseOrThrow(sourceRecordsQuerySchema.safeParse(request.query));
    response.json(repository.listSourceRecords(identity, query));
  });

  app.get("/v1/runs/:runId", (request, response) => {
    const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
    const run = repository.getRun(runId);
    if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    response.json(run);
  });

  app.get("/v1/runs/:runId/listings", (request, response) => {
    const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
    const page = repository.listRunListings(
      runId,
      parseOrThrow(runListingsQuerySchema.safeParse(request.query)),
    );
    if (!page) throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    response.json(page);
  });

  app.get("/v1/listings", (request, response) => {
    response.json(repository.listListings(parseOrThrow(listingsQuerySchema.safeParse(request.query))));
  });

  app.get("/v1/listings/metadata", (request, response) => {
    const result = repository.listingsMetadata(request.get("If-None-Match"));
    response.set({ ETag: result.etag, "Cache-Control": "private, no-cache" });
    if (!result.metadata) { response.status(304).end(); return; }
    response.json(result.metadata);
  });

  app.get("/v1/listings/map", (request, response) => {
    const query = parseOrThrow(listingsMapQuerySchema.safeParse(request.query));
    const result = repository.listMapListings(query, request.get("If-None-Match"));
    response.set({ ETag: result.etag, "Cache-Control": "private, no-cache" });
    if (!result.page) { response.status(304).end(); return; }
    response.json(result.page);
  });

  app.get("/v1/listings/:source/:externalId", (request, response) => {
    const identity = parseOrThrow(listingIdentitySchema.safeParse({
      source: request.params.source,
      externalId: request.params.externalId,
    }));
    const listing = repository.getListing(identity);
    if (!listing) throw new ApiError(404, "LISTING_NOT_FOUND", "The requested listing does not exist.");
    response.json(listing);
  });

  const mediaDeliveryRateLimit = requestRateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.media.deliveryRateLimitMax,
    code: "MEDIA_DELIVERY_RATE_LIMITED",
    message: "Too many media delivery requests.",
  });
  for (const variant of ["thumbnail", "gallery"] as const) {
    app.get(`/v1/media/:assetId/${variant}.webp`, mediaDeliveryRateLimit, async (request, response) => {
      const assetId = parseOrThrow(z.string().regex(/^[a-f0-9]{64}$/).safeParse(request.params.assetId));
      const object = await media.getVariant(assetId, variant);
      if (etagMatches(request.get("If-None-Match"), object.etag)) {
        object.body.destroy();
        response.status(304).set({
          ETag: object.etag,
          "Cache-Control": "private, max-age=31536000, immutable",
        }).end();
        return;
      }
      response.set({
        ETag: object.etag,
        "Content-Type": object.contentType,
        "Content-Length": String(object.contentLength),
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      await pipeline(object.body, response);
    });
  }

  app.get("/v1/recipes", (_request, response) => {
    response.json({ items: repository.listRecipes() });
  });

  app.get("/v1/recipes/active", (_request, response) => {
    const recipe = repository.getActiveRecipe();
    if (!recipe) throw new ApiError(404, "ACTIVE_RECIPE_NOT_FOUND", "No recipe version is active.");
    response.json(recipe);
  });

  app.put("/v1/recipes/:id", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const draft = parseOrThrow(recipeDraftSchema.safeParse(request.body));
    response.status(201).json(repository.saveRecipe(id, draft));
  });

  app.post("/v1/recipes/:id/activate", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const activation = parseOrThrow(activationRequestSchema.safeParse(request.body ?? {}));
    const recipe = repository.activateRecipe(id, activation.version);
    if (!recipe) throw new ApiError(404, "RECIPE_NOT_FOUND", "The requested recipe version does not exist.");
    response.json(recipe);
  });

  app.get("/v1/evaluation-plans", (_request, response) => {
    response.json({ items: repository.listEvaluationPlans() });
  });

  app.get("/v1/evaluation-plans/default", (_request, response) => {
    const plan = repository.getDefaultEvaluationPlan();
    if (!plan) throw new ApiError(404, "DEFAULT_EVALUATION_PLAN_NOT_FOUND", "No default evaluation plan exists.");
    response.json(plan);
  });

  app.get("/v1/evaluation-plans/:id/:version", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const version = parseOrThrow(z.coerce.number().int().min(1).safeParse(request.params.version));
    const plan = repository.getEvaluationPlan(id, version);
    if (!plan) throw new ApiError(404, "EVALUATION_PLAN_NOT_FOUND", "The requested evaluation plan version does not exist.");
    response.json(plan);
  });

  app.put("/v1/evaluation-plans/:id", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const draft = parseOrThrow(evaluationPlanDraftSchema.safeParse(request.body));
    response.status(201).json(repository.saveEvaluationPlan(id, draft));
  });

  app.post("/v1/evaluation-plans/:id/set-default", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const input = parseOrThrow(setDefaultEvaluationPlanRequestSchema.safeParse(request.body));
    const plan = repository.setDefaultEvaluationPlan(id, input.version);
    if (!plan) throw new ApiError(404, "EVALUATION_PLAN_NOT_FOUND", "The requested evaluation plan version does not exist.");
    response.json(plan);
  });

  app.post(
    "/v1/runs/:runId/evaluation-executions",
    filterRateLimit(config, "Too many evaluation execution requests."),
    (request, response) => {
      const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
      const input = parseOrThrow(evaluationExecutionCreateRequestSchema.safeParse(request.body));
      const idempotencyKey = requiredIdempotencyKey(request.get("Idempotency-Key"));
      response.status(202).json(executionService.create(runId, input, idempotencyKey).execution);
    },
  );

  app.get("/v1/evaluation-executions", (request, response) => {
    const query = parseOrThrow(evaluationExecutionsQuerySchema.safeParse(request.query));
    response.json(repository.listEvaluationExecutions(query));
  });

  app.get("/v1/evaluation-executions/:id/results", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const results = repository.getEvaluationExecutionResults(id);
    if (!results) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    response.json(results);
  });

  app.get("/v1/evaluation-executions/:id", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    const execution = repository.getEvaluationExecution(id);
    if (!execution) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    response.json(execution);
  });

  app.post("/v1/evaluation-executions/:id/cancel", (request, response) => {
    const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
    response.json(executionService.cancel(id));
  });

  app.post(
    "/v1/evaluation-executions/:id/retry",
    filterRateLimit(config, "Too many evaluation execution retry requests."),
    (request, response) => {
      const id = parseOrThrow(pathIdentifierSchema.safeParse(request.params.id));
      parseOrThrow(evaluationExecutionRetryRequestSchema.safeParse(request.body ?? {}));
      const idempotencyKey = requiredIdempotencyKey(request.get("Idempotency-Key"));
      response.status(202).json(executionService.retry(id, idempotencyKey).execution);
    },
  );

  app.post(
    "/v1/realtime/session",
    filterRateLimit(config, "Too many Realtime session requests."),
    async (request, response) => {
      if (!request.is("application/sdp")) {
        throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/sdp.");
      }
      if (typeof request.body !== "string" || !request.body.trim()) {
        throw new ApiError(400, "INVALID_SDP", "The SDP offer must not be empty.");
      }

      const answer = await realtimeSessionService.createSession(request.body);
      response.status(answer.status).type(answer.contentType).send(answer.body);
    },
  );

  app.post(
    "/v1/runs/:runId/evaluations",
    filterRateLimit(config, "Too many evaluation requests."),
    async (request, response) => {
      const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
      const input = parseOrThrow(evaluationRequestSchema.safeParse(request.body));
      const result = await evaluationService.evaluate(runId, input, {
        requestId: response.locals.requestId as string,
      });
      response.json(result);
    },
  );

  app.post(
    "/v1/listings/filter",
    filterRateLimit(config, "Too many filter requests."),
    async (request, response) => {
      const input = parseOrThrow(filterListingsRequestSchema.safeParse(request.body), "The request body is invalid.");
      const result = await filterService.filter(input, {
        requestId: response.locals.requestId as string,
      });
      response.json(result);
    },
  );

  app.use((_request, _response, next) => {
    next(new ApiError(404, "NOT_FOUND", "The requested endpoint does not exist."));
  });

  app.use(errorHandler(logger));
  executionWorker.start();
  return app;
}

export function evaluationExecutionWorkerFor(app: Express): EvaluationExecutionWorkerLifecycle {
  return app.locals.evaluationExecutionWorker as EvaluationExecutionWorkerLifecycle;
}

export function mediaServiceFor(app: Express): MediaService {
  return app.locals.mediaService as MediaService;
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const normalizedEtag = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value.replace(/^W\//, "") === normalizedEtag;
  });
}

function filterRateLimit(config: ApiConfig, message: string): RequestHandler {
  return requestRateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    code: "RATE_LIMITED",
    message,
  });
}

function requestRateLimit(options: {
  readonly windowMs: number;
  readonly limit: number;
  readonly code: string;
  readonly message: string;
}): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(_request, response) {
      sendError(response, new ApiError(429, options.code, options.message));
    },
  });
}

function parseOrThrow<T>(result: z.ZodSafeParseResult<T>, message = "The request is invalid."): T {
  if (result.success) return result.data;
  throw new ApiError(400, "INVALID_REQUEST", message, {
    issues: result.error.issues.map<ValidationIssue>((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function requiredIdempotencyKey(value: string | undefined): string {
  return parseOrThrow(
    idempotencyKeySchema.safeParse(value),
    "A valid Idempotency-Key header is required.",
  );
}

function requestContext(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);

    response.on("finish", () => {
      logger.info({
        event: "http_request_completed",
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });

    next();
  };
}

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const normalized = normalizeHttpError(error);

    if (!(error instanceof ApiError)) {
      logger.error({
        event: "http_request_failed",
        requestId: response.locals.requestId,
        code: normalized.code,
      });
    }

    sendError(response, normalized);
  };
}

function normalizeHttpError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const status = readNumberProperty(error, "status");
  const type = readStringProperty(error, "type");

  if (status === 413 || type === "entity.too.large") {
    return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }

  if (status === 400 && error instanceof SyntaxError) {
    return new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }

  return new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
}

function sendError(response: express.Response, error: ApiError): void {
  response.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.message,
      requestId: response.locals.requestId as string,
      ...(error.issues ? { issues: error.issues } : {}),
      ...(error.stage ? { stage: error.stage } : {}),
      ...(error.detailCode ? { detailCode: error.detailCode } : {}),
      ...(error.listingId ? { listingId: error.listingId } : {}),
      ...(error.criterionId ? { criterionId: error.criterionId } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
      ...(error.responseId ? { responseId: error.responseId } : {}),
    },
  });
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = Reflect.get(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

function readNumberProperty(value: unknown, property: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = Reflect.get(value, property);
  return typeof candidate === "number" ? candidate : undefined;
}
