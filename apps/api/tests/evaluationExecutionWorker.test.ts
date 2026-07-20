import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationBatchResponse,
  EvaluationRequest,
  ListingIngestion,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { EvaluationExecutionService } from "../src/evaluationExecutionService.js";
import { EvaluationExecutionWorker } from "../src/evaluationExecutionWorker.js";
import type { StoredEvaluationService } from "../src/evaluationService.js";
import { DenicheurRepository } from "../src/repository.js";

const INITIAL_NOW = new Date("2026-07-19T10:00:00.000Z");
const EVALUATOR = { provider: "openai" as const, model: "gpt-test", version: "3.0.0" };

describe("EvaluationExecutionWorker", () => {
  it("evaluates one recipe in a multi-listing chunk and persists provenance", async () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 3);
    const calls: EvaluationRequest[] = [];
    const worker = new EvaluationExecutionWorker(seeded.repository, successfulService(calls), {
      ownerId: "worker-1",
      now: clock.now,
    });
    createExecution(seeded, "execution-batch");

    worker.start();
    await worker.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.listingIds).toEqual(seeded.listingIds);
    expect(seeded.repository.getEvaluationExecution("execution-batch")).toMatchObject({
      status: "completed",
      counters: { total: 3, processed: 3, relevant: 3, failed: 0 },
    });
    const results = seeded.repository.getEvaluationExecutionResults("execution-batch");
    expect(results?.items).toHaveLength(3);
    expect(results?.items[0]?.steps[0]).toMatchObject({
      status: "succeeded",
      evaluator: EVALUATOR,
    });
    await worker.dispose();
    seeded.repository.close();
  });

  it("resumes only unfinished checkpoints and uses cache semantics for running work", async () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 2);
    createExecution(seeded, "execution-resume", true);
    expect(seeded.repository.claimNextEvaluationExecution("dead-worker", 1_000)?.id).toBe("execution-resume");
    const claimed = seeded.repository.claimEvaluationExecutionStepBatch(
      "execution-resume",
      "dead-worker",
      seeded.recipeId,
      1,
      20,
    );
    expect(claimed).toHaveLength(2);
    seeded.repository.completeEvaluationExecutionStep(
      "execution-resume",
      "dead-worker",
      seeded.listingIds[0]!,
      succeededStep(seeded.recipeId, seeded.listingIds[0]!),
    );
    clock.advance(2_000);

    const calls: EvaluationRequest[] = [];
    const restarted = new EvaluationExecutionWorker(seeded.repository, successfulService(calls), {
      ownerId: "restarted-worker",
      leaseDurationMs: 1_000,
      now: clock.now,
    });
    restarted.start();
    await restarted.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ listingIds: [seeded.listingIds[1]] });
    expect(calls[0]).not.toHaveProperty("force");
    expect(seeded.repository.getEvaluationExecution("execution-resume")?.status).toBe("completed");
    expect(seeded.repository.getEvaluationExecutionResults("execution-resume")?.items).toHaveLength(2);
    await restarted.dispose();
    seeded.repository.close();
  });

  it("allows only one live lease, reclaims an expired lease, and cancels a crashed execution", () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 1);
    createExecution(seeded, "execution-lease");

    expect(seeded.repository.claimNextEvaluationExecution("worker-a", 1_000)?.id).toBe("execution-lease");
    expect(seeded.repository.claimNextEvaluationExecution("worker-b", 1_000)).toBeUndefined();
    clock.advance(1_001);
    expect(seeded.repository.requestEvaluationExecutionCancellation("execution-lease")?.status).toBe("cancelled");
    expect(seeded.repository.claimNextEvaluationExecution("worker-b", 1_000)).toBeUndefined();
    seeded.repository.close();
  });

  it("finishes cancellation when it races with lease renewal", async () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 1);
    createExecution(seeded, "execution-cancel-race");
    const calls: EvaluationRequest[] = [];
    const worker = new EvaluationExecutionWorker(seeded.repository, successfulService(calls), {
      ownerId: "worker-race",
      now: clock.now,
    });
    vi.spyOn(seeded.repository, "renewEvaluationExecutionLease").mockImplementationOnce((id) => {
      seeded.repository.requestEvaluationExecutionCancellation(id);
      return false;
    });

    worker.start();
    await worker.drain();

    expect(seeded.repository.getEvaluationExecution("execution-cancel-race")?.status).toBe("cancelled");
    expect(calls).toEqual([]);
    await worker.dispose();
    seeded.repository.close();
  });
});

