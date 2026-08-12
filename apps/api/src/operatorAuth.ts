import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { ApiError } from "./errors.js";

const HEALTH_METHODS = new Set(["GET", "HEAD"]);
const PUBLIC_HEALTH_PATHS = new Set(["/health", "/health/"]);

/**
 * Local mode stays unauthenticated when no token is configured. Once a token is
 * configured, only CORS preflight and the minimal health endpoint remain public;
 * every API read and mutation is authenticated deny-by-default.
 */
export function requireOperatorForPrivateMethods(operatorToken: string | undefined): RequestHandler {
  return (request, _response, next) => {
    if (!operatorToken || isPublicRequest(request.method, request.path)) {
      next();
      return;
    }

    const candidate = readBearerToken(request.get("Authorization"));
    if (!candidate || !tokensMatch(candidate, operatorToken)) {
      next(new ApiError(401, "OPERATOR_AUTH_REQUIRED", "A valid operator token is required."));
      return;
    }

    next();
  };
}

function isPublicRequest(method: string, path: string): boolean {
  return method === "OPTIONS" || (HEALTH_METHODS.has(method) && PUBLIC_HEALTH_PATHS.has(path));
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}
