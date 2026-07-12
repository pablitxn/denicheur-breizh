import { randomUUID } from "node:crypto";

import cors from "cors";
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";

import type { ApiConfig } from "./config.js";
import { filterListingsRequestSchema } from "./contracts.js";
import { ApiError, type ValidationIssue } from "./errors.js";
import type { FilterListingsService } from "./filterService.js";
import type { Logger } from "./logger.js";

export interface AppDependencies {
  readonly config: ApiConfig;
  readonly filterService: Pick<FilterListingsService, "filter">;
  readonly logger: Logger;
}

export function createApp({ config, filterService, logger }: AppDependencies): Express {
  const app = express();

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
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: config.requestBodyLimit, type: ["application/json", "application/*+json"] }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "denicheur-filter-api" });
  });

  app.post(
    "/v1/listings/filter",
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler(_request, response) {
        sendError(response, new ApiError(429, "RATE_LIMITED", "Too many filter requests."));
      },
    }),
    async (request, response) => {
      const parsed = filterListingsRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new ApiError(400, "INVALID_REQUEST", "The request body is invalid.", {
          issues: parsed.error.issues.map<ValidationIssue>((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        });
      }

      const result = await filterService.filter(parsed.data, {
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
