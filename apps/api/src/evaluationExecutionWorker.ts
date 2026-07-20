import { randomUUID } from "node:crypto";

import type {
  EvaluationBatchItem,
  EvaluationExecutionRecord,
  EvaluationItemError,
  EvaluationPlanRecipeReference,
} from "./contracts.js";
import { MAX_LISTINGS_PER_REQUEST } from "./contracts.js";
import { combineEvaluationExecutionListing } from "./evaluationCombiner.js";
import type { StoredEvaluationService } from "./evaluationService.js";
import type {
  DenicheurRepository,
  EvaluationExecutionStepWorkItem,
  StoredExecutionStep,
} from "./repository.js";

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1_000;

export interface EvaluationExecutionWorkerOptions {
  readonly ownerId?: string;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

export class EvaluationExecutionWorker {
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private active: Promise<void> | undefined;
  private wakeRequested = false;
  private disposed = false;

  constructor(
    private readonly repository: DenicheurRepository,
    private readonly evaluationService: Pick<StoredEvaluationService, "evaluate">,
    options: EvaluationExecutionWorkerOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.kick();
  }

  kick(): void {
    if (this.disposed) return;
    this.wakeRequested = true;
    if (this.active) return;
    this.active = Promise.resolve()
      .then(() => this.runLoop())
      .finally(() => {
        this.active = undefined;
        if (this.wakeRequested && !this.disposed) this.kick();
      });
  }

  async drain(): Promise<void> {
    while (this.active) await this.active;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.drain();
  }

  private async runLoop(): Promise<void> {
    do {
      this.wakeRequested = false;
      while (!this.disposed) {
        const execution = this.repository.claimNextEvaluationExecution(this.ownerId, this.leaseDurationMs);
        if (!execution) break;
        await this.processExecution(execution);
      }
    } while (this.wakeRequested && !this.disposed);
  }

  private async processExecution(execution: EvaluationExecutionRecord): Promise<void> {
    try {
      const plan = this.repository.getResolvedEvaluationPlan(execution.planId, execution.planVersion);
      if (!plan) throw new Error("The evaluation execution plan no longer exists.");

      for (const reference of plan.recipes) {
        for (;;) {
          if (this.disposed) {
            this.repository.releaseEvaluationExecutionLease(execution.id, this.ownerId);
            return;
          }
          if (this.repository.isEvaluationExecutionCancellationRequested(execution.id)) {
            this.repository.markEvaluationExecutionCancelled(execution.id, this.ownerId);
            return;
          }
          if (!this.renewOrCancel(execution.id)) {
            return;
          }
          const batch = this.repository.claimEvaluationExecutionStepBatch(
            execution.id,
            this.ownerId,
            reference.recipeId,
            reference.recipeVersion,
            MAX_LISTINGS_PER_REQUEST,
          );
          if (batch.length === 0) break;
          const resumed = batch.filter((item) => item.resumed);
          const fresh = batch.filter((item) => !item.resumed);
          const outcomes = [
            ...(resumed.length > 0 ? await this.evaluateBatch(execution, reference, resumed) : []),
            ...(fresh.length > 0 ? await this.evaluateBatch(execution, reference, fresh) : []),
          ];
          if (!this.renewOrCancel(execution.id)) {
            return;
          }
          for (const outcome of outcomes) {
            this.repository.completeEvaluationExecutionStep(
              execution.id,
              this.ownerId,
              outcome.listingId,
              outcome.step,
            );
          }
        }
      }

      for (;;) {
        if (this.disposed) {
          this.repository.releaseEvaluationExecutionLease(execution.id, this.ownerId);
          return;
        }
        if (this.repository.isEvaluationExecutionCancellationRequested(execution.id)) {
          this.repository.markEvaluationExecutionCancelled(execution.id, this.ownerId);
          return;
        }
        if (!this.renewOrCancel(execution.id)) {
          return;
        }
        const item = this.repository.nextEvaluationExecutionWorkItem(execution.id, this.ownerId);
        if (!item) break;

        const steps = this.repository.getEvaluationExecutionSteps(execution.id, item.listingId);
        const result = combineEvaluationExecutionListing({
          executionId: execution.id,
          listingId: item.listingId,
          planId: execution.planId,
          planVersion: execution.planVersion,
          locale: execution.locale,
          operator: plan.operator,
          steps,
          evaluatedAt: this.now(),
        });
        this.repository.completeEvaluationExecutionItem(this.ownerId, result);
      }
      this.repository.finishEvaluationExecution(execution.id, this.ownerId);
    } catch (error) {
      try {
        this.repository.failEvaluationExecution(execution.id, this.ownerId, errorMessage(error));
      } catch {
        // A reclaimed lease belongs to another worker and must not be overwritten.
      }
    }
  }

  private renewOrCancel(executionId: string): boolean {
    if (this.repository.renewEvaluationExecutionLease(executionId, this.ownerId, this.leaseDurationMs)) {
      return true;
    }
    if (this.repository.isEvaluationExecutionCancellationRequested(executionId)) {
      try {
        this.repository.markEvaluationExecutionCancelled(executionId, this.ownerId);
      } catch {
        // Another worker may have reclaimed the expired lease and owns cancellation.
      }
    }
    return false;
  }

  private async evaluateBatch(
    execution: EvaluationExecutionRecord,
    reference: EvaluationPlanRecipeReference,
    batch: readonly EvaluationExecutionStepWorkItem[],
  ): Promise<Array<{
    listingId: string;
    step: Exclude<StoredExecutionStep, { status: "pending" | "running" | "skipped" }>;
  }>> {
    const requestId = randomUUID();
    const step = (): StoredExecutionStep => ({
      recipeId: reference.recipeId,
      recipeVersion: reference.recipeVersion,
      status: "running",
    });
    try {
      const response = await this.evaluationService.evaluate(execution.runId, {
        locale: execution.locale,
        recipeId: reference.recipeId,
        recipeVersion: reference.recipeVersion,
        listingIds: batch.map((item) => item.listingId),
        ...((execution.force && batch.every((item) => !item.resumed)) ? { force: true } : {}),
      }, { requestId });
      const outcomeByListingId = new Map(response.items.map((item) => [item.listingId, item]));
      return batch.map((item) => {
        const outcome = outcomeByListingId.get(item.listingId);
        const storedStep = step();
        return {
          listingId: item.listingId,
          step: outcome ? fromBatchItem(storedStep, outcome) : failedStep(storedStep, internalError(requestId)),
        };
      });
    } catch {
      return batch.map((item) => {
        const storedStep = step();
        return {
          listingId: item.listingId,
          step: failedStep(storedStep, internalError(requestId)),
        };
      });
    }
  }
}

function fromBatchItem(
  step: StoredExecutionStep,
  item: EvaluationBatchItem,
): Exclude<StoredExecutionStep, { status: "pending" | "running" | "skipped" }> {
  if (item.status === "failed") return failedStep(step, item.error);
  return {
    recipeId: step.recipeId,
    recipeVersion: step.recipeVersion,
    status: item.status,
    evaluation: item.evaluation,
    evaluator: item.evaluator,
  };
}

function failedStep(
  step: StoredExecutionStep,
  error: EvaluationItemError,
): Exclude<StoredExecutionStep, { status: "pending" | "running" | "skipped" }> {
  return {
    recipeId: step.recipeId,
    recipeVersion: step.recipeVersion,
    status: "failed",
    error,
  };
}

function internalError(requestId: string): EvaluationItemError {
  return {
    code: "EVALUATION_FAILED",
    stage: "internal",
    retryable: true,
    requestId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
