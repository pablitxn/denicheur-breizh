import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { RealtimeFetch } from "../src/realtimeSessionService.js";
import { DenicheurRepository } from "../src/repository.js";

const OFFER_SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";
const ANSWER_SDP = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n";

describe("POST /v1/realtime/session", () => {
  it("proxies SDP through the API without returning its server credential", async () => {
    const fetchImpl = vi.fn<RealtimeFetch>().mockResolvedValue(new Response(ANSWER_SDP, {
      status: 200,
      headers: { "Content-Type": "application/sdp" },
    }));
    const app = createTestApp({ apiKey: "test-realtime-credential", fetchImpl });

    const response = await request(app)
      .post("/v1/realtime/session")
      .set("Origin", "http://127.0.0.1:5173")
      .set("Content-Type", "application/sdp")
      .send(OFFER_SDP)
      .expect(200);

    expect(response.text).toBe(ANSWER_SDP);
    expect(response.headers["content-type"]).toMatch(/^application\/sdp/);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(JSON.stringify(response.headers)).not.toContain("test-realtime-credential");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer test-realtime-credential" },
    });
    expect(init?.body).toBeInstanceOf(FormData);

    const formData = init?.body as FormData;
    expect(formData.get("sdp")).toBe(OFFER_SDP);
    expect(JSON.parse(String(formData.get("session")))).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2",
      audio: { output: { voice: "marin" } },
    });
  });

  it("fails without invoking OpenAI when the API credential is not configured", async () => {
    const fetchImpl = vi.fn<RealtimeFetch>();
    const app = createTestApp({ fetchImpl });

    const response = await request(app)
      .post("/v1/realtime/session")
      .set("Content-Type", "application/sdp")
      .send(OFFER_SDP)
      .expect(503);

    expect(response.body.error).toMatchObject({
      code: "OPENAI_NOT_CONFIGURED",
      message: "Realtime is not configured.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a non-empty application/sdp request", async () => {
    const fetchImpl = vi.fn<RealtimeFetch>();
    const app = createTestApp({ apiKey: "test-realtime-credential", fetchImpl });

    const wrongType = await request(app)
      .post("/v1/realtime/session")
      .send({ sdp: OFFER_SDP })
      .expect(415);
    const empty = await request(app)
      .post("/v1/realtime/session")
      .set("Content-Type", "application/sdp")
      .send("  ")
      .expect(400);

    expect(wrongType.body.error).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
    expect(empty.body.error).toMatchObject({ code: "INVALID_SDP" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes upstream failures instead of proxying their response body", async () => {
    const fetchImpl = vi.fn<RealtimeFetch>().mockResolvedValue(new Response("upstream-private-detail", {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));
    const app = createTestApp({ apiKey: "test-realtime-credential", fetchImpl });

    const response = await request(app)
      .post("/v1/realtime/session")
      .set("Content-Type", "application/sdp")
      .send(OFFER_SDP)
      .expect(503);

    expect(response.body.error).toMatchObject({
      code: "OPENAI_UNAVAILABLE",
      message: "The Realtime service is temporarily unavailable.",
    });
    expect(JSON.stringify(response.body)).not.toContain("upstream-private-detail");
  });
});

function createTestApp(options: { apiKey?: string; fetchImpl: RealtimeFetch }) {
  const repository = new DenicheurRepository({ path: ":memory:" });
  return createApp({
    config: loadConfig(options.apiKey ? { OPENAI_API_KEY: options.apiKey, DENICHEUR_DB_PATH: ":memory:" } : {
      DENICHEUR_DB_PATH: ":memory:",
    }),
    filterService: { filter: vi.fn() },
    repository,
    logger: { info: vi.fn(), error: vi.fn() },
    fetchImpl: options.fetchImpl,
  });
}
