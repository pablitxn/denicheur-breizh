import { describe, expect, it } from "vitest";

import { FILTER_API_HOST, isChromeExtensionOrigin, loadConfig } from "../src/config.js";

const VALID_EXTENSION_ORIGIN = "chrome-extension://oekklajlieiinmjcmhdfeodpdhahhjdi";

describe("loadConfig", () => {
  it("binds to loopback and allows only the pinned extension origin by default", () => {
    const config = loadConfig({});

    expect(config.host).toBe(FILTER_API_HOST);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4310);
    expect(config.databasePath).toBe(".data/denicheur.sqlite");
    expect(config.evaluatorVersion).toBe("1.1.0");
    expect(config.openAiTimeoutMs).toBe(60_000);
    expect(config.allowedOrigins).toContain(VALID_EXTENSION_ORIGIN);
    expect(config.allowedOrigins).not.toContain("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("switches to exact-origin mode when an allowlist is configured", () => {
    const config = loadConfig({ FILTER_API_ALLOWED_ORIGINS: VALID_EXTENSION_ORIGIN });

    expect(config.allowedOrigins).toEqual(new Set([VALID_EXTENSION_ORIGIN]));
  });

  it("canonicalizes accepted trailing slashes to browser Origin header form", () => {
    const config = loadConfig({
      FILTER_API_ALLOWED_ORIGINS: `${VALID_EXTENSION_ORIGIN}/,http://localhost:5173/`,
    });

    expect(config.allowedOrigins).toEqual(new Set([
      VALID_EXTENSION_ORIGIN,
      "http://localhost:5173",
    ]));
  });

  it("rejects public HTTP origins", () => {
    expect(() => loadConfig({ FILTER_API_ALLOWED_ORIGINS: "https://example.com" })).toThrow(
      /only accepts localhost HTTP origins/i,
    );
  });

  it("accepts a configured port and pinned model", () => {
    const config = loadConfig({
      FILTER_API_PORT: "4500",
      OPENAI_FILTER_MODEL: "gpt-fixed-snapshot",
      DENICHEUR_DB_PATH: ":memory:",
    });

    expect(config.port).toBe(4500);
    expect(config.openAiModel).toBe("gpt-fixed-snapshot");
    expect(config.databasePath).toBe(":memory:");
  });
});

describe("isChromeExtensionOrigin", () => {
  it("accepts only syntactically valid extension origins", () => {
    expect(isChromeExtensionOrigin(VALID_EXTENSION_ORIGIN)).toBe(true);
    expect(isChromeExtensionOrigin("chrome-extension://not-an-extension-id")).toBe(false);
    expect(isChromeExtensionOrigin(`${VALID_EXTENSION_ORIGIN}/page.html`)).toBe(false);
  });
});
