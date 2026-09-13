import type { IngestionRequest } from "@denicheur-breizh/contracts";
import type { LocaleCode } from "@denicheur-breizh/i18n";
import type {
  EvaluationExecution,
  EvaluationPlan,
  IntelligenceRecipe,
} from "../lib/types";

export const INGESTION_BATCH_SIZE = 20;

export type IngestionRequestPayload = IngestionRequest;

export interface SyncQueueEntry {
  key: string;
  runId: string;
  fingerprint: string;
  payload: IngestionRequestPayload;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ActiveRecipeCacheState {
  status: "unknown" | "cached" | "unavailable";
  fetchedAt?: string;
  recipeId?: string;
  recipeVersion?: number;
  lastError?: string;
}

export interface ActivePlanCacheState {
  status: "unknown" | "cached" | "none" | "unavailable";
  fetchedAt?: string;
  planId?: string;
  planVersion?: number;
  lastError?: string;
}

export interface EvaluationQueueEntry {
  key: string;
  idempotencyKey: string;
  runId: string;
  planId: string;
  planVersion: number;
  locale: LocaleCode;
  listingIds?: string[];
  force?: boolean;
  status: "queued" | "creating" | "polling" | "completed" | "failed" | "cancelled";
  executionId?: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface ExtensionSyncState {
  version: 2;
  /** Incremented by a coordinated clear; absent in older version-2 snapshots. */
  generation?: number;
  status: "idle" | "pending" | "syncing" | "error";
  queue: SyncQueueEntry[];
  /** Derived from the independent archive outbox when reading background status. */
  sourceRecordsPending?: number;
  syncedFingerprints: Record<string, string>;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  activePlan: ActivePlanCacheState;
  evaluationQueue: EvaluationQueueEntry[];
  /** Kept while older extension surfaces still read the single-recipe cache. */
  activeRecipe: ActiveRecipeCacheState;
}

export type ExtensionRuntimeRequest =
  | { type: "GET_SYNC_STATE" }
  | { type: "SYNC_NOW" }
  | { type: "RESET_ITERATION"; deadlineAt?: number }
  | { type: "REFRESH_ACTIVE_RECIPE" }
  | { type: "REFRESH_DEFAULT_PLAN" }
  | {
      type: "QUEUE_PLAN_EVALUATION";
      runId: string;
      locale: LocaleCode;
      listingIds?: string[];
      force?: boolean;
    };

export interface ExtensionRuntimeResponse {
  ok: boolean;
  /** Catalog/evaluation synchronization only; archive errors remain visible in state. */
  catalogOk?: boolean;
  state: ExtensionSyncState;
  recipe?: IntelligenceRecipe;
  plan?: EvaluationPlan;
  execution?: EvaluationExecution;
  error?: string;
  errorCode?: string;
}

export function isExtensionRuntimeRequest(value: unknown): value is ExtensionRuntimeRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "RESET_ITERATION") {
    return !("deadlineAt" in value) ||
      (typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt));
  }
  if (value.type === "QUEUE_PLAN_EVALUATION") {
    return "runId" in value && typeof value.runId === "string" && value.runId.trim().length > 0 &&
      "locale" in value && (value.locale === "fr" || value.locale === "es" || value.locale === "en") &&
      (!("listingIds" in value) || value.listingIds === undefined ||
        (Array.isArray(value.listingIds) && value.listingIds.every((id) => typeof id === "string"))) &&
      (!("force" in value) || value.force === undefined || typeof value.force === "boolean");
  }
  return value.type === "GET_SYNC_STATE" ||
    value.type === "SYNC_NOW" ||
    value.type === "REFRESH_ACTIVE_RECIPE" ||
    value.type === "REFRESH_DEFAULT_PLAN";
}
