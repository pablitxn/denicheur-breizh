import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { ApiError } from "./errors.js";

const PUBLIC_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Production keeps reads public, while every state-changing or provider-backed
 * request is authenticated. Keeping this method-based and deny-by-default also
 * protects future POST/PUT/PATCH/DELETE routes until they are explicitly
 * redesigned as public operations.
 */
export function requireOperatorForPrivateMethods(operatorToken: string | undefined): RequestHandler {
  return (request, _response, next) => {
    if (PUBLIC_METHODS.has(request.method) || !operatorToken) {
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

function readBearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

function tokensMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}
