import { describe, expect, it, vi } from "vitest";
import { integerTicks, ProviderTransportError, redactProviderValue, requestJson } from "./http.js";

describe("provider transport", () => {
  it("redacts echoed credentials in nested evidence without hiding cost or source data", () => {
    expect(redactProviderValue({
      message: "Request used secret-key then Bearer something-sensitive",
      nested: [{ authorization: "anything", apiKey: "secret-key", url: "https://www.leboncoin.fr/ad/1" }],
      usage: { cost_in_usd_ticks: 120 },
    }, ["secret-key"])).toEqual({
      message: "Request used [REDACTED] then Bearer [REDACTED]",
      nested: [{ authorization: "[REDACTED]", apiKey: "[REDACTED]", url: "https://www.leboncoin.fr/ad/1" }],
      usage: { cost_in_usd_ticks: 120 },
    });
  });

  it("never automatically retries a POST whose outcome is unknown", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("secret-key"));
    await expect(requestJson({ fetch, url: "https://api.x.ai/v1/responses", apiKey: "secret-key", method: "POST", body: {} }))
      .rejects.toMatchObject({ outcomeUnknown: true, status: null, message: "Provider connection failed." });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("does not dispatch or invent uncertain spend when already cancelled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(requestJson({ fetch, url: "https://api.x.ai/v1/responses", apiKey: "key", method: "POST", body: {}, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ outcomeUnknown: false, status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps redacted HTTP failure evidence and does not mark read-only failures as unknown spend", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "secret-key" }), { status: 503 }));
    try {
      await requestJson({ fetch, url: "https://api.firecrawl.dev/v2/agent/id", apiKey: "secret-key", method: "GET" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderTransportError);
      expect(error).toMatchObject({ status: 503, response: { error: "[REDACTED]" }, outcomeUnknown: false });
    }
  });

  it("treats a successful non-JSON response to a POST as uncertain, rather than zero cost", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("<html>upstream proxy</html>"));
    await expect(requestJson({ fetch, url: "https://api.x.ai/v1/responses", apiKey: "key", method: "POST", body: {} }))
      .rejects.toMatchObject({ outcomeUnknown: true, status: 200 });
  });

  it("preserves integer billing precision and rejects unsafe, absent and negative values", () => {
    expect(integerTicks("9007199254740993")).toBe("9007199254740993");
    expect(integerTicks(123)).toBe("123");
    expect(integerTicks(0)).toBe("0");
    for (const value of [undefined, null, -1, "-1", Number.MAX_SAFE_INTEGER + 1, 1.1, "1.1"]) {
      expect(integerTicks(value)).toBeNull();
    }
  });
});
