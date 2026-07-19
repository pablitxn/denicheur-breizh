import { randomUUID } from "node:crypto";

import cors from "cors";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";

import { isChromeExtensionOrigin, type ApiConfig } from "./config.js";
import {
  evaluationRequestSchema,
  filterListingsRequestSchema,
  ingestionRequestSchema,
  listingIdentitySchema,
  listingsQuerySchema,
  recipeDraftSchema,
  runsQuerySchema,
} from "./contracts.js";
import { ApiError, type ValidationIssue } from "./errors.js";
import { StoredEvaluationService } from "./evaluationService.js";
import type { FilterListingsService } from "./filterService.js";
import type { Logger } from "./logger.js";
import { RealtimeSessionService, type RealtimeFetch } from "./realtimeSessionService.js";
import type { DenicheurRepository } from "./repository.js";

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly filterService: Pick<FilterListingsService, "filter">;
  readonly repository: DenicheurRepository;
  readonly logger: Logger;
  readonly fetchImpl?: RealtimeFetch;
}

const pathIdentifierSchema = z.string().trim().min(1).max(128);
const activationRequestSchema = z.object({ version: z.number().int().min(1).optional() }).strict();
const clearCollectedDataRequestSchema = z.object({
  confirm: z.literal("clear-collected-data"),
  runnerLease: z.literal("held").optional(),
}).strict();

export function createApp({ config, filterService, repository, logger, fetchImpl }: AppDependencies): Express {
  const app = express();
  const evaluationService = new StoredEvaluationService(repository, filterService);
  const realtimeSessionService = new RealtimeSessionService({
    apiKey: config.openAiApiKey,
    timeoutMs: config.openAiTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

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
      allowedHeaders: ["Content-Type"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(express.text({ limit: config.requestBodyLimit, type: "application/sdp" }));
  app.use(express.json({ limit: config.requestBodyLimit, type: ["application/json", "application/*+json"] }));

  app.get("/health", (_request, response) => {
    const ready = repository.isReady();
    response.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "error",
      service: "denicheur-api",
      database: { status: ready ? "ok" : "error" },
      openAiConfigured: Boolean(config.openAiApiKey),
    });
  });

  app.post("/v1/maintenance/collected-data/clear", (request, response) => {
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
      deleted: repository.clearCollectedData({ allowActiveRun: input.runnerLease === "held" }),
    });
  });

  app.put("/v1/ingestion/runs/:runId", (request, response) => {
    const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
    const input = parseOrThrow(ingestionRequestSchema.safeParse(request.body));
    if (input.run.id !== runId) {
      throw new ApiError(409, "RUN_ID_MISMATCH", "The route and request body run ids must match.");
    }
    response.json(repository.ingest(input));
  });

  app.get("/v1/runs", (request, response) => {
    response.json(repository.listRuns(parseOrThrow(runsQuerySchema.safeParse(request.query))));
  });

  app.get("/v1/runs/:runId", (request, response) => {
    const runId = parseOrThrow(pathIdentifierSchema.safeParse(request.params.runId));
    const run = repository.getRun(runId);
    if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    response.json(run);
  });

  app.get("/v1/listings", (request, response) => {
    response.json(repository.listListings(parseOrThrow(listingsQuerySchema.safeParse(request.query))));
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
  return app;
}

function filterRateLimit(config: ApiConfig, message: string): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler(_request, response) {
      sendError(response, new ApiError(429, "RATE_LIMITED", message));
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
