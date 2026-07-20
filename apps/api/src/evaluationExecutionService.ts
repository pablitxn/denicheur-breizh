import { createHash, randomUUID } from "node:crypto";

import type {
  EvaluationExecutionCreateRequest,
  EvaluationExecutionRecord,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import type {
  CreateEvaluationExecutionResult,
  DenicheurRepository,
} from "./repository.js";

export interface EvaluationExecutionQueue {
  kick(): void;
}

export class EvaluationExecutionService {
  constructor(
    private readonly repository: DenicheurRepository,
    private readonly queue: EvaluationExecutionQueue,
  ) {}

  create(
    runId: string,
    request: EvaluationExecutionCreateRequest,
    idempotencyKey: string,
  ): CreateEvaluationExecutionResult {
    const listingIds = request.listingIds ?? this.repository.getRunListingIds(runId) ?? [];
    const normalizedRequest = {
      ...request,
      force: request.force === true,
    };
    const result = this.repository.createEvaluationExecution({
      id: randomUUID(),
      runId,
      request,
      listingIds,
      idempotencyKey,
      requestFingerprint: fingerprint({ action: "create", runId, request: normalizedRequest }),
    });
    if (result.created) this.queue.kick();
    return result;
  }

  retry(executionId: string, idempotencyKey: string): CreateEvaluationExecutionResult {
    const original = this.repository.getEvaluationExecution(executionId);
    if (!original) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    if (original.status !== "failed" && original.status !== "partial" && original.status !== "cancelled") {
      throw new ApiError(
        409,
        "EVALUATION_EXECUTION_NOT_RETRYABLE",
        "Only failed, partial, or cancelled evaluation executions can be retried.",
      );
    }
    const request: EvaluationExecutionCreateRequest = {
      planId: original.planId,
      planVersion: original.planVersion,
      locale: original.locale,
      listingIds: original.listingIds,
      force: false,
    };
    const result = this.repository.createEvaluationExecution({
      id: randomUUID(),
      runId: original.runId,
      request,
      listingIds: original.listingIds,
      idempotencyKey,
      requestFingerprint: fingerprint({ action: "retry", executionId, request }),
      retryOfExecutionId: original.id,
    });
    if (result.created) this.queue.kick();
    return result;
  }

  cancel(executionId: string): EvaluationExecutionRecord {
    const execution = this.repository.requestEvaluationExecutionCancellation(executionId);
    if (!execution) {
      throw new ApiError(404, "EVALUATION_EXECUTION_NOT_FOUND", "The requested evaluation execution does not exist.");
    }
    return execution;
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
