import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  type RuntimeApiConfig,
} from "../api/runtimeConfig";
import {
  prepareRuntimeApiSettingsSave,
  runtimeApiCredentialAppliesToDraft,
} from "./RuntimeApiSettings";

const productionConfig: RuntimeApiConfig = {
  baseUrl: PRODUCTION_API_BASE_URL,
  credential: {
    endpoint: PRODUCTION_API_BASE_URL,
    token: "stored-production-token",
  },
};

describe("runtime API settings credential handling", () => {
  it("keeps the stored credential when the normalized endpoint is unchanged", () => {
    expect(prepareRuntimeApiSettingsSave({
      baseUrl: `${PRODUCTION_API_BASE_URL}/`,
      tokenDraft: "",
      currentConfig: productionConfig,
    })).toEqual({
      baseUrl: PRODUCTION_API_BASE_URL,
      operatorToken: "stored-production-token",
    });
    expect(runtimeApiCredentialAppliesToDraft(productionConfig, `${PRODUCTION_API_BASE_URL}/`))
      .toBe(true);
  });

  it("does not inherit a stored token when the endpoint changes", () => {
    expect(prepareRuntimeApiSettingsSave({
      baseUrl: DEFAULT_API_BASE_URL,
      tokenDraft: "",
      currentConfig: productionConfig,
    })).toEqual({ baseUrl: DEFAULT_API_BASE_URL });
    expect(runtimeApiCredentialAppliesToDraft(productionConfig, DEFAULT_API_BASE_URL)).toBe(false);
  });

  it("binds a re-entered token to the changed endpoint", () => {
    expect(prepareRuntimeApiSettingsSave({
      baseUrl: `${DEFAULT_API_BASE_URL}/`,
      tokenDraft: "  new-local-token  ",
      currentConfig: productionConfig,
    })).toEqual({
      baseUrl: DEFAULT_API_BASE_URL,
      operatorToken: "new-local-token",
    });
  });

  it("preserves a local configuration without requiring a token", () => {
    expect(prepareRuntimeApiSettingsSave({
      baseUrl: `${DEFAULT_API_BASE_URL}/`,
      tokenDraft: "",
      currentConfig: { baseUrl: DEFAULT_API_BASE_URL },
    })).toEqual({ baseUrl: DEFAULT_API_BASE_URL });
  });

  it("treats invalid URL drafts as having no applicable credential", () => {
    expect(runtimeApiCredentialAppliesToDraft(productionConfig, "not a URL")).toBe(false);
  });
});
