import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import {
  buildEvidenceCatalog,
  buildModelOutputJsonSchema,
  parseAndValidateModelOutput,
} from "../src/modelOutput.js";
import { createGeneratedModelOutput, createRequest } from "./fixtures.js";

describe("buildEvidenceCatalog", () => {
  it("creates stable references for fields, description chunks, features, and images", () => {
    const request = createRequest();
    request.listings[0]!.description = `${"mot ".repeat(150)}fin`;
    request.listings[0]!.imageUrls = ["https://img.leboncoin.fr/house.jpg"];

    const catalog = buildEvidenceCatalog(request.listings[0]!);

    expect(catalog).toEqual(expect.arrayContaining([
      { id: "field:surfaceM2", kind: "field", value: "85" },
      { id: "feature:0", kind: "feature", value: "Jardin" },
      { id: "image:0", kind: "image", value: "https://img.leboncoin.fr/house.jpg" },
    ]));
    expect(catalog.filter((entry) => entry.kind === "description").length).toBeGreaterThan(1);
    expect(catalog.every((entry) => entry.value.length <= 500)).toBe(true);
    expect(catalog.some((entry) => entry.value === request.listings[0]!.url)).toBe(false);
  });
});

describe("buildModelOutputJsonSchema", () => {
  it("requires the exact listing and criterion keys with per-listing evidence enums", () => {
    const request = createRequest(2);
    request.listings[0]!.imageUrls = ["https://img.leboncoin.fr/first.jpg"];
    request.listings[1]!.imageUrls = undefined;

    const schema = buildModelOutputJsonSchema(request) as unknown as ModelSchema;
    const results = schema.properties.results;
    const firstCriteria = results.properties["listing-1"]!.properties.criteria;
    const secondCriteria = results.properties["listing-2"]!.properties.criteria;
    const firstCriterion = schema.$defs.criterion0 as CriterionSchema;
    const firstEvidence = schema.$defs.evidenceId0 as EvidenceIdSchema;
    const secondEvidence = schema.$defs.evidenceId1 as EvidenceIdSchema;

    expect(results.required).toEqual(["listing-1", "listing-2"]);
    expect(results.additionalProperties).toBe(false);
    expect(firstCriteria.required).toEqual(["large-enough", "quiet"]);
    expect(firstCriteria.additionalProperties).toBe(false);
    expect(firstCriteria.properties["large-enough"]!.$ref).toBe("#/$defs/criterion0");
    expect(secondCriteria.properties["large-enough"]!.$ref).toBe("#/$defs/criterion1");
    expect(firstEvidence.enum).toContain("image:0");
    expect(secondEvidence.enum).not.toContain("image:0");
    expect(firstCriterion.properties.reason).toMatchObject({
      minLength: 1,
      maxLength: 1_000,
    });
  });

  it("only permits unknown with an empty evidence array when a listing has no evidence", () => {
    const request = createRequest();
    Object.assign(request.listings[0]!, {
      title: undefined,
      priceEuros: undefined,
      propertyType: undefined,
      rooms: undefined,
      bedrooms: undefined,
      surfaceM2: undefined,
      landSurfaceM2: undefined,
      location: undefined,
      sellerName: undefined,
      sellerType: undefined,
      energyClass: undefined,
      gesClass: undefined,
      description: undefined,
      features: [],
      imageUrls: undefined,
    });

    const schema = buildModelOutputJsonSchema(request) as unknown as ModelSchema;
    const criterion = schema.$defs.criterion0 as CriterionSchema;

    expect(criterion.properties.verdict.enum).toEqual(["unknown"]);
    expect(criterion.properties.evidenceIds.maxItems).toBe(0);
  });
});

