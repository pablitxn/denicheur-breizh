import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import { requireOperatorForPrivateMethods } from "../src/operatorAuth.js";

const OPERATOR_TOKEN = "test-operator-token-with-at-least-32-chars";

describe("operator authentication", () => {
  it("keeps only health and preflight public when an operator token is configured", async () => {
    const app = createAuthTestApp(OPERATOR_TOKEN);

    await request(app).get("/health").expect(200);
    await request(app).head("/health").expect(200);
    await request(app).options("/v1/private").expect(204);

    const missingGet = await request(app).get("/v1/private").expect(401);
    await request(app).head("/v1/private").expect(401);
    await request(app).get("/healthz").expect(401);
    const wrongBearer = await request(app)
      .get("/v1/private")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);
    const wrongScheme = await request(app)
      .get("/v1/private")
      .set("Authorization", `Basic ${OPERATOR_TOKEN}`)
      .expect(401);

    expect(missingGet.body.error).toEqual({ code: "OPERATOR_AUTH_REQUIRED" });
    expect(wrongBearer.body.error).toEqual({ code: "OPERATOR_AUTH_REQUIRED" });
    expect(wrongScheme.body.error).toEqual({ code: "OPERATOR_AUTH_REQUIRED" });

    await request(app).get("/v1/private").set("Authorization", `Bearer ${OPERATOR_TOKEN}`).expect(200);
    await request(app).head("/v1/private").set("Authorization", `Bearer ${OPERATOR_TOKEN}`).expect(200);
    await request(app).post("/v1/private").set("Authorization", `Bearer ${OPERATOR_TOKEN}`).expect(204);
  });

  it("preserves unauthenticated local mode when no operator token is configured", async () => {
    const app = createAuthTestApp(undefined);

    await request(app).get("/v1/private").expect(200);
    await request(app).head("/v1/private").expect(200);
    await request(app).post("/v1/private").expect(204);
  });
});

function createAuthTestApp(operatorToken: string | undefined) {
  const app = express();
  app.use(requireOperatorForPrivateMethods(operatorToken));
  app.get("/health", (_request, response) => response.status(200).json({ status: "ok" }));
  app.options("/v1/private", (_request, response) => response.sendStatus(204));
  app.get("/v1/private", (_request, response) => response.status(200).json({ private: true }));
  app.post("/v1/private", (_request, response) => response.sendStatus(204));

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    if (!(error instanceof ApiError)) {
      next(error);
      return;
    }

    response.status(error.statusCode).json({ error: { code: error.code } });
  };
  app.use(errorHandler);
  return app;
}
