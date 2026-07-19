import { createHash, randomUUID } from "node:crypto";

import {
  evaluationBatchResponseSchema,
  MAX_EVALUATION_IMAGE_URLS,
  type EvaluationBatchItem,
  type EvaluationBatchResponse,
  type EvaluationFailureItem,
  type EvaluationFailureStage,
  type EvaluationRequest,
  type EvaluationSuccessItem,
  type Evaluator,
  type FilterListingInput,
  type FilterListingsResponse,
  type ListingEvaluationRecord,
  type ListingEvaluationResult,
  type ListingRecord,
  type RecipeVersion,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import {
  EVALUATOR_RESPONSE_ID,
  type EvaluationContext,
  type FilterListingsService,
  type FilterListingsServiceResponse,
} from "./filterService.js";
import type { DenicheurRepository, EvaluationAttemptFailure } from "./repository.js";

const EVALUATION_BATCH_SIZE = 3;
const MAX_REPAIR_CALLS_PER_REQUEST = 6;

export interface StoredEvaluationServiceOptions {
  readonly evaluator?: Evaluator;
}

interface PendingEvaluation {
  readonly listing: ListingRecord;
  readonly input: FilterListingInput;
  readonly inputFingerprint: string;
}

interface FailureDetails extends EvaluationAttemptFailure {
  readonly code: string;
  readonly stage: EvaluationFailureStage;
  readonly retryable: boolean;
}

interface EvaluationBudget {
  remainingRepairCalls: number;
}

export class StoredEvaluationService {
  private readonly evaluator: Evaluator;
  private readonly inFlight = new Map<string, Promise<EvaluationBatchResponse>>();

  constructor(
    private readonly repository: DenicheurRepository,
    private readonly filterService: Pick<FilterListingsService, "filter">,
    options: StoredEvaluationServiceOptions = {},
  ) {
    this.evaluator = options.evaluator ?? { provider: "openai", model: "unknown", version: "unknown" };
  }

  async evaluate(
    runId: string,
    request: EvaluationRequest,
    context: EvaluationContext,
  ): Promise<EvaluationBatchResponse> {
    const key = JSON.stringify({
      runId,
      locale: request.locale,
      recipeId: request.recipeId,
      recipeVersion: request.recipeVersion,
      listingIds: [...request.listingIds].sort(),
      force: request.force === true,
    });
    const active = this.inFlight.get(key);
    if (active) {
      return withRequestContext(await active, request.listingIds, context.requestId);
    }

    const operation = this.evaluateOnce(runId, request, context);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }
  }

  private async evaluateOnce(
    runId: string,
    request: EvaluationRequest,
    context: EvaluationContext,
  ): Promise<EvaluationBatchResponse> {
    if (!this.repository.getRun(runId)) {
      throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
    }

    const recipe = this.repository.getRecipe(request.recipeId, request.recipeVersion);
    if (!recipe) {
      throw new ApiError(404, "RECIPE_NOT_FOUND", "The requested recipe version does not exist.");
    }

    const listings = this.repository.getListingsForEvaluation(runId, request.listingIds);
    if (!listings) {
      throw new ApiError(404, "LISTING_NOT_FOUND", "One or more listings do not belong to the requested run.");
    }

    const itemsById = new Map<string, EvaluationBatchItem>();
    const pending: PendingEvaluation[] = [];
    const budget: EvaluationBudget = {
      remainingRepairCalls: Math.min(MAX_REPAIR_CALLS_PER_REQUEST, request.listingIds.length),
    };
    for (const listing of listings) {
      const input = toFilterListing(listing);
      const inputFingerprint = createInputFingerprint(input, recipe, request.locale, this.evaluator);
      const existing = request.force
        ? undefined
        : this.repository.findEvaluation(runId, listing, request, inputFingerprint);
      if (existing) {
        itemsById.set(listing.id, toSuccessItem(existing, "cached"));
      } else {
        pending.push({ listing, input, inputFingerprint });
      }
    }

    for (const batch of chunks(pending, EVALUATION_BATCH_SIZE)) {
      const outcomes = await this.evaluateBatch(runId, request, recipe, batch, context, budget);
      for (const outcome of outcomes) {
        itemsById.set(outcome.listingId, outcome);
      }
    }

    const items = request.listingIds.map((listingId) => {
      const item = itemsById.get(listingId);
      if (!item) throw new Error("The requested evaluation outcome is missing.");
      return item;
    });
    const successCount = items.filter((item) => item.status !== "failed").length;

    return evaluationBatchResponseSchema.parse({
      requestId: context.requestId,
      runId,
      locale: request.locale,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      status: successCount === 0 ? "failed" : successCount === items.length ? "completed" : "partial",
      items,
    });
  }

  private async evaluateBatch(
    runId: string,
    request: EvaluationRequest,
    recipe: RecipeVersion,
    batch: readonly PendingEvaluation[],
    context: EvaluationContext,
    budget: EvaluationBudget,
  ): Promise<EvaluationBatchItem[]> {
    const attempts = this.startAttempts(runId, request, batch, context.requestId);
    if ("failure" in attempts) {
      return batch.map((pending) => toFailureItem(pending.listing.id, attempts.failure, context.requestId));
    }

    try {
      const response = await this.callFilter(runId, request, recipe, batch, context);
      assertCompleteFilterResponse(response, batch);
      return batch.map((pending) => this.persistResponseItem(
        runId,
        request,
        pending,
        response,
        attempts.attemptIds.get(pending.listing.id),
        context.requestId,
      ));
    } catch (error) {
      const failure = classifyEvaluationFailure(error);
      for (const attemptId of attempts.attemptIds.values()) {
        this.tryFailAttempt(attemptId, failure);
      }

      if (!isRepairableInvalidModelOutput(error, failure)) {
        return batch.map((pending) => toFailureItem(
          pending.listing.id,
          failure,
          context.requestId,
          attempts.attemptIds.get(pending.listing.id),
        ));
      }

      if (batch.length === 1) {
        const pending = batch[0];
        if (!pending) throw new Error("A non-empty evaluation batch was expected.");
        if (!consumeRepairCall(budget)) {
          return [toFailureItem(
            pending.listing.id,
            failure,
            context.requestId,
            attempts.attemptIds.get(pending.listing.id),
          )];
        }
        return [await this.evaluateSingle(runId, request, recipe, pending, context, 1)];
      }

      const isolated: EvaluationBatchItem[] = [];
      for (const pending of batch) {
        if (consumeRepairCall(budget)) {
          isolated.push(await this.evaluateSingle(runId, request, recipe, pending, context, 1));
        } else {
          isolated.push(toFailureItem(
            pending.listing.id,
            failure,
            context.requestId,
            attempts.attemptIds.get(pending.listing.id),
          ));
        }
      }
      return isolated;
    }
  }

  private async evaluateSingle(
    runId: string,
    request: EvaluationRequest,
    recipe: RecipeVersion,
    pending: PendingEvaluation,
    context: EvaluationContext,
    maximumAttempts: number,
  ): Promise<EvaluationBatchItem> {
    let lastFailure: FailureDetails | undefined;
    let lastAttemptId: string | undefined;

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const started = this.startAttempts(runId, request, [pending], context.requestId);
      if ("failure" in started) {
        return toFailureItem(pending.listing.id, started.failure, context.requestId);
      }
      const attemptId = started.attemptIds.get(pending.listing.id);
      if (!attemptId) throw new Error("The evaluation attempt id is missing.");
      lastAttemptId = attemptId;

      try {
        const response = await this.callFilter(runId, request, recipe, [pending], context);
        assertCompleteFilterResponse(response, [pending]);
        return this.persistResponseItem(
          runId,
          request,
          pending,
          response,
          attemptId,
          context.requestId,
        );
      } catch (error) {
        lastFailure = classifyEvaluationFailure(error);
        this.tryFailAttempt(attemptId, lastFailure);
        if (!isInvalidModelOutput(error)) break;
      }
    }

    return toFailureItem(
      pending.listing.id,
      lastFailure ?? internalFailure(),
      context.requestId,
      lastAttemptId,
    );
  }

  private startAttempts(
    runId: string,
    request: EvaluationRequest,
    batch: readonly PendingEvaluation[],
    requestId: string,
  ): { readonly attemptIds: ReadonlyMap<string, string> } | { readonly failure: FailureDetails } {
    const attemptIds = new Map<string, string>();
    try {
      for (const pending of batch) {
        const attemptId = randomUUID();
        this.repository.startEvaluationAttempt({
          attemptId,
          requestId,
          runId,
          listingId: pending.listing.id,
          recipeId: request.recipeId,
          recipeVersion: request.recipeVersion,
          locale: request.locale,
          inputFingerprint: pending.inputFingerprint,
        });
        attemptIds.set(pending.listing.id, attemptId);
      }
      return { attemptIds };
    } catch {
      const failure = persistenceFailure();
      for (const attemptId of attemptIds.values()) {
        this.tryFailAttempt(attemptId, failure);
      }
      return { failure };
    }
  }

  private callFilter(
    runId: string,
    request: EvaluationRequest,
    recipe: RecipeVersion,
    batch: readonly PendingEvaluation[],
    context: EvaluationContext,
  ): Promise<FilterListingsServiceResponse> {
    return this.filterService.filter({
      runId,
      locale: request.locale,
      recipe: {
        id: recipe.id,
        version: recipe.version,
        name: recipe.name,
        threshold: recipe.threshold,
        criteria: recipe.criteria,
      },
      listings: batch.map((pending) => pending.input),
    }, context);
  }

  private persistResponseItem(
    runId: string,
    request: EvaluationRequest,
    pending: PendingEvaluation,
    response: FilterListingsServiceResponse,
    attemptId: string | undefined,
    requestId: string,
  ): EvaluationBatchItem {
    if (!attemptId) return toFailureItem(pending.listing.id, persistenceFailure(), requestId);
    const result = response.results.find((candidate) => candidate.listingId === pending.listing.id);
    if (!result) {
      const failure: FailureDetails = {
        code: "MISSING_LISTING",
        stage: "semantic",
        retryable: true,
      };
      this.tryFailAttempt(attemptId, failure);
      return toFailureItem(pending.listing.id, failure, requestId, attemptId);
    }

    try {
      const record = this.repository.saveEvaluationResult({
        attemptId,
        runId,
        locale: request.locale,
        recipeId: request.recipeId,
        recipeVersion: request.recipeVersion,
        evaluator: response.evaluator,
        result,
        inputFingerprint: pending.inputFingerprint,
        ...(response[EVALUATOR_RESPONSE_ID]
          ? { responseId: response[EVALUATOR_RESPONSE_ID] }
          : {}),
      });
      return toSuccessItem(record, "succeeded", attemptId);
    } catch {
      const failure = persistenceFailure();
      this.tryFailAttempt(attemptId, failure);
      return toFailureItem(pending.listing.id, failure, requestId, attemptId);
    }
  }

  private tryFailAttempt(attemptId: string, failure: FailureDetails): void {
    try {
      this.repository.failEvaluationAttempt(attemptId, failure);
    } catch {
      // Preserve a safe public result even when attempt bookkeeping is unavailable.
    }
  }
}

