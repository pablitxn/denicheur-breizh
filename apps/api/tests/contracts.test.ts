import { describe, expect, it } from "vitest";

import { filterListingsRequestSchema, MAX_LISTINGS_PER_REQUEST } from "../src/contracts.js";
import { createRequest } from "./fixtures.js";

describe("filterListingsRequestSchema", () => {
  it("accepts a normalized batch at the maximum listing size", () => {
    const request = createRequest(MAX_LISTINGS_PER_REQUEST);

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(true);
  });

  it("accepts an absent title but still rejects a provided empty title", () => {
    const withoutTitle = createRequest();
    withoutTitle.listings[0]!.title = undefined;
    const emptyTitle = createRequest();
    emptyTitle.listings[0]!.title = "";

    expect(filterListingsRequestSchema.safeParse(withoutTitle).success).toBe(true);
    expect(filterListingsRequestSchema.safeParse(emptyTitle).success).toBe(false);
  });

  it("rejects an empty listing batch", () => {
    const request = createRequest();
    request.listings = [];

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });

  it("rejects more than twenty listings", () => {
    const request = createRequest(MAX_LISTINGS_PER_REQUEST + 1);

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });

  it("rejects an empty recipe", () => {
    const request = createRequest();
    request.recipe.criteria = [];

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });

  it("rejects negative criterion weights", () => {
    const request = createRequest();
    request.recipe.criteria[0]!.weight = -1;

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });

  it("rejects duplicate listing identifiers", () => {
    const request = createRequest(2);
    request.listings[1]!.id = request.listings[0]!.id;

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["listings", 1, "id"]);
  });

  it("rejects duplicate criterion identifiers", () => {
    const request = createRequest();
    request.recipe.criteria[1]!.id = request.recipe.criteria[0]!.id;

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["recipe", "criteria", 1, "id"]);
  });

  it("rejects fields that exceed prompt-safe length limits", () => {
    const request = createRequest();
    request.listings[0]!.description = "x".repeat(6_001);

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });

  it("rejects unknown fields instead of forwarding them to the model", () => {
    const request = {
      ...createRequest(),
      secret: "must-not-be-forwarded",
    };

    const result = filterListingsRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
  });
});