describe("parseAndValidateModelOutput", () => {
  it("resolves server evidence IDs and restores request ordering", () => {
    const request = createRequest(2);
    const output = createGeneratedModelOutput(request);
    output.results = Object.fromEntries(Object.entries(output.results).reverse());
    for (const listing of Object.values(output.results)) {
      listing.criteria = Object.fromEntries(Object.entries(listing.criteria).reverse());
    }

    const result = parseAndValidateModelOutput(JSON.stringify(output), request);

    expect(result.results.map((listing) => listing.listingId)).toEqual(["listing-1", "listing-2"]);
    expect(result.results[0]!.criteria.map((criterion) => criterion.criterionId)).toEqual([
      "large-enough",
      "quiet",
    ]);
    expect(result.results[0]!.criteria[0]!.evidence).toEqual(["85"]);
    expect(result.results[0]!.criteria[1]!.evidence).toEqual([
      "Maison lumineuse dans un environnement calme.",
    ]);
  });

  it("accepts the full 260-character stable listing key supported by the public contract", () => {
    const request = createRequest();
    const listingId = `leboncoin:${"1".repeat(250)}`;
    request.listings[0]!.id = listingId;

    const parsed = parseAndValidateModelOutput(
      JSON.stringify(createGeneratedModelOutput(request)),
      request,
    );

    expect(parsed.results[0]?.listingId).toBe(listingId);
  });

  it("classifies malformed JSON separately from schema and semantic errors", () => {
    expectInvalid("not json", createRequest(), {
      stage: "parse",
      detailCode: "INVALID_JSON",
    });
  });

  it("reports the known listing and criterion for a schema mismatch", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.reason = "   ";

    expectInvalid(JSON.stringify(output), request, {
      stage: "schema",
      detailCode: "SCHEMA_MISMATCH",
      listingId: "listing-1",
      criterionId: "large-enough",
    });
  });

  it("reports a missing listing without exposing model content", () => {
    const request = createRequest(2);
    const output = createGeneratedModelOutput(request);
    delete output.results["listing-2"];

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "MISSING_LISTING",
      listingId: "listing-2",
    });
  });

  it("reports an unexpected listing", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["foreign-listing"] = output.results["listing-1"]!;

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "UNEXPECTED_LISTING",
      listingId: "foreign-listing",
    });
  });

  it("reports a missing criterion with its listing context", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    delete output.results["listing-1"]!.criteria.quiet;

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "MISSING_CRITERION",
      listingId: "listing-1",
      criterionId: "quiet",
    });
  });

  it("reports an unexpected criterion with its listing context", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria.foreign = output.results["listing-1"]!.criteria.quiet!;

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "UNEXPECTED_CRITERION",
      listingId: "listing-1",
      criterionId: "foreign",
    });
  });

  it("requires evidence for pass and fail verdicts", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.evidenceIds = [];

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "EVIDENCE_REQUIRED",
      listingId: "listing-1",
      criterionId: "large-enough",
    });
  });

  it("rejects an unknown evidence ID instead of fuzzy-matching model text", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.evidenceIds = ["invented:sea-view"];

    expectInvalid(JSON.stringify(output), request, {
      stage: "semantic",
      detailCode: "UNKNOWN_EVIDENCE_ID",
      listingId: "listing-1",
      criterionId: "large-enough",
    });
  });

  it("rejects an image reference from a listing that has no such image", () => {
    const request = createRequest(2);
    request.listings[1]!.imageUrls = ["https://img.leboncoin.fr/second.jpg"];
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.evidenceIds = ["image:0"];

    expectInvalid(JSON.stringify(output), request, {
      detailCode: "UNKNOWN_EVIDENCE_ID",
      listingId: "listing-1",
      criterionId: "large-enough",
    });
  });

  it("rejects duplicate evidence references", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.evidenceIds = [
      "field:surfaceM2",
      "field:surfaceM2",
    ];

    expectInvalid(JSON.stringify(output), request, {
      detailCode: "DUPLICATE_EVIDENCE_ID",
      listingId: "listing-1",
      criterionId: "large-enough",
    });
  });

  it("resolves visual evidence back to the exact supplied image URL", () => {
    const request = createRequest();
    const imageUrl = "https://img.leboncoin.fr/white-house.jpg?rule=classified-1200x800-webp";
    request.listings[0]!.imageUrls = [imageUrl];
    const output = createGeneratedModelOutput(request);
    output.results["listing-1"]!.criteria["large-enough"]!.evidenceIds = ["image:0"];

    const parsed = parseAndValidateModelOutput(JSON.stringify(output), request);

    expect(parsed.results[0]!.criteria[0]!.evidence).toEqual([imageUrl]);
  });

  it("rejects output fields that the server derives deterministically", () => {
    const request = createRequest();
    const output = createGeneratedModelOutput(request) as unknown as {
      results: Record<string, Record<string, unknown>>;
    };
    output.results["listing-1"]!.missingData = ["bedrooms"];

    expectInvalid(JSON.stringify(output), request, {
      stage: "schema",
      detailCode: "SCHEMA_MISMATCH",
      listingId: "listing-1",
    });
  });

  it("propagates the safe provider response id into validation failures", () => {
    expectInvalid("not json", createRequest(), {
      stage: "parse",
      detailCode: "INVALID_JSON",
      responseId: "resp_123",
    }, { responseId: "resp_123" });
  });
});

function expectInvalid(
  outputText: string,
  request: ReturnType<typeof createRequest>,
  expected: Partial<ApiError>,
  options: { responseId?: string } = {},
): void {
  try {
    parseAndValidateModelOutput(outputText, request, options);
    expect.fail("Expected model output validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 502,
      code: "INVALID_MODEL_OUTPUT",
      retryable: true,
      ...expected,
    });
  }
}

interface CriterionSchema {
  properties: {
    verdict: { enum: string[] };
    reason: { minLength: number; maxLength: number };
    evidenceIds: { maxItems: number; items: { $ref?: string } };
  };
}

interface EvidenceIdSchema {
  enum: string[];
}

interface CriteriaSchema {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { $ref: string }>;
}

interface ListingSchema {
  properties: { criteria: CriteriaSchema };
}

interface ModelSchema {
  $defs: Record<string, CriterionSchema | EvidenceIdSchema>;
  properties: {
    results: {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, ListingSchema>;
    };
  };
}