function createInputFingerprint(
  listing: FilterListingInput,
  recipe: RecipeVersion,
  locale: EvaluationRequest["locale"],
  evaluator: Evaluator,
): string {
  return createHash("sha256").update(JSON.stringify({
    listing,
    recipe: {
      id: recipe.id,
      version: recipe.version,
      name: recipe.name,
      threshold: recipe.threshold,
      criteria: recipe.criteria,
    },
    locale,
    evaluator,
  })).digest("hex");
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function toSuccessItem(
  record: ListingEvaluationRecord,
  status: EvaluationSuccessItem["status"],
  attemptId?: string,
): EvaluationSuccessItem {
  const evaluation = toEvaluationResult(record);
  if (status === "succeeded") {
    if (!attemptId) throw new Error("A succeeded evaluation must reference its attempt.");
    return {
      listingId: record.listingId,
      status,
      evaluation,
      evaluator: record.evaluator,
      attemptId,
    };
  }
  return {
    listingId: record.listingId,
    status,
    evaluation,
    evaluator: record.evaluator,
  };
}

function toFailureItem(
  listingId: string,
  failure: FailureDetails,
  requestId: string,
  attemptId?: string,
): EvaluationFailureItem {
  return {
    listingId,
    status: "failed",
    error: {
      code: failure.code,
      stage: failure.stage,
      retryable: failure.retryable,
      requestId,
      ...(attemptId ? { attemptId } : {}),
      ...(failure.criterionId ? { criterionId: failure.criterionId } : {}),
    },
  };
}

function classifyEvaluationFailure(error: unknown): FailureDetails {
  if (!(error instanceof ApiError)) return internalFailure();
  const stage = readFailureStage(error) ?? (error.code === "INVALID_MODEL_OUTPUT" ? "semantic" : "provider");
  const detailCode = readStringProperty(error, "detailCode");
  const responseId = readStringProperty(error, "responseId");
  const criterionId = readStringProperty(error, "criterionId");
  return {
    code: stage === "provider" ? error.code : detailCode ?? error.code,
    stage,
    retryable: readBooleanProperty(error, "retryable") ?? [
      "INVALID_MODEL_OUTPUT",
      "OPENAI_TIMEOUT",
      "OPENAI_RATE_LIMITED",
      "OPENAI_UNAVAILABLE",
    ].includes(error.code),
    ...(responseId ? { responseId } : {}),
    ...(criterionId ? { criterionId } : {}),
  };
}

function assertCompleteFilterResponse(
  response: FilterListingsResponse,
  batch: readonly PendingEvaluation[],
): void {
  const expectedIds = new Set(batch.map((pending) => pending.listing.id));
  const actualIds = response.results.map((result) => result.listingId);
  if (
    actualIds.length !== expectedIds.size ||
    new Set(actualIds).size !== actualIds.length ||
    actualIds.some((listingId) => !expectedIds.has(listingId))
  ) {
    throw new ApiError(502, "INVALID_MODEL_OUTPUT", "The evaluator returned an invalid result.");
  }
}

function isInvalidModelOutput(error: unknown): boolean {
  return error instanceof ApiError && error.code === "INVALID_MODEL_OUTPUT";
}

function isRepairableInvalidModelOutput(error: unknown, failure: FailureDetails): boolean {
  return isInvalidModelOutput(error) &&
    failure.retryable &&
    ["response", "parse", "schema", "semantic"].includes(failure.stage);
}

function withRequestContext(
  response: EvaluationBatchResponse,
  listingIds: readonly string[],
  requestId: string,
): EvaluationBatchResponse {
  const itemsById = new Map(response.items.map((item) => [item.listingId, item]));
  return {
    ...response,
    requestId,
    items: listingIds.map((listingId) => {
      const item = itemsById.get(listingId);
      if (!item) throw new Error("The coalesced evaluation outcome is missing a listing.");
      return item;
    }),
  };
}

function consumeRepairCall(budget: EvaluationBudget): boolean {
  if (budget.remainingRepairCalls <= 0) return false;
  budget.remainingRepairCalls -= 1;
  return true;
}

function readFailureStage(value: unknown): EvaluationFailureStage | undefined {
  const stage = readStringProperty(value, "stage");
  return stage && ["provider", "response", "parse", "schema", "semantic", "persistence", "internal"].includes(stage)
    ? stage as EvaluationFailureStage
    : undefined;
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readBooleanProperty(value: unknown, property: string): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function persistenceFailure(): FailureDetails {
  return { code: "PERSISTENCE_FAILURE", stage: "persistence", retryable: true };
}

function internalFailure(): FailureDetails {
  return { code: "EVALUATION_FAILED", stage: "internal", retryable: false };
}

function toFilterListing(listing: ListingRecord): FilterListingInput {
  const imageUrls = selectEvaluationImageUrls(listing);

  return {
    id: listing.id,
    url: listing.url,
    ...(listing.title ? { title: listing.title } : {}),
    ...(listing.priceEuros !== undefined ? { priceEuros: listing.priceEuros } : {}),
    ...(listing.propertyType ? { propertyType: listing.propertyType } : {}),
    ...(listing.rooms !== undefined ? { rooms: listing.rooms } : {}),
    ...(listing.bedrooms !== undefined ? { bedrooms: listing.bedrooms } : {}),
    ...(listing.surfaceM2 !== undefined ? { surfaceM2: listing.surfaceM2 } : {}),
    ...(listing.landSurfaceM2 !== undefined ? { landSurfaceM2: listing.landSurfaceM2 } : {}),
    ...(listing.location ? { location: listing.location } : {}),
    ...(listing.sellerName ? { sellerName: listing.sellerName } : {}),
    ...(listing.sellerType ? { sellerType: listing.sellerType } : {}),
    ...(listing.energyClass ? { energyClass: listing.energyClass } : {}),
    ...(listing.gesClass ? { gesClass: listing.gesClass } : {}),
    ...(listing.description ? { description: listing.description } : {}),
    features: listing.features ?? [],
    ...(imageUrls.length ? { imageUrls } : {}),
  };
}

function selectEvaluationImageUrls(listing: ListingRecord): string[] {
  const selected: string[] = [];
  const seenImages = new Set<string>();
  const candidates = [
    ...(listing.imageUrl ? [listing.imageUrl] : []),
    ...(listing.imageUrls ?? []),
  ];

  for (const candidate of candidates) {
    if (candidate.length > 500) continue;
    const parsed = new URL(candidate);
    const imageIdentity = `${parsed.origin}${parsed.pathname}`;
    if (seenImages.has(imageIdentity)) continue;
    seenImages.add(imageIdentity);
    selected.push(candidate);
    if (selected.length === MAX_EVALUATION_IMAGE_URLS) break;
  }

  return selected;
}

function toEvaluationResult(record: ListingEvaluationRecord): ListingEvaluationResult {
  return {
    listingId: record.listingId,
    decision: record.decision,
    score: record.score,
    summary: record.summary,
    criteria: record.criteria,
    missingData: record.missingData,
    evaluatedAt: record.evaluatedAt,
  };
}
