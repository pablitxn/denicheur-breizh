import type { IngestionRequest } from "@denicheur-breizh/contracts";
import type { IntelligenceRecipe } from "../lib/types";

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

export interface ExtensionSyncState {
  version: 1;
  status: "idle" | "pending" | "syncing" | "error";
  queue: SyncQueueEntry[];
  syncedFingerprints: Record<string, string>;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  activeRecipe: ActiveRecipeCacheState;
}

export type ExtensionRuntimeRequest =
  | { type: "GET_SYNC_STATE" }
  | { type: "SYNC_NOW" }
  | { type: "RESET_ITERATION"; deadlineAt?: number }
  | { type: "REFRESH_ACTIVE_RECIPE" };

export interface ExtensionRuntimeResponse {
  ok: boolean;
  state: ExtensionSyncState;
  recipe?: IntelligenceRecipe;
  error?: string;
  errorCode?: string;
}

export function isExtensionRuntimeRequest(value: unknown): value is ExtensionRuntimeRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  if (value.type === "RESET_ITERATION") {
    return !("deadlineAt" in value) ||
      (typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt));
  }
  return value.type === "GET_SYNC_STATE" ||
    value.type === "SYNC_NOW" ||
    value.type === "REFRESH_ACTIVE_RECIPE";
}