describe("EvaluationExecutionService", () => {
  it("replays an omitted-scope request after new ingestion without changing its execution", () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 1);
    let kicks = 0;
    const service = new EvaluationExecutionService(seeded.repository, { kick: () => { kicks += 1; } });
    const request = {
      planId: seeded.planId,
      planVersion: 1,
      locale: "fr" as const,
    };

    const first = service.create(seeded.runId, request, "same-payload-key");
    seeded.repository.ingest({
      run: { id: seeded.runId, source: "leboncoin", status: "completed" },
      listings: [createListing(99)],
    });
    const replay = service.create(seeded.runId, request, "same-payload-key");

    expect(replay.created).toBe(false);
    expect(replay.execution.id).toBe(first.execution.id);
    expect(replay.execution.listingIds).toEqual(seeded.listingIds);
    expect(kicks).toBe(1);
    expect(() => service.create(seeded.runId, { ...request, locale: "es" }, "same-payload-key"))
      .toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
    seeded.repository.close();
  });

  it("blocks cleanup while queued and preserves plans after terminal cleanup", () => {
    const clock = mutableClock();
    const seeded = seedRepository(clock, 1);
    const service = new EvaluationExecutionService(seeded.repository, { kick: () => undefined });
    const created = service.create(seeded.runId, {
      planId: seeded.planId,
      planVersion: 1,
      locale: "fr",
    }, "cleanup-key").execution;

    expectApiError(
      () => seeded.repository.clearCollectedData({ allowActiveRun: true }),
      "ACTIVE_EVALUATION_EXECUTION",
    );
    expect(service.cancel(created.id).status).toBe("cancelled");
    seeded.repository.clearCollectedData({ allowActiveRun: true });
    expect(seeded.repository.getEvaluationExecution(created.id)).toBeUndefined();
    expect(seeded.repository.getEvaluationPlan(seeded.planId, 1)).toBeDefined();
    expect(seeded.repository.getRecipe(seeded.recipeId, 1)).toBeDefined();
    seeded.repository.close();
  });
});

interface SeededRepository {
  readonly repository: DenicheurRepository;
  readonly runId: string;
  readonly recipeId: string;
  readonly planId: string;
  readonly listingIds: string[];
}

function seedRepository(clock: ReturnType<typeof mutableClock>, listingCount: number): SeededRepository {
  const repository = new DenicheurRepository({ path: ":memory:", now: clock.now });
  const runId = "run-execution";
  const listings = Array.from({ length: listingCount }, (_, index) => createListing(index + 1));
  repository.ingest({
    run: { id: runId, source: "leboncoin", status: "completed" },
    listings,
  });
  const recipe = repository.saveRecipe("recipe-execution", {
    name: "Garden",
    threshold: 60,
    criteria: [{
      id: "garden",
      name: "Garden",
      description: "The listing should mention a garden.",
      weight: 1,
      required: false,
    }],
  });
  const plan = repository.saveEvaluationPlan("plan-execution", {
    name: "Complete search",
    operator: "all",
    recipes: [{ recipeId: recipe.id, recipeVersion: recipe.version }],
  });
  return {
    repository,
    runId,
    recipeId: recipe.id,
    planId: plan.id,
    listingIds: listings.map((listing) => `leboncoin:${listing.externalId}`),
  };
}

function createExecution(seeded: SeededRepository, id: string, force = false): void {
  seeded.repository.createEvaluationExecution({
    id,
    runId: seeded.runId,
    request: {
      planId: seeded.planId,
      planVersion: 1,
      locale: "en",
      listingIds: seeded.listingIds,
      force,
    },
    listingIds: seeded.listingIds,
    idempotencyKey: `${id}-key`,
    requestFingerprint: `${id}-fingerprint`,
  });
}

function successfulService(calls: EvaluationRequest[]): Pick<StoredEvaluationService, "evaluate"> {
  return {
    async evaluate(runId, request, context): Promise<EvaluationBatchResponse> {
      calls.push(request);
      return {
        requestId: context.requestId,
        runId,
        locale: request.locale,
        recipeId: request.recipeId,
        recipeVersion: request.recipeVersion,
        status: "completed",
        items: request.listingIds.map((listingId, index) => ({
          listingId,
          status: "succeeded" as const,
          attemptId: `attempt-${index}`,
          evaluator: EVALUATOR,
          evaluation: evaluation(listingId),
        })),
      };
    },
  };
}

function succeededStep(recipeId: string, listingId: string) {
  return {
    recipeId,
    recipeVersion: 1,
    status: "succeeded" as const,
    evaluator: EVALUATOR,
    evaluation: evaluation(listingId),
  };
}

function evaluation(listingId: string) {
  return {
    listingId,
    decision: "relevant" as const,
    score: 90,
    summary: "The garden is present.",
    criteria: [{
      criterionId: "garden",
      verdict: "pass" as const,
      reason: "The garden is explicitly mentioned.",
      evidence: ["garden"],
    }],
    missingData: [],
    evaluatedAt: INITIAL_NOW.toISOString(),
  };
}

function createListing(index: number): ListingIngestion {
  return {
    source: "leboncoin",
    externalId: `listing-${index}`,
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/listing-${index}`,
    title: `House ${index}`,
    description: "House with garden.",
    features: ["Garden"],
    status: "detailed",
    scrapedAt: INITIAL_NOW.toISOString(),
  };
}

function mutableClock() {
  let value = INITIAL_NOW;
  return {
    now: () => value,
    advance(milliseconds: number) {
      value = new Date(value.getTime() + milliseconds);
    },
  };
}

function expectApiError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected an ApiError.");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code });
  }
}
