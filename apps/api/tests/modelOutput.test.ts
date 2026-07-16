import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import { parseAndValidateModelOutput } from "../src/modelOutput.js";
import { createModelBatch, createRequest } from "./fixtures.js";

describe("parseAndValidateModelOutput", () => {
  it("accepts complete output and restores request ordering", () => {
    const request = createRequest(2);
    const batch = createModelBatch(request);
    batch.results.reverse();
    batch.results.forEach((result) => result.criteria.reverse());

    const result = parseAndValidateModelOutput(JSON.stringify(batch), request);

    expect(result.results.map((listing) => listing.listingId)).toEqual(["listing-1", "listing-2"]);
    expect(result.results[0]!.criteria.map((criterion) => criterion.criterionId)).toEqual([
      "large-enough",
      "quiet",
    ]);
    expect(result.results[1]!.criteria[0]!.evidence).toEqual(["85"]);
  });

  it("rejects non-JSON output", () => {
    expectInvalid("not json", createRequest());
  });

  it("rejects a summary containing only whitespace", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.summary = "   ";

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects a missing listing result", () => {
    const request = createRequest(2);
    const batch = createModelBatch(request);
    batch.results.pop();

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects duplicate listing results", () => {
    const request = createRequest(2);
    const batch = createModelBatch(request);
    batch.results[1]!.listingId = batch.results[0]!.listingId;

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects an unknown listing identifier", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.listingId = "foreign-listing";

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects an incomplete criterion set", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.criteria.pop();

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects duplicate criterion results", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.criteria[1]!.criterionId = batch.results[0]!.criteria[0]!.criterionId;

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects evidence that does not occur in the source listing", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.criteria[0]!.evidence = ["Vue panoramique sur la mer"];

    expectInvalid(JSON.stringify(batch), request);
  });

  it("preserves verbatim evidence in its original language", () => {
    const request = createRequest();
    request.listings[0]!.description = "Maison rénovée, très lumineuse et calme.";
    const batch = createModelBatch(request);
    batch.results[0]!.criteria[1]!.evidence = ["très lumineuse"];

    const parsed = parseAndValidateModelOutput(JSON.stringify(batch), request);

    expect(parsed.results[0]!.criteria[1]!.evidence).toEqual(["très lumineuse"]);
  });

  it.each(["Très lumineuse", "tres lumineuse", "très  lumineuse", "  très lumineuse "])(
    "rejects non-verbatim evidence %s",
    (evidence) => {
      const request = createRequest();
      request.listings[0]!.description = "Maison rénovée, très lumineuse et calme.";
      const batch = createModelBatch(request);
      batch.results[0]!.criteria[1]!.evidence = [evidence];

      expectInvalid(JSON.stringify(batch), request);
    },
  );

  it("rejects pass or fail verdicts without evidence", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.criteria[0]!.evidence = [];

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects model-supplied missingData because the server derives it deterministically", () => {
    const request = createRequest();
    const batch = createModelBatch(request) as unknown as {
      results: Array<Record<string, unknown>>;
    };
    batch.results[0]!.missingData = ["bedrooms"];

    expectInvalid(JSON.stringify(batch), request);
  });

  it("rejects tiny evidence that merely occurs inside a larger text value", () => {
    const request = createRequest();
    const batch = createModelBatch(request);
    batch.results[0]!.criteria[0]!.evidence = ["en"];

    expectInvalid(JSON.stringify(batch), request);
  });
});

function expectInvalid(outputText: string, request: ReturnType<typeof createRequest>): void {
  try {
    parseAndValidateModelOutput(outputText, request);
    expect.fail("Expected model output validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 502, code: "INVALID_MODEL_OUTPUT" });
  }
}
