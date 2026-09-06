import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  createListingKey,
  evaluatorSchema,
  evaluationExecutionListingResultSchema,
  evaluationExecutionBudgetSchema,
  evaluationExecutionResourceUsageSchema,
  evaluationExecutionRecordSchema,
  evaluationExecutionResultsSchema,
  evaluationExecutionsPageSchema,
  evaluationPlanVersionSchema,
  MAX_LISTING_FEATURES,
  MAX_LISTING_IMAGE_URLS,
  listingDetailSchema,
  listingEvaluationRecordSchema,
  listingIngestionSchema,
  listingRecordSchema,
  parseListingKey,
  recipeVersionSchema,
  resolvedEvaluationPlanVersionSchema,
  runDetailSchema,
  runListingsPageSchema,
  runIngestionSchema,
  runRecordSchema,
  type EvaluationRequest,
  type EvaluationExecutionCreateRequest,
  type EvaluationExecutionBudget,
  type EvaluationExecutionResourceUsage,
  type EvaluationExecutionListingResult,
  type EvaluationExecutionRecord,
  type EvaluationExecutionResults,
  type EvaluationExecutionsPage,
  type EvaluationExecutionsQuery,
  type EvaluationItemError,
  type EvaluationFailureStage,
  type EvaluationPlanDraft,
  type EvaluationPlanVersion,
  type Evaluator,
  type FilterListingsResponse,
  type IngestionRequest,
  type IngestionResponse,
  type ListingDetail,
  type ListingEvaluationRecord,
  type ListingEvaluationResult,
  type ListingIdentity,
  type ListingImageAsset,
  type ListingIngestion,
  type ListingRecord,
  type ListingsPage,
  type ListingsQuery,
  type RecipeDraft,
  type RecipeVersion,
  type ResolvedEvaluationPlanVersion,
  type RunDetail,
  type RunListingsPage,
  type RunListingsQuery,
  type RunIngestion,
  type RunRecord,
  type RunsPage,
  type RunsQuery,
  type VerifiedCoordinates,
} from "./contracts.js";
import { ApiError } from "./errors.js";
import { addUsage, exceedsUsage, subtractUsage } from "./evaluationBudget.js";
import type {
  GlobalProviderBudgetStore,
  GlobalProviderCallReservation,
} from "./globalProviderBudget.js";

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const LATEST_EVALUATION_ORDER = "e.evaluated_at DESC, e.run_id DESC, e.recipe_id ASC, e.recipe_version DESC, e.locale ASC";

export const DATABASE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json))
      ) STRICT;

      CREATE TABLE listings (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_id TEXT NOT NULL REFERENCES runs(id),
        price_euros REAL,
        surface_m2 REAL,
        property_type TEXT,
        energy_class TEXT,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        PRIMARY KEY (source, external_id)
      ) STRICT;

      CREATE TABLE run_listings (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        first_observed_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL,
        scraped_at TEXT NOT NULL,
        observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
        PRIMARY KEY (run_id, source, external_id)
      ) STRICT;

      CREATE TABLE recipe_versions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        PRIMARY KEY (id, version)
      ) STRICT;

      CREATE UNIQUE INDEX one_active_recipe_version
        ON recipe_versions(active)
        WHERE active = 1;

      CREATE TABLE evaluations (
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        recipe_version INTEGER NOT NULL,
        locale TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        decision TEXT NOT NULL,
        score REAL,
        evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        PRIMARY KEY (run_id, source, external_id, recipe_id, recipe_version, locale),
        FOREIGN KEY (run_id, source, external_id)
          REFERENCES run_listings(run_id, source, external_id) ON DELETE CASCADE,
        FOREIGN KEY (recipe_id, recipe_version) REFERENCES recipe_versions(id, version)
      ) STRICT;

      CREATE INDEX listings_updated_at_idx ON listings(updated_at DESC);
      CREATE INDEX listings_last_run_idx ON listings(last_run_id);
      CREATE INDEX run_listings_listing_idx ON run_listings(source, external_id, observed_at DESC);
      CREATE INDEX evaluations_listing_idx ON evaluations(source, external_id, evaluated_at DESC, run_id);
      CREATE INDEX evaluations_run_idx ON evaluations(run_id, evaluated_at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE evaluations ADD COLUMN input_fingerprint TEXT;

      CREATE TABLE evaluation_attempts (
        attempt_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        recipe_version INTEGER NOT NULL,
        locale TEXT NOT NULL,
        input_fingerprint TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        evaluator_json TEXT CHECK (evaluator_json IS NULL OR json_valid(evaluator_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        response_id TEXT,
        error_code TEXT,
        error_stage TEXT,
        criterion_id TEXT,
        retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1)),
        FOREIGN KEY (run_id, source, external_id)
          REFERENCES run_listings(run_id, source, external_id) ON DELETE CASCADE,
        FOREIGN KEY (recipe_id, recipe_version) REFERENCES recipe_versions(id, version)
      ) STRICT;

      CREATE INDEX evaluation_attempts_listing_idx
        ON evaluation_attempts(run_id, source, external_id, recipe_id, recipe_version, locale, started_at DESC);
      CREATE INDEX evaluation_attempts_fingerprint_idx
        ON evaluation_attempts(input_fingerprint, status, started_at DESC);
      CREATE INDEX evaluations_fingerprint_idx
        ON evaluations(input_fingerprint);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE evaluation_plan_versions (
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        name TEXT NOT NULL,
        operator TEXT NOT NULL CHECK (operator IN ('all', 'any')),
        combiner_version TEXT NOT NULL CHECK (combiner_version = 'tri-state-v1'),
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        PRIMARY KEY (id, version)
      ) STRICT;

      CREATE UNIQUE INDEX one_default_evaluation_plan_version
        ON evaluation_plan_versions(is_default)
        WHERE is_default = 1;

      CREATE TABLE evaluation_plan_recipes (
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        recipe_index INTEGER NOT NULL CHECK (recipe_index >= 0 AND recipe_index < 4),
        recipe_id TEXT NOT NULL,
        recipe_version INTEGER NOT NULL CHECK (recipe_version > 0),
        PRIMARY KEY (plan_id, plan_version, recipe_index),
        UNIQUE (plan_id, plan_version, recipe_id),
        FOREIGN KEY (plan_id, plan_version)
          REFERENCES evaluation_plan_versions(id, version) ON DELETE CASCADE,
        FOREIGN KEY (recipe_id, recipe_version)
          REFERENCES recipe_versions(id, version)
      ) STRICT;

      CREATE TABLE evaluation_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        locale TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        force INTEGER NOT NULL CHECK (force IN (0, 1)),
        retry_of_execution_id TEXT REFERENCES evaluation_executions(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        error TEXT,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        counters_json TEXT NOT NULL CHECK (json_valid(counters_json)),
        FOREIGN KEY (plan_id, plan_version)
          REFERENCES evaluation_plan_versions(id, version)
      ) STRICT;

      CREATE TABLE evaluation_execution_items (
        execution_id TEXT NOT NULL REFERENCES evaluation_executions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        item_index INTEGER NOT NULL CHECK (item_index >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, source, external_id),
        UNIQUE (execution_id, item_index),
        FOREIGN KEY (run_id, source, external_id)
          REFERENCES run_listings(run_id, source, external_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE evaluation_execution_steps (
        execution_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        step_index INTEGER NOT NULL CHECK (step_index >= 0 AND step_index < 4),
        recipe_id TEXT NOT NULL,
        recipe_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'cached', 'failed', 'skipped')),
        evaluation_json TEXT CHECK (evaluation_json IS NULL OR json_valid(evaluation_json)),
        error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, source, external_id, step_index),
        FOREIGN KEY (execution_id, source, external_id)
          REFERENCES evaluation_execution_items(execution_id, source, external_id) ON DELETE CASCADE,
        FOREIGN KEY (recipe_id, recipe_version)
          REFERENCES recipe_versions(id, version)
      ) STRICT;

      CREATE INDEX evaluation_executions_run_idx
        ON evaluation_executions(run_id, created_at DESC);
      CREATE INDEX evaluation_executions_status_idx
        ON evaluation_executions(status, lease_expires_at, created_at ASC);
      CREATE INDEX evaluation_execution_items_pending_idx
        ON evaluation_execution_items(execution_id, status, item_index);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY CHECK (length(id) = 64),
        source_url TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
        content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
        source_mime_type TEXT,
        original_object_key TEXT,
        thumbnail_object_key TEXT,
        gallery_object_key TEXT,
        object_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(object_keys_json)),
        original_size_bytes INTEGER CHECK (original_size_bytes IS NULL OR original_size_bytes >= 0),
        thumbnail_size_bytes INTEGER CHECK (thumbnail_size_bytes IS NULL OR thumbnail_size_bytes >= 0),
        gallery_size_bytes INTEGER CHECK (gallery_size_bytes IS NULL OR gallery_size_bytes >= 0),
        width INTEGER CHECK (width IS NULL OR width > 0),
        height INTEGER CHECK (height IS NULL OR height > 0),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT
      ) STRICT;

      CREATE TABLE listing_media (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0 AND position < 50),
        asset_id TEXT NOT NULL REFERENCES media_assets(id),
        PRIMARY KEY (source, external_id, position),
        UNIQUE (source, external_id, asset_id),
        FOREIGN KEY (source, external_id) REFERENCES listings(source, external_id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE media_jobs (
        asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX listing_media_asset_idx ON listing_media(asset_id);
      CREATE INDEX media_jobs_claim_idx ON media_jobs(status, next_attempt_at, lease_expires_at);
      CREATE INDEX media_assets_status_idx ON media_assets(status, updated_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE evaluation_execution_budgets (
        execution_id TEXT PRIMARY KEY REFERENCES evaluation_executions(id) ON DELETE CASCADE,
        limit_json TEXT NOT NULL CHECK (json_valid(limit_json)),
        estimate_json TEXT NOT NULL CHECK (json_valid(estimate_json)),
        consumed_json TEXT NOT NULL CHECK (json_valid(consumed_json)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE evaluation_provider_call_reservations (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES evaluation_executions(id) ON DELETE CASCADE,
        reserved_json TEXT NOT NULL CHECK (json_valid(reserved_json)),
        settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
        created_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;

      CREATE INDEX evaluation_provider_reservations_execution_idx
        ON evaluation_provider_call_reservations(execution_id, settled, created_at);

      INSERT INTO evaluation_execution_budgets (
        execution_id, limit_json, estimate_json, consumed_json, updated_at
      )
      SELECT id,
        '{"providerCalls":10000,"inputTokens":100000000,"outputTokens":100000000,"costMicroUsd":1000000000}',
        '{"providerCalls":0,"inputTokens":0,"outputTokens":0,"costMicroUsd":0}',
        '{"providerCalls":0,"inputTokens":0,"outputTokens":0,"costMicroUsd":0}',
        updated_at
      FROM evaluation_executions;

      CREATE TABLE media_gc_tombstones (
        asset_id TEXT PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'deleting')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX media_gc_claim_idx
        ON media_gc_tombstones(status, next_attempt_at, lease_expires_at, created_at);

      CREATE TABLE run_media_admissions (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL CHECK (length(asset_id) = 64),
        admitted_at TEXT NOT NULL,
        PRIMARY KEY (run_id, asset_id)
      ) STRICT;

      CREATE INDEX run_media_admissions_asset_idx
        ON run_media_admissions(asset_id, run_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE INDEX run_listings_run_page_idx
        ON run_listings(run_id, observed_at DESC, source ASC, external_id ASC);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE media_assets ADD COLUMN storage_generation TEXT;

      UPDATE media_assets
      SET storage_generation = lower(hex(randomblob(16)))
      WHERE storage_generation IS NULL;

      CREATE INDEX media_assets_storage_generation_idx
        ON media_assets(storage_generation);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE global_provider_call_reservations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
        provider_calls INTEGER NOT NULL CHECK (provider_calls >= 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd >= 0),
        settled_at TEXT
      ) STRICT;

      CREATE INDEX global_provider_reservations_window_idx
        ON global_provider_call_reservations(created_at);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE collected_data_cleanup_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        lease_owner TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

interface StoredListingRow extends Record<string, unknown> {
  readonly source: string;
  readonly external_id: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly updated_at: string;
  readonly last_run_id: string;
  readonly data_json: string;
}

interface StoredRunRow extends Record<string, unknown> {
  readonly updated_at: string;
  readonly data_json: string;
}

interface StoredRunListingRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly source: string;
  readonly external_id: string;
  readonly first_observed_at: string;
  readonly observed_at: string;
  readonly scraped_at: string;
  readonly observation_json: string;
}

interface StoredRecipeRow extends Record<string, unknown> {
  readonly active: number;
  readonly created_at: string;
  readonly data_json: string;
}

interface StoredEvaluationPlanRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
  readonly is_default: number;
  readonly created_at: string;
  readonly data_json: string;
}

interface StoredEvaluationPlanRecipeRow extends Record<string, unknown> {
  readonly recipe_id: string;
  readonly recipe_version: number;
}

interface StoredEvaluationExecutionRow extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly plan_id: string;
  readonly plan_version: number;
  readonly locale: string;
  readonly status: string;
  readonly force: number;
  readonly retry_of_execution_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly error: string | null;
  readonly request_json: string;
  readonly counters_json: string;
}

interface StoredEvaluationExecutionItemRow extends Record<string, unknown> {
  readonly execution_id: string;
  readonly run_id: string;
  readonly source: string;
  readonly external_id: string;
  readonly item_index: number;
  readonly status: string;
  readonly result_json: string | null;
}

interface StoredEvaluationExecutionStepRow extends Record<string, unknown> {
  readonly recipe_id: string;
  readonly recipe_version: number;
  readonly status: string;
  readonly evaluation_json: string | null;
  readonly error_json: string | null;
}

interface StoredEvaluationRow extends Record<string, unknown> {
  readonly run_id: string;
  readonly source: string;
  readonly external_id: string;
  readonly recipe_id: string;
  readonly recipe_version: number;
  readonly locale: string;
  readonly evaluator_json: string;
  readonly result_json: string;
  readonly input_fingerprint: string | null;
}

interface StoredMediaAssetRow extends Record<string, unknown> {
  readonly id: string;
  readonly source_url: string;
  readonly status: "pending" | "processing" | "ready" | "failed";
  readonly content_sha256: string | null;
  readonly source_mime_type: string | null;
  readonly original_object_key: string | null;
  readonly thumbnail_object_key: string | null;
  readonly gallery_object_key: string | null;
  readonly object_keys_json: string;
  readonly original_size_bytes: number | null;
  readonly thumbnail_size_bytes: number | null;
  readonly gallery_size_bytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly storage_generation: string;
}

interface MediaGlobalUsage {
  readonly pendingJobs: number;
  readonly reservedBytes: number;
}

interface StoredMediaJobRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly source_url: string;
  readonly attempts: number;
}

interface StoredEvaluationExecutionBudgetRow extends Record<string, unknown> {
  readonly limit_json: string;
  readonly estimate_json: string;
  readonly consumed_json: string;
}

interface StoredMediaGarbageRow extends Record<string, unknown> {
  readonly asset_id: string;
  readonly attempts: number;
  readonly lease_owner: string | null;
  readonly original_object_key: string | null;
  readonly thumbnail_object_key: string | null;
  readonly gallery_object_key: string | null;
  readonly object_keys_json: string;
}

export interface EvaluationAttemptInput {
  readonly attemptId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly listingId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly locale: EvaluationRequest["locale"];
  readonly inputFingerprint: string;
}

export interface EvaluationAttemptFailure {
  readonly code: string;
  readonly stage: EvaluationFailureStage;
  readonly retryable: boolean;
  readonly responseId?: string;
  readonly criterionId?: string;
}

export interface RepositoryOptions {
  readonly path: string;
  readonly now?: () => Date;
  readonly mediaAdmission?: Partial<MediaAdmissionPolicy>;
}

export interface MediaAdmissionPolicy {
  readonly maxAssetsPerRun: number;
  readonly maxPendingJobs: number;
  readonly maxReservedBytes: number;
  readonly reservedBytesPerAsset: number;
}

export const DEFAULT_MEDIA_ADMISSION_POLICY: MediaAdmissionPolicy = {
  maxAssetsPerRun: 500,
  maxPendingJobs: 1_000,
  maxReservedBytes: 5 * 1024 * 1024 * 1024,
  reservedBytesPerAsset: 20 * 1024 * 1024,
};

export interface MediaHealthCounts {
  readonly pending: number;
  readonly processing: number;
  readonly ready: number;
  readonly failed: number;
}

export interface MediaJob {
  readonly assetId: string;
  readonly sourceUrl: string;
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface MediaGarbageCollectionJob {
  readonly assetId: string;
  readonly objectKeys: readonly string[];
  readonly attempt: number;
  readonly leaseOwner: string;
}

export interface MediaAssetRecord {
  readonly id: string;
  readonly sourceUrl: string;
  readonly status: "pending" | "processing" | "ready" | "failed";
  readonly originalObjectKey?: string;
  readonly thumbnailObjectKey?: string;
  readonly galleryObjectKey?: string;
  readonly thumbnailSizeBytes?: number;
  readonly gallerySizeBytes?: number;
}

export interface CompletedMediaAsset {
  readonly contentSha256: string;
  readonly sourceMimeType: string;
  readonly originalObjectKey: string;
  readonly thumbnailObjectKey: string;
  readonly galleryObjectKey: string;
  readonly originalSizeBytes: number;
  readonly thumbnailSizeBytes: number;
  readonly gallerySizeBytes: number;
  readonly width: number;
  readonly height: number;
}

export interface CreateEvaluationExecutionInput {
  readonly id: string;
  readonly runId: string;
  readonly request: EvaluationExecutionCreateRequest;
  readonly listingIds: readonly string[];
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly budget: EvaluationExecutionBudget;
  readonly retryOfExecutionId?: string;
}

export interface EvaluationProviderCallReservation {
  readonly id: string;
  readonly reserved: EvaluationExecutionResourceUsage;
}

export interface CreateEvaluationExecutionResult {
  readonly execution: EvaluationExecutionRecord;
  readonly created: boolean;
}

export interface EvaluationExecutionWorkItem {
  readonly executionId: string;
  readonly runId: string;
  readonly listingId: string;
}

export interface EvaluationExecutionStepWorkItem {
  readonly listingId: string;
  readonly resumed: boolean;
}

export type StoredExecutionStep =
  | {
      readonly recipeId: string;
      readonly recipeVersion: number;
      readonly status: "pending" | "running" | "skipped";
    }
  | {
      readonly recipeId: string;
      readonly recipeVersion: number;
      readonly status: "succeeded" | "cached";
      readonly evaluation: ListingEvaluationResult;
      readonly evaluator: Evaluator;
    }
  | {
      readonly recipeId: string;
      readonly recipeVersion: number;
      readonly status: "failed";
      readonly error: EvaluationItemError;
    };

export interface CollectedDataCounts {
  readonly listings: number;
  readonly runs: number;
  readonly runListings: number;
  readonly evaluations: number;
}

export interface CollectedDataCleanupLease {
  readonly leaseOwner: string;
  readonly objectKeys: readonly string[];
}

export interface ClearCollectedDataOptions {
  readonly allowActiveRun?: boolean;
}

const ACTIVE_RUN_STATUSES = [
  "opening-search",
  "configuring-search",
  "collecting-search",
  "collecting-details",
  "evaluating",
  "paused-captcha",
] as const;
const ABANDONED_EVALUATION_ATTEMPT_AFTER_MS = 15 * 60 * 1_000;
const MEDIA_GC_LEASE_DURATION_MS = 5 * 60_000;
const COLLECTED_DATA_CLEANUP_LEASE_DURATION_MS = 5 * 60_000;
const PRIVATE_DATABASE_DIRECTORY_MODE = 0o700;
const PRIVATE_DATABASE_FILE_MODE = 0o600;

interface PrivateDatabaseHandle {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly directoryPath: string;
  readonly databaseDescriptor: number;
  readonly directoryDescriptor: number;
}

export class DenicheurRepository implements GlobalProviderBudgetStore {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly mediaAdmission: MediaAdmissionPolicy;

  constructor(options: RepositoryOptions) {
    const privateDatabase = options.path === ":memory:"
      ? undefined
      : openPrivateDatabase(options.path);
    this.database = privateDatabase?.database ?? new DatabaseSync(options.path, { timeout: 5_000 });
    this.now = options.now ?? (() => new Date());
    this.mediaAdmission = { ...DEFAULT_MEDIA_ADMISSION_POLICY, ...options.mediaAdmission };
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      assertMediaAdmissionPolicy(this.mediaAdmission);
      this.migrate();
      if (!this.isCollectedDataCleanupActive()) this.reconcileLegacyMedia();
      this.seedDefaultEvaluationPlan();
      this.reconcileAbandonedEvaluationAttempts();
      if (privateDatabase) hardenPrivateDatabaseFiles(privateDatabase);
    } catch (error) {
      this.database.close();
      throw error;
    } finally {
      if (privateDatabase) releasePrivateDatabaseHandle(privateDatabase);
    }
  }

  close(): void {
    this.database.close();
  }

  isReady(): boolean {
    try {
      return this.database.prepare("SELECT 1 AS ready").get()?.ready === 1;
    } catch {
      return false;
    }
  }

  isCollectedDataCleanupActive(): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 FROM collected_data_cleanup_lease WHERE singleton = 1",
    ).get());
  }

  mediaHealthCounts(): MediaHealthCounts {
    const rows = this.database.prepare(`
      SELECT a.status, COUNT(*) AS total
      FROM media_assets a
      WHERE EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = a.id)
      GROUP BY a.status
    `).all();
    const counts: Record<keyof MediaHealthCounts, number> = {
      pending: 0,
      processing: 0,
      ready: 0,
      failed: 0,
    };
    for (const row of rows) {
      const status = readString(row, "status");
      if (status in counts) counts[status as keyof MediaHealthCounts] = readNumber(row, "total");
    }
    return counts;
  }

  getMediaAsset(assetId: string): MediaAssetRecord | undefined {
    const row = this.database.prepare(`
      SELECT a.* FROM media_assets a
      WHERE a.id = ?
        AND EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = a.id)
    `)
      .get(assetId) as StoredMediaAssetRow | undefined;
    return row ? mapMediaAsset(row) : undefined;
  }

  listMediaObjectKeys(): string[] {
    const rows = this.database.prepare(`
      SELECT original_object_key, thumbnail_object_key, gallery_object_key, object_keys_json
      FROM media_assets
    `).all() as StoredMediaAssetRow[];
    return uniqueStrings(rows.flatMap((row) => [
      row.original_object_key,
      row.thumbnail_object_key,
      row.gallery_object_key,
      ...parseMediaObjectKeys(row.object_keys_json),
    ].filter((key): key is string => Boolean(key))));
  }

  beginCollectedDataCleanup(options: ClearCollectedDataOptions = {}): CollectedDataCleanupLease {
    return this.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const existing = this.database.prepare(`
        SELECT lease_expires_at FROM collected_data_cleanup_lease WHERE singleton = 1
      `).get() as { lease_expires_at: string } | undefined;
      if (existing && existing.lease_expires_at > nowIso) {
        throw new ApiError(409, "MEDIA_CLEANUP_IN_PROGRESS", "Collected data cleanup is already in progress.");
      }

      this.assertCollectedDataCanBeCleared(options);
      const processing = this.database.prepare(`
        SELECT asset_id FROM media_jobs WHERE status = 'processing' ORDER BY asset_id LIMIT 1
      `).get() as { asset_id: string } | undefined;
      if (processing) {
        throw new ApiError(
          409,
          "ACTIVE_MEDIA_JOB",
          `Media asset ${processing.asset_id} is still processing. Wait for it to finish before clearing data.`,
        );
      }

      const leaseOwner = `collected-data-cleanup:${randomUUID()}`;
      const leaseExpiresAt = new Date(
        now.getTime() + COLLECTED_DATA_CLEANUP_LEASE_DURATION_MS,
      ).toISOString();
      this.database.prepare(`
        INSERT INTO collected_data_cleanup_lease (
          singleton, lease_owner, lease_expires_at, started_at, updated_at
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at
      `).run(leaseOwner, leaseExpiresAt, nowIso, nowIso);
      return { leaseOwner, objectKeys: this.listMediaObjectKeys() };
    });
  }

  renewCollectedDataCleanup(leaseOwner: string): void {
    this.transaction(() => {
      const now = this.now();
      const renewed = this.database.prepare(`
        UPDATE collected_data_cleanup_lease
        SET lease_expires_at = ?, updated_at = ?
        WHERE singleton = 1 AND lease_owner = ?
      `).run(
        new Date(now.getTime() + COLLECTED_DATA_CLEANUP_LEASE_DURATION_MS).toISOString(),
        now.toISOString(),
        leaseOwner,
      );
      if (renewed.changes !== 1) {
        throw new ApiError(
          409,
          "MEDIA_CLEANUP_LEASE_LOST",
          "Collected data cleanup ownership was lost before it could finish.",
        );
      }
    });
  }

  releaseCollectedDataCleanup(leaseOwner: string): void {
    this.database.prepare(`
      DELETE FROM collected_data_cleanup_lease WHERE singleton = 1 AND lease_owner = ?
    `).run(leaseOwner);
  }

  claimMediaGarbage(leaseOwner: string): MediaGarbageCollectionJob | undefined {
    return this.transaction(() => {
      if (this.isCollectedDataCleanupActive()) return undefined;
      const now = this.now();
      const nowIso = now.toISOString();
      const row = this.database.prepare(`
        SELECT tombstone.asset_id, tombstone.attempts, tombstone.lease_owner,
          asset.original_object_key, asset.thumbnail_object_key, asset.gallery_object_key,
          asset.object_keys_json
        FROM media_gc_tombstones tombstone
        JOIN media_assets asset ON asset.id = tombstone.asset_id
        LEFT JOIN media_jobs job ON job.asset_id = tombstone.asset_id
        WHERE (
          (tombstone.status = 'pending' AND tombstone.next_attempt_at <= ?)
          OR (
            tombstone.status = 'deleting'
            AND (tombstone.lease_expires_at IS NULL OR tombstone.lease_expires_at <= ?)
          )
        )
          AND NOT EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = tombstone.asset_id)
          AND (job.status IS NULL OR job.status <> 'processing')
        ORDER BY tombstone.next_attempt_at ASC, tombstone.created_at ASC, tombstone.asset_id ASC
        LIMIT 1
      `).get(nowIso, nowIso) as StoredMediaGarbageRow | undefined;
      if (!row) return undefined;

      const attempt = row.attempts + 1;
      const leaseToken = `${leaseOwner}:${randomUUID()}`;
      const leaseExpiresAt = new Date(now.getTime() + MEDIA_GC_LEASE_DURATION_MS).toISOString();
      this.database.prepare(`
        UPDATE media_gc_tombstones
        SET status = 'deleting', attempts = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE asset_id = ?
      `).run(attempt, leaseToken, leaseExpiresAt, nowIso, row.asset_id);
      const protectedKeys = new Set((this.database.prepare(`
        SELECT asset.*, tombstone.status AS gc_status
        FROM media_assets asset
        LEFT JOIN media_gc_tombstones tombstone ON tombstone.asset_id = asset.id
        WHERE asset.id <> ?
      `).all(row.asset_id) as Array<StoredMediaAssetRow & { gc_status: string | null }>)
        .filter((asset) => asset.gc_status !== "deleting")
        .flatMap(mediaObjectKeys));
      return {
        assetId: row.asset_id,
        objectKeys: mediaObjectKeys(row).filter((key) => !protectedKeys.has(key)),
        attempt,
        leaseOwner: leaseToken,
      };
    });
  }

  completeMediaGarbage(assetId: string, leaseOwner: string): void {
    this.transaction(() => {
      this.assertMediaGarbageLease(assetId, leaseOwner);
      if (this.database.prepare("SELECT 1 FROM listing_media WHERE asset_id = ? LIMIT 1").get(assetId)) {
        this.database.prepare("DELETE FROM media_gc_tombstones WHERE asset_id = ?").run(assetId);
        return;
      }
      this.database.prepare("DELETE FROM media_jobs WHERE asset_id = ?").run(assetId);
      this.database.prepare(`
        DELETE FROM media_assets
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = media_assets.id)
      `).run(assetId);
    });
  }

  failMediaGarbage(assetId: string, leaseOwner: string, retryDelayMs: number): void {
    this.assertMediaGarbageLease(assetId, leaseOwner);
    const now = this.now();
    this.database.prepare(`
      UPDATE media_gc_tombstones
      SET status = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE asset_id = ? AND lease_owner = ?
    `).run(new Date(now.getTime() + retryDelayMs).toISOString(), now.toISOString(), assetId, leaseOwner);
  }

  claimMediaJob(leaseOwner: string, leaseDurationMs: number): MediaJob | undefined {
    return this.transaction(() => {
      if (this.isCollectedDataCleanupActive()) return undefined;
      const now = this.now();
      const nowIso = now.toISOString();
      const row = this.database.prepare(`
        SELECT j.asset_id, j.attempts, a.source_url
        FROM media_jobs j
        JOIN media_assets a ON a.id = j.asset_id
        WHERE (
          (j.status = 'pending' AND j.next_attempt_at <= ?)
          OR (j.status = 'processing' AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at <= ?)
        )
        AND EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = j.asset_id)
        ORDER BY j.next_attempt_at ASC, j.created_at ASC, j.asset_id ASC
        LIMIT 1
      `).get(nowIso, nowIso) as StoredMediaJobRow | undefined;
      if (!row) return undefined;

      const attempt = row.attempts + 1;
      const leaseToken = `${leaseOwner}:${randomUUID()}`;
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      this.database.prepare(`
        UPDATE media_jobs
        SET status = 'processing', attempts = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE asset_id = ?
      `).run(attempt, leaseToken, leaseExpiresAt, nowIso, row.asset_id);
      this.database.prepare(`
        UPDATE media_assets
        SET status = 'processing', error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso, row.asset_id);
      return { assetId: row.asset_id, sourceUrl: row.source_url, attempt, leaseOwner: leaseToken };
    });
  }

  recoverProcessingMediaJobs(): number {
    return this.transaction(() => {
      const now = this.now().toISOString();
      const assetRows = this.database.prepare(`
        SELECT asset_id FROM media_jobs
        WHERE status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).all(now);
      if (!assetRows.length) return 0;
      this.database.prepare(`
        UPDATE media_jobs
        SET status = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).run(now, now, now);
      this.database.prepare(`
        UPDATE media_assets
        SET status = 'pending', updated_at = ?
        WHERE id IN (SELECT asset_id FROM media_jobs WHERE status = 'pending')
          AND status = 'processing'
      `).run(now);
      return assetRows.length;
    });
  }

  stageMediaJobObjects(assetId: string, leaseOwner: string, completed: CompletedMediaAsset): CompletedMediaAsset {
    return this.transaction(() => {
      this.assertCollectedDataCleanupInactive();
      this.assertMediaJobLease(assetId, leaseOwner);
      const row = this.database.prepare("SELECT * FROM media_assets WHERE id = ?")
        .get(assetId) as StoredMediaAssetRow | undefined;
      if (!row) throw new Error("The staged media asset no longer exists.");
      const isolated = this.storageIsolatedCompletedMedia(assetId, row, completed);
      const storedCompleted = isolated.completed;
      const objectKeys = uniqueStrings([
        ...parseMediaObjectKeys(row.object_keys_json),
        storedCompleted.originalObjectKey,
        storedCompleted.thumbnailObjectKey,
        storedCompleted.galleryObjectKey,
      ]);
      this.assertMediaObjectKeysAreNotBeingDeleted(assetId, objectKeys);
      const actualBytes = completedMediaSize(storedCompleted);
      const currentBytes = this.mediaReservedBytes();
      const projectedBytes = currentBytes
        - storedMediaAssetBytes(row, this.mediaAdmission.reservedBytesPerAsset)
        + actualBytes;
      if (
        projectedBytes > this.mediaAdmission.maxReservedBytes
        && projectedBytes > currentBytes
      ) {
        throw new ApiError(
          507,
          "MEDIA_STORAGE_BUDGET_EXCEEDED",
          "The processed media asset would exceed the configured storage budget.",
          { retryable: false },
        );
      }
      this.database.prepare(`
        UPDATE media_assets SET
          content_sha256 = ?, source_mime_type = ?, storage_generation = ?,
          original_object_key = ?, thumbnail_object_key = ?, gallery_object_key = ?,
          object_keys_json = ?,
          original_size_bytes = ?, thumbnail_size_bytes = ?, gallery_size_bytes = ?,
          width = ?, height = ?, updated_at = ?
        WHERE id = ?
      `).run(
        storedCompleted.contentSha256,
        storedCompleted.sourceMimeType,
        isolated.storageGeneration,
        storedCompleted.originalObjectKey,
        storedCompleted.thumbnailObjectKey,
        storedCompleted.galleryObjectKey,
        JSON.stringify(objectKeys),
        storedCompleted.originalSizeBytes,
        storedCompleted.thumbnailSizeBytes,
        storedCompleted.gallerySizeBytes,
        storedCompleted.width,
        storedCompleted.height,
        this.now().toISOString(),
        assetId,
      );
      return storedCompleted;
    });
  }

  completeMediaJob(assetId: string, leaseOwner: string, completed: CompletedMediaAsset): void {
    this.transaction(() => {
      this.assertCollectedDataCleanupInactive();
      this.assertMediaJobLease(assetId, leaseOwner);
      const staged = this.database.prepare("SELECT * FROM media_assets WHERE id = ?")
        .get(assetId) as StoredMediaAssetRow | undefined;
      if (!staged || !completedMediaMatchesStored(staged, completed)) {
        throw new ApiError(
          409,
          "MEDIA_STAGED_OBJECT_MISMATCH",
          "Completed media metadata does not match the objects admitted before upload.",
          { retryable: false },
        );
      }
      const now = this.now().toISOString();
      this.database.prepare(`
        UPDATE media_assets SET
          status = 'ready', content_sha256 = ?, source_mime_type = ?,
          original_object_key = ?, thumbnail_object_key = ?, gallery_object_key = ?,
          original_size_bytes = ?, thumbnail_size_bytes = ?, gallery_size_bytes = ?,
          width = ?, height = ?, error_code = NULL, error_message = NULL,
          ready_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        completed.contentSha256,
        completed.sourceMimeType,
        completed.originalObjectKey,
        completed.thumbnailObjectKey,
        completed.galleryObjectKey,
        completed.originalSizeBytes,
        completed.thumbnailSizeBytes,
        completed.gallerySizeBytes,
        completed.width,
        completed.height,
        now,
        now,
        assetId,
      );
      this.database.prepare(`
        UPDATE media_jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE asset_id = ?
      `).run(now, assetId);
    });
  }

  failMediaJob(
    assetId: string,
    leaseOwner: string,
    failure: { readonly code: string; readonly message: string },
    retryDelayMs?: number,
  ): void {
    this.transaction(() => {
      this.assertCollectedDataCleanupInactive();
      this.assertMediaJobLease(assetId, leaseOwner);
      const now = this.now();
      const nowIso = now.toISOString();
      const retrying = retryDelayMs !== undefined;
      this.database.prepare(`
        UPDATE media_assets
        SET status = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(retrying ? "pending" : "failed", failure.code, failure.message.slice(0, 2_000), nowIso, assetId);
      this.database.prepare(`
        UPDATE media_jobs SET
          status = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE asset_id = ?
      `).run(
        retrying ? "pending" : "failed",
        new Date(now.getTime() + (retryDelayMs ?? 0)).toISOString(),
        failure.code,
        failure.message.slice(0, 2_000),
        nowIso,
        assetId,
      );
    });
  }

  clearCollectedData(
    options: ClearCollectedDataOptions = {},
    cleanupLeaseOwner?: string,
  ): CollectedDataCounts {
    if (!cleanupLeaseOwner) {
      const cleanup = this.beginCollectedDataCleanup(options);
      try {
        return this.clearCollectedData(options, cleanup.leaseOwner);
      } finally {
        this.releaseCollectedDataCleanup(cleanup.leaseOwner);
      }
    }
    return this.transaction(() => {
      this.assertCollectedDataCleanupLease(cleanupLeaseOwner);
      this.assertCollectedDataCanBeCleared(options);

      const deleted = this.collectedDataCounts();
      this.database.exec(`
        DELETE FROM media_jobs;
        DELETE FROM listing_media;
        DELETE FROM media_assets;
        DELETE FROM evaluation_executions;
        DELETE FROM evaluation_attempts;
        DELETE FROM evaluations;
        DELETE FROM run_listings;
        DELETE FROM listings;
        DELETE FROM runs;
      `);

      const remaining = this.collectedDataCounts();
      if (
        Object.values(remaining).some((count) => count !== 0) ||
        this.mediaHealthCounts().pending !== 0 ||
        this.mediaHealthCounts().processing !== 0 ||
        this.mediaHealthCounts().ready !== 0 ||
        this.mediaHealthCounts().failed !== 0 ||
        this.countEvaluationAttempts() !== 0 ||
        this.countEvaluationExecutions() !== 0
      ) {
        throw new Error("Collected data cleanup did not leave every iteration table empty.");
      }
      return deleted;
    });
  }

  assertCollectedDataCanBeCleared(options: ClearCollectedDataOptions = {}): void {
    const activeExecution = this.database.prepare(`
      SELECT id, status
      FROM evaluation_executions
      WHERE status IN ('queued', 'running')
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (activeExecution) {
      throw new ApiError(
        409,
        "ACTIVE_EVALUATION_EXECUTION",
        `Evaluation execution ${readString(activeExecution, "id")} is still ${readString(activeExecution, "status")}.`,
      );
    }
    if (options.allowActiveRun) return;
    const activeRun = this.database.prepare(`
      SELECT id, status
      FROM runs
      WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(...ACTIVE_RUN_STATUSES) as Record<string, unknown> | undefined;
    if (!activeRun) return;
    const runId = readString(activeRun, "id");
    const status = readString(activeRun, "status");
    throw new ApiError(
      409,
      "ACTIVE_RUN",
      `Run ${runId} is still active (${status}). Wait for it to finish or cancel it before clearing data.`,
    );
  }

  ingest(request: IngestionRequest): IngestionResponse {
    return this.transaction(() => {
      this.assertCollectedDataCleanupInactive();
      const mediaBaseline = this.mediaGlobalUsage();
      this.assertRunMediaAdmissionBudget(request);
      this.upsertRun(request.run);
      this.recordRunMediaAdmissions(request);
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const incoming of request.listings) {
        this.upsertRunListingSnapshot(request.run.id, incoming);
        const outcome = this.rebuildCanonicalListing(incoming);
        const canonical = this.findListingRow(incoming);
        if (!canonical) throw new Error("The canonical listing was not persisted before media synchronization.");
        this.syncListingMedia(parseListingData(canonical.data_json));
        if (outcome === "inserted") inserted += 1;
        else if (outcome === "updated") updated += 1;
        else unchanged += 1;
      }
      this.assertMediaGlobalBudgets(mediaBaseline);

      return {
        runId: request.run.id,
        accepted: request.listings.length,
        inserted,
        updated,
        unchanged,
      };
    });
  }

  listListings(query: ListingsQuery): ListingsPage {
    const offset = decodeCursor(query.cursor);
    const { where, parameters } = listingWhere(query);
    const totalRow = this.database.prepare(`SELECT COUNT(*) AS total FROM listings l ${where}`).get(...parameters);
    const total = readNumber(totalRow, "total");
    const sortColumn = {
      updatedAt: "l.updated_at",
      scrapedAt: "l.scraped_at",
      priceEuros: "l.price_euros",
    }[query.sort];
    const rows = this.database.prepare(`
      SELECT l.* FROM listings l
      ${where}
      ORDER BY ${sortColumn} ${query.order.toUpperCase()}, l.source ASC, l.external_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, offset) as StoredListingRow[];
    const items = this.rowsToListings(rows);
    const nextOffset = offset + items.length;

    return {
      items,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      total,
    };
  }

  getListing(identity: ListingIdentity): ListingDetail | undefined {
    const row = this.findListingRow(identity);
    if (!row) return undefined;

    const listing = this.rowToListing(row);
    const runs = this.database.prepare(`
      SELECT run_id, observed_at, status, scraped_at
      FROM run_listings
      WHERE source = ? AND external_id = ?
      ORDER BY observed_at DESC, run_id ASC
    `).all(identity.source, identity.externalId).map((observation) => ({
      runId: readString(observation, "run_id"),
      observedAt: readString(observation, "observed_at"),
      status: readString(observation, "status"),
      scrapedAt: readString(observation, "scraped_at"),
    }));

    return listingDetailSchema.parse({
      ...listing,
      runs,
      evaluations: this.listEvaluations(identity),
    });
  }

  listRuns(query: RunsQuery): RunsPage {
    const offset = decodeCursor(query.cursor);
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.source) {
      clauses.push("source = ?");
      parameters.push(query.source);
    }
    if (query.status) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = readNumber(this.database.prepare(`SELECT COUNT(*) AS total FROM runs ${where}`).get(...parameters), "total");
    const rows = this.database.prepare(`
      SELECT * FROM runs ${where}
      ORDER BY updated_at ${query.order.toUpperCase()}, id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, offset) as StoredRunRow[];
    const items = rows.map(rowToRun);
    const nextOffset = offset + items.length;

    return { items, nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null, total };
  }

  getRun(id: string): RunDetail | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as StoredRunRow | undefined;
    if (!row) return undefined;
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS listing_count,
        COALESCE(SUM(CASE WHEN status = 'detailed' THEN 1 ELSE 0 END), 0) AS detailed_listing_count
      FROM run_listings
      WHERE run_id = ?
    `).get(id);

    return runDetailSchema.parse({
      ...rowToRun(row),
      listingCount: readNumber(counts, "listing_count"),
      detailedListingCount: readNumber(counts, "detailed_listing_count"),
    });
  }

  listRunListings(id: string, query: RunListingsQuery): RunListingsPage | undefined {
    if (!this.database.prepare("SELECT 1 FROM runs WHERE id = ?").get(id)) return undefined;
    const cursor = decodeRunListingsCursor(query.cursor);
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
    const total = readNumber(this.database.prepare(`
      SELECT COUNT(*) AS total FROM run_listings WHERE run_id = ?
    `).get(id), "total");
    const cursorClause = cursor
      ? `AND (
          observed_at < ?
          OR (observed_at = ? AND source > ?)
          OR (observed_at = ? AND source = ? AND external_id > ?)
        )`
      : "";
    const cursorParameters: SQLInputValue[] = cursor
      ? [
          cursor.observedAt,
          cursor.observedAt,
          cursor.source,
          cursor.observedAt,
          cursor.source,
          cursor.externalId,
        ]
      : [];
    const pageRows = this.database.prepare(`
      SELECT * FROM run_listings
      WHERE run_id = ?
      ${cursorClause}
      ORDER BY observed_at DESC, source ASC, external_id ASC
      LIMIT ?
    `).all(id, ...cursorParameters, limit + 1) as StoredRunListingRow[];
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0, limit);
    const items = rows.map((listing) => this.rowToRunSnapshot(listing, false));
    const lastRow = rows.at(-1);
    return runListingsPageSchema.parse({
      items,
      nextCursor: hasMore && lastRow ? encodeRunListingsCursor(lastRow) : null,
      total,
    });
  }

  listRecipes(): RecipeVersion[] {
    const rows = this.database.prepare(`
      SELECT * FROM recipe_versions ORDER BY active DESC, created_at DESC, id ASC, version DESC
    `).all() as StoredRecipeRow[];
    return rows.map(rowToRecipe);
  }

  getRecipe(id: string, version: number): RecipeVersion | undefined {
    const row = this.database.prepare(`
      SELECT * FROM recipe_versions WHERE id = ? AND version = ?
    `).get(id, version) as StoredRecipeRow | undefined;
    return row ? rowToRecipe(row) : undefined;
  }

  getActiveRecipe(): RecipeVersion | undefined {
    const row = this.database.prepare("SELECT * FROM recipe_versions WHERE active = 1").get() as StoredRecipeRow | undefined;
    return row ? rowToRecipe(row) : undefined;
  }

  saveRecipe(id: string, draft: RecipeDraft): RecipeVersion {
    return this.transaction(() => {
      const versionRow = this.database.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version FROM recipe_versions WHERE id = ?
      `).get(id);
      const version = readNumber(versionRow, "version");
      const createdAt = this.now().toISOString();
      const recipe = recipeVersionSchema.parse({ id, version, ...draft, active: false, createdAt });
      this.database.prepare(`
        INSERT INTO recipe_versions (id, version, active, created_at, data_json)
        VALUES (?, ?, 0, ?, ?)
      `).run(id, version, createdAt, JSON.stringify({ id, version, name: draft.name, threshold: draft.threshold, criteria: draft.criteria }));
      return recipe;
    });
  }

  activateRecipe(id: string, version?: number): RecipeVersion | undefined {
    return this.transaction(() => {
      const target = version === undefined
        ? this.database.prepare(`SELECT * FROM recipe_versions WHERE id = ? ORDER BY version DESC LIMIT 1`).get(id)
        : this.database.prepare(`SELECT * FROM recipe_versions WHERE id = ? AND version = ?`).get(id, version);
      if (!target) return undefined;
      const targetVersion = readNumber(target, "version");
      this.database.prepare("UPDATE recipe_versions SET active = 0 WHERE active = 1").run();
      this.database.prepare("UPDATE recipe_versions SET active = 1 WHERE id = ? AND version = ?").run(id, targetVersion);
      const activated = this.database.prepare(`SELECT * FROM recipe_versions WHERE id = ? AND version = ?`).get(id, targetVersion) as StoredRecipeRow;
      return rowToRecipe(activated);
    });
  }

  listEvaluationPlans(): EvaluationPlanVersion[] {
    const rows = this.database.prepare(`
      SELECT * FROM evaluation_plan_versions
      ORDER BY is_default DESC, created_at DESC, id ASC, version DESC
    `).all() as StoredEvaluationPlanRow[];
    return rows.map((row) => this.rowToEvaluationPlan(row));
  }

  getEvaluationPlan(id: string, version: number): EvaluationPlanVersion | undefined {
    const row = this.database.prepare(`
      SELECT * FROM evaluation_plan_versions WHERE id = ? AND version = ?
    `).get(id, version) as StoredEvaluationPlanRow | undefined;
    return row ? this.rowToEvaluationPlan(row) : undefined;
  }

  getResolvedEvaluationPlan(id: string, version: number): ResolvedEvaluationPlanVersion | undefined {
    const plan = this.getEvaluationPlan(id, version);
    if (!plan) return undefined;
    return resolvedEvaluationPlanVersionSchema.parse({
      ...plan,
      recipes: plan.recipes.map((reference) => {
        const recipe = this.getRecipe(reference.recipeId, reference.recipeVersion);
        if (!recipe) throw new Error("An evaluation plan references a missing recipe version.");
        return { ...reference, recipe };
      }),
    });
  }

  getDefaultEvaluationPlan(): ResolvedEvaluationPlanVersion | undefined {
    const row = this.database.prepare(`
      SELECT * FROM evaluation_plan_versions WHERE is_default = 1
    `).get() as StoredEvaluationPlanRow | undefined;
    return row ? this.getResolvedEvaluationPlan(row.id, row.version) : undefined;
  }

  saveEvaluationPlan(id: string, draft: EvaluationPlanDraft): EvaluationPlanVersion {
    return this.transaction(() => {
      for (const reference of draft.recipes) {
        if (!this.getRecipe(reference.recipeId, reference.recipeVersion)) {
          throw new ApiError(
            404,
            "RECIPE_NOT_FOUND",
            `Recipe ${reference.recipeId} version ${reference.recipeVersion} does not exist.`,
          );
        }
      }
      const version = readNumber(this.database.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version
        FROM evaluation_plan_versions WHERE id = ?
      `).get(id), "version");
      const createdAt = this.now().toISOString();
      const plan = evaluationPlanVersionSchema.parse({
        id,
        version,
        ...draft,
        combinerVersion: "tri-state-v1",
        isDefault: false,
        createdAt,
      });
      this.database.prepare(`
        INSERT INTO evaluation_plan_versions (
          id, version, is_default, created_at, name, operator, combiner_version, data_json
        ) VALUES (?, ?, 0, ?, ?, ?, 'tri-state-v1', ?)
      `).run(
        id,
        version,
        createdAt,
        draft.name,
        draft.operator,
        JSON.stringify({
          id,
          version,
          name: draft.name,
          operator: draft.operator,
          combinerVersion: "tri-state-v1",
          recipes: draft.recipes,
        }),
      );
      const insertRecipe = this.database.prepare(`
        INSERT INTO evaluation_plan_recipes (
          plan_id, plan_version, recipe_index, recipe_id, recipe_version
        ) VALUES (?, ?, ?, ?, ?)
      `);
      draft.recipes.forEach((reference, index) => {
        insertRecipe.run(id, version, index, reference.recipeId, reference.recipeVersion);
      });
      return plan;
    });
  }

  setDefaultEvaluationPlan(id: string, version: number): EvaluationPlanVersion | undefined {
    return this.transaction(() => {
      const target = this.database.prepare(`
        SELECT * FROM evaluation_plan_versions WHERE id = ? AND version = ?
      `).get(id, version) as StoredEvaluationPlanRow | undefined;
      if (!target) return undefined;
      this.database.prepare("UPDATE evaluation_plan_versions SET is_default = 0 WHERE is_default = 1").run();
      this.database.prepare(`
        UPDATE evaluation_plan_versions SET is_default = 1 WHERE id = ? AND version = ?
      `).run(id, version);
      const updated = this.database.prepare(`
        SELECT * FROM evaluation_plan_versions WHERE id = ? AND version = ?
      `).get(id, version) as StoredEvaluationPlanRow;
      return this.rowToEvaluationPlan(updated);
    });
  }

  getRunListingIds(runId: string): string[] | undefined {
    if (!this.getRun(runId)) return undefined;
    const rows = this.database.prepare(`
      SELECT source, external_id
      FROM run_listings
      WHERE run_id = ? AND status = 'detailed'
      ORDER BY observed_at DESC, source ASC, external_id ASC
    `).all(runId);
    return rows.map((row) => createListingKey({
      source: readString(row, "source") as ListingIdentity["source"],
      externalId: readString(row, "external_id"),
    }));
  }

  replayEvaluationExecution(
    idempotencyKey: string,
    requestFingerprint: string,
  ): CreateEvaluationExecutionResult | undefined {
    const row = this.database.prepare(`
      SELECT * FROM evaluation_executions WHERE idempotency_key = ?
    `).get(idempotencyKey) as StoredEvaluationExecutionRow | undefined;
    if (!row) return undefined;
    if (readString(row, "request_fingerprint") !== requestFingerprint) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "The Idempotency-Key was already used for a different evaluation execution request.",
      );
    }
    return { execution: this.rowToEvaluationExecution(row), created: false };
  }

  createEvaluationExecution(input: CreateEvaluationExecutionInput): CreateEvaluationExecutionResult {
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM evaluation_executions WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as StoredEvaluationExecutionRow | undefined;
      if (existing) {
        const fingerprint = readString(existing, "request_fingerprint");
        if (fingerprint !== input.requestFingerprint) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The Idempotency-Key was already used for a different evaluation execution request.",
          );
        }
        return { execution: this.rowToEvaluationExecution(existing), created: false };
      }

      if (!this.getRun(input.runId)) {
        throw new ApiError(404, "RUN_NOT_FOUND", "The requested run does not exist.");
      }
      const plan = this.getResolvedEvaluationPlan(input.request.planId, input.request.planVersion);
      if (!plan) {
        throw new ApiError(404, "EVALUATION_PLAN_NOT_FOUND", "The requested evaluation plan version does not exist.");
      }
      if (input.listingIds.length === 0) {
        throw new ApiError(409, "RUN_HAS_NO_LISTINGS", "The requested run has no listings to evaluate.");
      }
      const listings = this.getListingsForEvaluation(input.runId, input.listingIds);
      if (!listings) {
        throw new ApiError(404, "LISTING_NOT_FOUND", "One or more listings do not belong to the requested run.");
      }
      if (listings.some((listing) => listing.status !== "detailed")) {
        throw new ApiError(
          409,
          "LISTING_NOT_DETAILED",
          "Evaluation executions only accept detailed listings from the requested run.",
        );
      }

      const createdAt = this.now().toISOString();
      const counters = {
        total: input.listingIds.length,
        processed: 0,
        relevant: 0,
        notRelevant: 0,
        review: 0,
        failed: 0,
      };
      this.database.prepare(`
        INSERT INTO evaluation_executions (
          id, run_id, plan_id, plan_version, locale, status, force, retry_of_execution_id,
          idempotency_key, request_fingerprint, created_at, updated_at, request_json, counters_json
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.runId,
        input.request.planId,
        input.request.planVersion,
        input.request.locale,
        input.request.force === true ? 1 : 0,
        input.retryOfExecutionId ?? null,
        input.idempotencyKey,
        input.requestFingerprint,
        createdAt,
        createdAt,
        JSON.stringify({ ...input.request, listingIds: input.listingIds }),
        JSON.stringify(counters),
      );
      this.database.prepare(`
        INSERT INTO evaluation_execution_budgets (
          execution_id, limit_json, estimate_json, consumed_json, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.id,
        JSON.stringify(input.budget.limit),
        JSON.stringify(input.budget.estimate),
        JSON.stringify(input.budget.consumed),
        createdAt,
      );
      const insertItem = this.database.prepare(`
        INSERT INTO evaluation_execution_items (
          execution_id, run_id, source, external_id, item_index, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `);
      const insertStep = this.database.prepare(`
        INSERT INTO evaluation_execution_steps (
          execution_id, source, external_id, step_index, recipe_id, recipe_version, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      input.listingIds.forEach((listingId, itemIndex) => {
        const identity = parseListingKey(listingId);
        if (!identity) throw new Error(`Invalid evaluation execution listing id: ${listingId}`);
        insertItem.run(input.id, input.runId, identity.source, identity.externalId, itemIndex, createdAt);
        plan.recipes.forEach((reference, stepIndex) => {
          insertStep.run(
            input.id,
            identity.source,
            identity.externalId,
            stepIndex,
            reference.recipeId,
            reference.recipeVersion,
            createdAt,
          );
        });
      });
      const row = this.findEvaluationExecutionRow(input.id);
      if (!row) throw new Error("The evaluation execution was not created.");
      return { execution: this.rowToEvaluationExecution(row), created: true };
    });
  }

  getEvaluationExecution(id: string): EvaluationExecutionRecord | undefined {
    const row = this.findEvaluationExecutionRow(id);
    return row ? this.rowToEvaluationExecution(row) : undefined;
  }

  listEvaluationExecutions(query: EvaluationExecutionsQuery): EvaluationExecutionsPage {
    const offset = decodeCursor(query.cursor);
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.runId) {
      clauses.push("run_id = ?");
      parameters.push(query.runId);
    }
    if (query.status) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = readNumber(
      this.database.prepare(`SELECT COUNT(*) AS total FROM evaluation_executions ${where}`).get(...parameters),
      "total",
    );
    const rows = this.database.prepare(`
      SELECT * FROM evaluation_executions ${where}
      ORDER BY created_at ${query.order.toUpperCase()}, id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, query.limit, offset) as StoredEvaluationExecutionRow[];
    const items = rows.map((row) => this.rowToEvaluationExecution(row));
    const nextOffset = offset + items.length;
    return evaluationExecutionsPageSchema.parse({
      items,
      nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
      total,
    });
  }

  getEvaluationExecutionResults(id: string): EvaluationExecutionResults | undefined {
    if (!this.findEvaluationExecutionRow(id)) return undefined;
    const rows = this.database.prepare(`
      SELECT result_json
      FROM evaluation_execution_items
      WHERE execution_id = ? AND result_json IS NOT NULL
      ORDER BY item_index ASC
    `).all(id);
    return evaluationExecutionResultsSchema.parse({
      executionId: id,
      items: rows.map((row) => JSON.parse(readString(row, "result_json")) as unknown),
    });
  }

  claimNextEvaluationExecution(
    leaseOwner: string,
    leaseDurationMs: number,
  ): EvaluationExecutionRecord | undefined {
    return this.transaction(() => {
      const now = this.now();
      const nowIso = now.toISOString();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      const candidate = this.database.prepare(`
        SELECT id FROM evaluation_executions
        WHERE (status = 'queued' AND cancel_requested = 0) OR
          (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(nowIso);
      if (!candidate) return undefined;
      const id = readString(candidate, "id");
      const claimed = this.database.prepare(`
        UPDATE evaluation_executions
        SET status = 'running', started_at = COALESCE(started_at, ?), completed_at = NULL,
          updated_at = ?, error = NULL, lease_owner = ?, lease_expires_at = ?
        WHERE id = ? AND (
          (status = 'queued' AND cancel_requested = 0) OR
          (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      `).run(nowIso, nowIso, leaseOwner, leaseExpiresAt, id, nowIso);
      if (claimed.changes !== 1) return undefined;
      const row = this.findEvaluationExecutionRow(id);
      return row ? this.rowToEvaluationExecution(row) : undefined;
    });
  }

  renewEvaluationExecutionLease(id: string, leaseOwner: string, leaseDurationMs: number): boolean {
    const now = this.now();
    const result = this.database.prepare(`
      UPDATE evaluation_executions
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND cancel_requested = 0 AND lease_owner = ?
    `).run(
      new Date(now.getTime() + leaseDurationMs).toISOString(),
      now.toISOString(),
      id,
      leaseOwner,
    );
    return result.changes === 1;
  }

  releaseEvaluationExecutionLease(id: string, leaseOwner: string): void {
    this.database.prepare(`
      UPDATE evaluation_executions
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ?
    `).run(this.now().toISOString(), id, leaseOwner);
  }

  isEvaluationExecutionCancellationRequested(id: string): boolean {
    const row = this.database.prepare(`
      SELECT cancel_requested FROM evaluation_executions WHERE id = ?
    `).get(id);
    return row ? readNumber(row, "cancel_requested") === 1 : true;
  }

  requestEvaluationExecutionCancellation(id: string): EvaluationExecutionRecord | undefined {
    const row = this.findEvaluationExecutionRow(id);
    if (!row) return undefined;
    const existing = this.rowToEvaluationExecution(row);
    if (["completed", "partial", "failed", "cancelled"].includes(existing.status)) return existing;
    const now = this.now().toISOString();
    this.database.prepare(`
      UPDATE evaluation_executions SET cancel_requested = 1, updated_at = ? WHERE id = ?
    `).run(now, id);
    const inactiveLease = row.lease_owner === null
      || row.lease_expires_at === null
      || row.lease_expires_at <= now;
    if (existing.status === "queued" || (existing.status === "running" && inactiveLease)) {
      this.markEvaluationExecutionCancelled(id);
    }
    return this.getEvaluationExecution(id);
  }

  markEvaluationExecutionCancelled(id: string, leaseOwner?: string): void {
    this.transaction(() => {
      if (leaseOwner) this.assertEvaluationExecutionLease(id, leaseOwner);
      const now = this.now().toISOString();
      this.database.prepare(`
        UPDATE evaluation_execution_steps
        SET status = 'skipped', updated_at = ?
        WHERE execution_id = ? AND status IN ('pending', 'running')
      `).run(now, id);
      this.database.prepare(`
        UPDATE evaluation_execution_items
        SET status = 'cancelled', updated_at = ?
        WHERE execution_id = ? AND status IN ('pending', 'running')
      `).run(now, id);
      this.database.prepare(`
        UPDATE evaluation_executions
        SET status = 'cancelled', completed_at = ?, updated_at = ?,
          lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(now, now, id);
    });
  }

  nextEvaluationExecutionWorkItem(id: string, leaseOwner: string): EvaluationExecutionWorkItem | undefined {
    return this.transaction(() => {
      this.assertEvaluationExecutionLease(id, leaseOwner);
      const row = this.database.prepare(`
        SELECT * FROM evaluation_execution_items
        WHERE execution_id = ? AND status IN ('pending', 'running')
        ORDER BY item_index ASC
        LIMIT 1
      `).get(id) as StoredEvaluationExecutionItemRow | undefined;
      if (!row) return undefined;
      this.database.prepare(`
        UPDATE evaluation_execution_items SET status = 'running', updated_at = ?
        WHERE execution_id = ? AND source = ? AND external_id = ?
      `).run(this.now().toISOString(), id, row.source, row.external_id);
      return {
        executionId: id,
        runId: row.run_id,
        listingId: createListingKey({
          source: row.source as ListingIdentity["source"],
          externalId: row.external_id,
        }),
      };
    });
  }

  claimEvaluationExecutionStepBatch(
    id: string,
    leaseOwner: string,
    recipeId: string,
    recipeVersion: number,
    limit: number,
  ): EvaluationExecutionStepWorkItem[] {
    return this.transaction(() => {
      this.assertEvaluationExecutionLease(id, leaseOwner);
      const rows = this.database.prepare(`
        SELECT steps.source, steps.external_id, steps.status
        FROM evaluation_execution_steps steps
        INNER JOIN evaluation_execution_items items
          ON items.execution_id = steps.execution_id
          AND items.source = steps.source
          AND items.external_id = steps.external_id
        WHERE steps.execution_id = ? AND steps.recipe_id = ? AND steps.recipe_version = ?
          AND steps.status IN ('pending', 'running')
          AND items.status IN ('pending', 'running')
        ORDER BY items.item_index ASC
        LIMIT ?
      `).all(id, recipeId, recipeVersion, Math.max(1, Math.floor(limit))) as Array<{
        source: string;
        external_id: string;
        status: string;
      }>;
      if (rows.length === 0) return [];

      const now = this.now().toISOString();
      const markItem = this.database.prepare(`
        UPDATE evaluation_execution_items SET status = 'running', updated_at = ?
        WHERE execution_id = ? AND source = ? AND external_id = ?
          AND status IN ('pending', 'running')
      `);
      const markStep = this.database.prepare(`
        UPDATE evaluation_execution_steps SET status = 'running', updated_at = ?
        WHERE execution_id = ? AND source = ? AND external_id = ?
          AND recipe_id = ? AND recipe_version = ? AND status IN ('pending', 'running')
      `);
      return rows.map((row) => {
        markItem.run(now, id, row.source, row.external_id);
        markStep.run(now, id, row.source, row.external_id, recipeId, recipeVersion);
        return {
          listingId: createListingKey({
            source: row.source as ListingIdentity["source"],
            externalId: row.external_id,
          }),
          resumed: row.status === "running",
        };
      });
    });
  }

  getEvaluationExecutionSteps(id: string, listingId: string): StoredExecutionStep[] {
    const identity = parseListingKey(listingId);
    if (!identity) return [];
    const rows = this.database.prepare(`
      SELECT recipe_id, recipe_version, status, evaluation_json, error_json
      FROM evaluation_execution_steps
      WHERE execution_id = ? AND source = ? AND external_id = ?
      ORDER BY step_index ASC
    `).all(id, identity.source, identity.externalId) as StoredEvaluationExecutionStepRow[];
    return rows.map(rowToStoredExecutionStep);
  }

  markEvaluationExecutionStepRunning(
    id: string,
    leaseOwner: string,
    listingId: string,
    recipeId: string,
    recipeVersion: number,
  ): void {
    const identity = parseListingKey(listingId);
    if (!identity) throw new Error(`Invalid execution step listing id: ${listingId}`);
    const updated = this.database.prepare(`
      UPDATE evaluation_execution_steps
      SET status = 'running', updated_at = ?
      WHERE execution_id = ? AND source = ? AND external_id = ?
        AND recipe_id = ? AND recipe_version = ? AND status IN ('pending', 'running')
        AND EXISTS (
          SELECT 1 FROM evaluation_executions execution
          WHERE execution.id = evaluation_execution_steps.execution_id
            AND execution.status = 'running' AND execution.lease_owner = ?
        )
    `).run(
      this.now().toISOString(),
      id,
      identity.source,
      identity.externalId,
      recipeId,
      recipeVersion,
      leaseOwner,
    );
    if (updated.changes !== 1) throw new Error("The evaluation execution lease was lost before starting its step.");
  }

  completeEvaluationExecutionStep(
    id: string,
    leaseOwner: string,
    listingId: string,
    step: Exclude<StoredExecutionStep, { status: "pending" | "running" | "skipped" }>,
  ): void {
    const identity = parseListingKey(listingId);
    if (!identity) throw new Error(`Invalid execution step listing id: ${listingId}`);
    const updated = this.database.prepare(`
      UPDATE evaluation_execution_steps
      SET status = ?, evaluation_json = ?, error_json = ?, updated_at = ?
      WHERE execution_id = ? AND source = ? AND external_id = ?
        AND recipe_id = ? AND recipe_version = ?
        AND EXISTS (
          SELECT 1 FROM evaluation_executions execution
          WHERE execution.id = evaluation_execution_steps.execution_id
            AND execution.status = 'running' AND execution.lease_owner = ?
        )
    `).run(
      step.status,
      "evaluation" in step ? JSON.stringify({ evaluation: step.evaluation, evaluator: step.evaluator }) : null,
      "error" in step ? JSON.stringify(step.error) : null,
      this.now().toISOString(),
      id,
      identity.source,
      identity.externalId,
      step.recipeId,
      step.recipeVersion,
      leaseOwner,
    );
    if (updated.changes !== 1) throw new Error("The evaluation execution lease was lost before completing its step.");
  }

  completeEvaluationExecutionItem(leaseOwner: string, result: EvaluationExecutionListingResult): void {
    const identity = parseListingKey(result.listingId);
    if (!identity) throw new Error(`Invalid execution result listing id: ${result.listingId}`);
    this.transaction(() => {
      this.assertEvaluationExecutionLease(result.executionId, leaseOwner);
      const now = this.now().toISOString();
      this.database.prepare(`
        UPDATE evaluation_execution_items
        SET status = 'completed', result_json = ?, updated_at = ?
        WHERE execution_id = ? AND source = ? AND external_id = ?
      `).run(JSON.stringify(result), now, result.executionId, identity.source, identity.externalId);
      this.refreshEvaluationExecutionCounters(result.executionId);
    });
  }

  finishEvaluationExecution(id: string, leaseOwner: string): EvaluationExecutionRecord | undefined {
    return this.transaction(() => {
      this.assertEvaluationExecutionLease(id, leaseOwner);
      this.refreshEvaluationExecutionCounters(id);
      const execution = this.getEvaluationExecution(id);
      if (!execution) return undefined;
      if (execution.counters.processed !== execution.counters.total) return execution;
      const status = execution.counters.failed === 0
        ? "completed"
        : execution.counters.failed === execution.counters.total
          ? "failed"
          : "partial";
      const now = this.now().toISOString();
      this.database.prepare(`
        UPDATE evaluation_executions
        SET status = ?, completed_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_owner = ?
      `).run(status, now, now, id, leaseOwner);
      return this.getEvaluationExecution(id);
    });
  }

  failEvaluationExecution(id: string, leaseOwner: string, error: string): EvaluationExecutionRecord | undefined {
    const now = this.now().toISOString();
    this.database.prepare(`
      UPDATE evaluation_executions
      SET status = 'failed', completed_at = ?, updated_at = ?, error = ?,
        lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND status IN ('queued', 'running') AND lease_owner = ?
    `).run(now, now, error.slice(0, 2_000), id, leaseOwner);
    return this.getEvaluationExecution(id);
  }

  countEvaluationExecutions(): number {
    return readNumber(this.database.prepare("SELECT COUNT(*) AS total FROM evaluation_executions").get(), "total");
  }

  reserveEvaluationProviderCall(
    id: string,
    leaseOwner: string,
    reserved: EvaluationExecutionResourceUsage,
  ): EvaluationProviderCallReservation {
    return this.transaction(() => {
      this.assertEvaluationExecutionLease(id, leaseOwner);
      const budget = this.getEvaluationExecutionBudget(id);
      const nextConsumed = addUsage(budget.consumed, reserved);
      if (exceedsUsage(nextConsumed, budget.limit)) {
        throw new ApiError(
          429,
          "EVALUATION_EXECUTION_BUDGET_EXHAUSTED",
          "The evaluation execution exhausted its provider-call budget.",
        );
      }
      const reservationId = randomUUID();
      const now = this.now().toISOString();
      this.database.prepare(`
        INSERT INTO evaluation_provider_call_reservations (
          id, execution_id, reserved_json, settled, created_at
        ) VALUES (?, ?, ?, 0, ?)
      `).run(reservationId, id, JSON.stringify(reserved), now);
      this.database.prepare(`
        UPDATE evaluation_execution_budgets SET consumed_json = ?, updated_at = ? WHERE execution_id = ?
      `).run(JSON.stringify(nextConsumed), now, id);
      return { id: reservationId, reserved };
    });
  }

  settleEvaluationProviderCall(
    id: string,
    leaseOwner: string,
    reservation: EvaluationProviderCallReservation,
    actual: EvaluationExecutionResourceUsage,
  ): void {
    this.transaction(() => {
      this.assertEvaluationExecutionLease(id, leaseOwner);
      const row = this.database.prepare(`
        SELECT settled, reserved_json
        FROM evaluation_provider_call_reservations
        WHERE id = ? AND execution_id = ?
      `).get(reservation.id, id);
      if (!row || readNumber(row, "settled") === 1) return;
      const persistedReserved = parseResourceUsage(readString(row, "reserved_json"));
      const budget = this.getEvaluationExecutionBudget(id);
      const nextConsumed = addUsage(subtractUsage(budget.consumed, persistedReserved), actual);
      const now = this.now().toISOString();
      this.database.prepare(`
        UPDATE evaluation_provider_call_reservations
        SET settled = 1, settled_at = ? WHERE id = ? AND settled = 0
      `).run(now, reservation.id);
      this.database.prepare(`
        UPDATE evaluation_execution_budgets SET consumed_json = ?, updated_at = ? WHERE execution_id = ?
      `).run(JSON.stringify(nextConsumed), now, id);
    });
  }

  tryReserveGlobalProviderCall(
    reservation: GlobalProviderCallReservation,
    cutoff: string,
    limit: EvaluationExecutionResourceUsage,
  ): boolean {
    return this.transaction(() => {
      this.pruneGlobalProviderCalls(cutoff);
      const candidate = addUsage(this.readGlobalProviderUsage(), reservation.usage);
      if (exceedsUsage(candidate, limit)) return false;
      this.database.prepare(`
        INSERT INTO global_provider_call_reservations (
          id, created_at, settled, provider_calls, input_tokens, output_tokens, cost_micro_usd
        ) VALUES (?, ?, 0, ?, ?, ?, ?)
      `).run(
        reservation.id,
        reservation.createdAt,
        reservation.usage.providerCalls,
        reservation.usage.inputTokens,
        reservation.usage.outputTokens,
        reservation.usage.costMicroUsd,
      );
      return true;
    });
  }

  settleGlobalProviderCall(
    id: string,
    usage: EvaluationExecutionResourceUsage,
    settledAt: string,
    cutoff: string,
  ): void {
    this.transaction(() => {
      this.pruneGlobalProviderCalls(cutoff);
      this.database.prepare(`
        UPDATE global_provider_call_reservations
        SET settled = 1, provider_calls = ?, input_tokens = ?, output_tokens = ?,
          cost_micro_usd = ?, settled_at = ?
        WHERE id = ? AND settled = 0
      `).run(
        usage.providerCalls,
        usage.inputTokens,
        usage.outputTokens,
        usage.costMicroUsd,
        settledAt,
        id,
      );
    });
  }

  releaseGlobalProviderCall(id: string, cutoff: string): void {
    this.transaction(() => {
      this.pruneGlobalProviderCalls(cutoff);
      this.database.prepare(`
        DELETE FROM global_provider_call_reservations WHERE id = ? AND settled = 0
      `).run(id);
    });
  }

  getGlobalProviderUsage(cutoff: string): EvaluationExecutionResourceUsage {
    return this.transaction(() => {
      this.pruneGlobalProviderCalls(cutoff);
      return this.readGlobalProviderUsage();
    });
  }

  private pruneGlobalProviderCalls(cutoff: string): void {
    this.database.prepare("DELETE FROM global_provider_call_reservations WHERE created_at <= ?").run(cutoff);
  }

  private readGlobalProviderUsage(): EvaluationExecutionResourceUsage {
    const row = this.database.prepare(`
      SELECT
        COALESCE(SUM(provider_calls), 0) AS provider_calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
      FROM global_provider_call_reservations
    `).get();
    return {
      providerCalls: readNumber(row, "provider_calls"),
      inputTokens: readNumber(row, "input_tokens"),
      outputTokens: readNumber(row, "output_tokens"),
      costMicroUsd: readNumber(row, "cost_micro_usd"),
    };
  }

  getListingsForEvaluation(runId: string, listingIds: readonly string[]): ListingRecord[] | undefined {
    const records: ListingRecord[] = [];
    for (const listingId of listingIds) {
      const identity = parseListingKey(listingId);
      if (!identity) return undefined;
      const row = this.database.prepare(`
        SELECT * FROM run_listings
        WHERE run_id = ? AND source = ? AND external_id = ?
      `).get(runId, identity.source, identity.externalId) as StoredRunListingRow | undefined;
      if (!row) return undefined;
      records.push(this.rowToRunSnapshot(row));
    }
    return records;
  }

  findEvaluation(
    runId: string,
    identity: ListingIdentity,
    request: EvaluationRequest,
    inputFingerprint?: string,
  ): ListingEvaluationRecord | undefined {
    const fingerprintClause = inputFingerprint ? "AND input_fingerprint = ?" : "";
    const parameters: SQLInputValue[] = [
      runId,
      identity.source,
      identity.externalId,
      request.recipeId,
      request.recipeVersion,
      request.locale,
      ...(inputFingerprint ? [inputFingerprint] : []),
    ];
    const row = this.database.prepare(`
      SELECT * FROM evaluations
      WHERE run_id = ? AND source = ? AND external_id = ?
        AND recipe_id = ? AND recipe_version = ? AND locale = ?
        ${fingerprintClause}
    `).get(...parameters) as StoredEvaluationRow | undefined;
    return row ? rowToEvaluation(row) : undefined;
  }

  startEvaluationAttempt(input: EvaluationAttemptInput): void {
    const identity = parseListingKey(input.listingId);
    if (!identity) throw new Error(`Invalid evaluation attempt listing id: ${input.listingId}`);
    const attemptNumber = readNumber(this.database.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
      FROM evaluation_attempts
      WHERE run_id = ? AND source = ? AND external_id = ?
        AND recipe_id = ? AND recipe_version = ? AND locale = ? AND input_fingerprint = ?
    `).get(
      input.runId,
      identity.source,
      identity.externalId,
      input.recipeId,
      input.recipeVersion,
      input.locale,
      input.inputFingerprint,
    ), "attempt_number");
    this.database.prepare(`
      INSERT INTO evaluation_attempts (
        attempt_id, request_id, run_id, source, external_id, recipe_id, recipe_version,
        locale, input_fingerprint, attempt_number, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `).run(
      input.attemptId,
      input.requestId,
      input.runId,
      identity.source,
      identity.externalId,
      input.recipeId,
      input.recipeVersion,
      input.locale,
      input.inputFingerprint,
      attemptNumber,
      this.now().toISOString(),
    );
  }

  saveEvaluationResult(input: {
    readonly attemptId: string;
    readonly runId: string;
    readonly locale: EvaluationRequest["locale"];
    readonly recipeId: string;
    readonly recipeVersion: number;
    readonly evaluator: Evaluator;
    readonly result: ListingEvaluationResult;
    readonly inputFingerprint: string;
    readonly responseId?: string;
  }): ListingEvaluationRecord {
    return this.transaction(() => {
      const identity = parseListingKey(input.result.listingId);
      if (!identity) throw new Error(`Invalid persisted listing id: ${input.result.listingId}`);
      const transition = this.database.prepare(`
        UPDATE evaluation_attempts
        SET status = 'succeeded', completed_at = ?, evaluator_json = ?, result_json = ?, response_id = ?
        WHERE attempt_id = ? AND status = 'running'
          AND run_id = ? AND source = ? AND external_id = ?
          AND recipe_id = ? AND recipe_version = ? AND locale = ? AND input_fingerprint = ?
      `).run(
        this.now().toISOString(),
        JSON.stringify(input.evaluator),
        JSON.stringify(input.result),
        input.responseId ?? null,
        input.attemptId,
        input.runId,
        identity.source,
        identity.externalId,
        input.recipeId,
        input.recipeVersion,
        input.locale,
        input.inputFingerprint,
      );
      if (transition.changes !== 1) {
        throw new Error("The evaluation attempt is missing, completed, or does not match the result.");
      }
      this.upsertEvaluation({
        runId: input.runId,
        locale: input.locale,
        recipeId: input.recipeId,
        recipeVersion: input.recipeVersion,
        evaluator: input.evaluator,
        result: input.result,
        inputFingerprint: input.inputFingerprint,
      });
      const stored = this.findEvaluation(input.runId, identity, {
        locale: input.locale,
        recipeId: input.recipeId,
        recipeVersion: input.recipeVersion,
        listingIds: [input.result.listingId],
      }, input.inputFingerprint);
      if (!stored) throw new Error("The evaluation was not persisted.");
      return stored;
    });
  }

  failEvaluationAttempt(attemptId: string, failure: EvaluationAttemptFailure): void {
    this.database.prepare(`
      UPDATE evaluation_attempts
      SET status = 'failed', completed_at = ?, response_id = ?, error_code = ?, error_stage = ?,
        criterion_id = ?, retryable = ?
      WHERE attempt_id = ? AND status = 'running'
    `).run(
      this.now().toISOString(),
      failure.responseId ?? null,
      failure.code,
      failure.stage,
      failure.criterionId ?? null,
      failure.retryable ? 1 : 0,
      attemptId,
    );
  }

  countEvaluationAttempts(): number {
    return readNumber(this.database.prepare("SELECT COUNT(*) AS total FROM evaluation_attempts").get(), "total");
  }

  saveEvaluationBatch(response: FilterListingsResponse): ListingEvaluationRecord[] {
    return this.transaction(() => response.results.map((result) => {
      const identity = parseListingKey(result.listingId);
      if (!identity) throw new Error(`Invalid persisted listing id: ${result.listingId}`);
      this.upsertEvaluation({
        runId: response.runId,
        locale: response.locale,
        recipeId: response.recipeId,
        recipeVersion: response.recipeVersion,
        evaluator: response.evaluator,
        result,
      });
      const stored = this.findEvaluation(response.runId, identity, {
        locale: response.locale,
        recipeId: response.recipeId,
        recipeVersion: response.recipeVersion,
        listingIds: [result.listingId],
      });
      if (!stored) throw new Error("The evaluation was not persisted.");
      return stored;
    }));
  }

  private upsertEvaluation(input: {
    readonly runId: string;
    readonly locale: EvaluationRequest["locale"];
    readonly recipeId: string;
    readonly recipeVersion: number;
    readonly evaluator: Evaluator;
    readonly result: ListingEvaluationResult;
    readonly inputFingerprint?: string;
  }): void {
    const identity = parseListingKey(input.result.listingId);
    if (!identity) throw new Error(`Invalid persisted listing id: ${input.result.listingId}`);
    this.database.prepare(`
      INSERT INTO evaluations (
        run_id, source, external_id, recipe_id, recipe_version, locale, evaluated_at,
        decision, score, evaluator_json, result_json, input_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, source, external_id, recipe_id, recipe_version, locale) DO UPDATE SET
        evaluated_at = excluded.evaluated_at,
        decision = excluded.decision,
        score = excluded.score,
        evaluator_json = excluded.evaluator_json,
        result_json = excluded.result_json,
        input_fingerprint = COALESCE(excluded.input_fingerprint, evaluations.input_fingerprint)
    `).run(
      input.runId,
      identity.source,
      identity.externalId,
      input.recipeId,
      input.recipeVersion,
      input.locale,
      input.result.evaluatedAt,
      input.result.decision,
      input.result.score,
      JSON.stringify(input.evaluator),
      JSON.stringify(input.result),
      input.inputFingerprint ?? null,
    );
  }

  private backfillListingMedia(): void {
    const listings = this.database.prepare("SELECT * FROM listings ORDER BY source, external_id")
      .all() as StoredListingRow[];
    if (!listings.length) return;
    for (const row of listings) this.syncListingMedia(parseListingData(row.data_json), false);
  }

  private backfillRunMediaAdmissions(): void {
    const snapshots = this.database.prepare(`
      SELECT run_id, observation_json FROM run_listings ORDER BY run_id, source, external_id
    `).all() as Array<{ run_id: string; observation_json: string }>;
    if (!snapshots.length) return;
    const insert = this.database.prepare(`
      INSERT INTO run_media_admissions (run_id, asset_id, admitted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, asset_id) DO NOTHING
    `);
    const admittedAt = this.now().toISOString();
    for (const snapshot of snapshots) {
      for (const sourceUrl of listingMediaSourceUrls(parseListingData(snapshot.observation_json))) {
        insert.run(snapshot.run_id, mediaAssetId(sourceUrl), admittedAt);
      }
    }
  }

  private recordRunMediaAdmissions(request: IngestionRequest): void {
    const insert = this.database.prepare(`
      INSERT INTO run_media_admissions (run_id, asset_id, admitted_at)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, asset_id) DO NOTHING
    `);
    const admittedAt = this.now().toISOString();
    const assetIds = new Set(request.listings.flatMap((listing) =>
      listingMediaSourceUrls(listing).map(mediaAssetId)));
    for (const assetId of assetIds) insert.run(request.run.id, assetId, admittedAt);
  }

  private syncListingMedia(listing: ListingIngestion, queueOrphans = true): void {
    const sourceUrls = listingMediaSourceUrls(listing);
    const now = this.now().toISOString();

    this.database.prepare("DELETE FROM listing_media WHERE source = ? AND external_id = ?")
      .run(listing.source, listing.externalId);
    sourceUrls.forEach((sourceUrl, position) => {
      const assetId = mediaAssetId(sourceUrl);
      const tombstone = this.database.prepare(
        "SELECT status FROM media_gc_tombstones WHERE asset_id = ?",
      ).get(assetId);
      if (tombstone && readString(tombstone, "status") === "deleting") {
        throw new ApiError(
          409,
          "MEDIA_ASSET_GC_IN_PROGRESS",
          "A referenced media asset is currently being deleted; retry the ingestion shortly.",
        );
      }
      this.database.prepare(`
        INSERT INTO media_assets (id, source_url, status, storage_generation, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(source_url) DO NOTHING
      `).run(assetId, sourceUrl, randomUUID(), now, now);
      this.database.prepare(`
        INSERT INTO media_jobs (asset_id, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(asset_id) DO NOTHING
      `).run(assetId, now, now, now);
      this.database.prepare(`
        INSERT INTO listing_media (source, external_id, position, asset_id)
        VALUES (?, ?, ?, ?)
      `).run(listing.source, listing.externalId, position, assetId);
      this.database.prepare("DELETE FROM media_gc_tombstones WHERE asset_id = ?").run(assetId);
    });
    if (queueOrphans) this.queueOrphanMediaAssets();
  }

  private assertRunMediaAdmissionBudget(request: IngestionRequest): void {
    const incomingAssetIds = new Set(request.listings.flatMap((listing) =>
      listingMediaSourceUrls(listing).map(mediaAssetId)));
    const currentRunAssetIds = new Set((this.database.prepare(`
      SELECT asset_id FROM run_media_admissions WHERE run_id = ?
    `).all(request.run.id) as Array<{ asset_id: string }>).map((row) => row.asset_id));
    const baseline = currentRunAssetIds.size;
    for (const assetId of incomingAssetIds) currentRunAssetIds.add(assetId);
    if (
      currentRunAssetIds.size > this.mediaAdmission.maxAssetsPerRun
      && currentRunAssetIds.size > baseline
    ) {
      throw new ApiError(
        429,
        "MEDIA_RUN_BUDGET_EXCEEDED",
        `Run media is limited to ${this.mediaAdmission.maxAssetsPerRun} distinct assets.`,
      );
    }
  }

  private mediaGlobalUsage(): MediaGlobalUsage {
    return {
      pendingJobs: readNumber(this.database.prepare(`
      SELECT COUNT(*) AS total FROM (
        SELECT asset_id FROM media_jobs WHERE status IN ('pending', 'processing')
        UNION
        SELECT asset_id FROM media_gc_tombstones WHERE status IN ('pending', 'deleting')
      )
      `).get(), "total"),
      reservedBytes: this.mediaReservedBytes(),
    };
  }

  private assertMediaGlobalBudgets(baseline: MediaGlobalUsage, legacyBackfill = false): void {
    const projected = this.mediaGlobalUsage();
    if (
      projected.pendingJobs > this.mediaAdmission.maxPendingJobs
      && projected.pendingJobs > baseline.pendingJobs
    ) {
      throw new ApiError(
        429,
        "MEDIA_QUEUE_BUDGET_EXCEEDED",
        legacyBackfill
          ? `Legacy media backfill would grow queued work from ${baseline.pendingJobs} to ${projected.pendingJobs}, above MEDIA_MAX_PENDING_JOBS=${this.mediaAdmission.maxPendingJobs}. Raise the limit or clean legacy collected data before restarting.`
          : `Media ingestion is paused while ${projected.pendingJobs} assets would be queued.`,
      );
    }

    if (
      projected.reservedBytes > this.mediaAdmission.maxReservedBytes
      && projected.reservedBytes > baseline.reservedBytes
    ) {
      throw new ApiError(
        507,
        "MEDIA_STORAGE_BUDGET_EXCEEDED",
        legacyBackfill
          ? `Legacy media backfill would grow reserved bytes from ${baseline.reservedBytes} to ${projected.reservedBytes}, above MEDIA_MAX_RESERVED_BYTES=${this.mediaAdmission.maxReservedBytes}. Raise the limit or clean legacy collected data before restarting.`
          : "The configured media storage budget would be exceeded.",
      );
    }
  }

  private mediaReservedBytes(): number {
    return readNumber(this.database.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN asset.original_size_bytes IS NOT NULL
            AND asset.thumbnail_size_bytes IS NOT NULL
            AND asset.gallery_size_bytes IS NOT NULL
          THEN asset.original_size_bytes + asset.thumbnail_size_bytes + asset.gallery_size_bytes
          ELSE ?
        END
      ), 0) AS total
      FROM media_assets asset
    `).get(this.mediaAdmission.reservedBytesPerAsset), "total");
  }

  private listListingMedia(listing: ListingIngestion): ListingImageAsset[] {
    const sourceUrls = listingMediaSourceUrls(listing);
    const bySourceUrl = this.mediaAssetsBySourceUrl(sourceUrls);
    return sourceUrls.flatMap((sourceUrl) => {
      const asset = bySourceUrl.get(sourceUrl);
      return asset ? [asset] : [];
    });
  }

  private mediaAssetsBySourceUrl(sourceUrls: readonly string[]): Map<string, ListingImageAsset> {
    if (!sourceUrls.length) return new Map();
    const placeholders = sourceUrls.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT * FROM media_assets WHERE source_url IN (${placeholders})
    `).all(...sourceUrls) as StoredMediaAssetRow[];
    return new Map(rows.map((row) => [row.source_url, toListingImageAsset(row)]));
  }

  private assertMediaJobLease(assetId: string, leaseOwner: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS owned FROM media_jobs
      WHERE asset_id = ? AND status = 'processing' AND lease_owner = ?
    `).get(assetId, leaseOwner);
    if (!row) throw new Error("The media job lease is no longer owned by this worker.");
  }

  private assertCollectedDataCleanupInactive(): void {
    if (!this.isCollectedDataCleanupActive()) return;
    throw new ApiError(
      503,
      "MAINTENANCE_IN_PROGRESS",
      "Collected data cleanup is in progress.",
      { retryable: true },
    );
  }

  private assertCollectedDataCleanupLease(leaseOwner: string): void {
    const row = this.database.prepare(`
      SELECT 1 FROM collected_data_cleanup_lease
      WHERE singleton = 1 AND lease_owner = ?
    `).get(leaseOwner);
    if (row) return;
    throw new ApiError(
      409,
      "MEDIA_CLEANUP_LEASE_LOST",
      "Collected data cleanup ownership was lost before SQLite could be cleared.",
    );
  }

  private assertMediaGarbageLease(assetId: string, leaseOwner: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS owned FROM media_gc_tombstones
      WHERE asset_id = ? AND status = 'deleting' AND lease_owner = ?
    `).get(assetId, leaseOwner);
    if (!row) throw new Error("The media garbage-collection lease is no longer owned by this worker.");
  }

  private reconcileLegacyMedia(): void {
    this.transaction(() => {
      this.assertCollectedDataCleanupInactive();
      const baselineGlobal = this.mediaGlobalUsage();
      const baselineRuns = new Map((this.database.prepare(`
        SELECT run_id, COUNT(*) AS total
        FROM run_media_admissions
        GROUP BY run_id
      `).all() as Array<{ run_id: string; total: number }>).map((row) => [row.run_id, row.total]));

      this.backfillListingMedia();
      this.backfillRunMediaAdmissions();
      this.queueOrphanMediaAssets();

      const overBudgetRun = (this.database.prepare(`
        SELECT run_id, COUNT(*) AS total
        FROM run_media_admissions
        GROUP BY run_id
        HAVING COUNT(*) > ?
        ORDER BY run_id ASC
      `).all(this.mediaAdmission.maxAssetsPerRun) as Array<{ run_id: string; total: number }>)
        .find((row) => row.total > (baselineRuns.get(row.run_id) ?? 0));
      if (overBudgetRun) {
        throw new ApiError(
          429,
          "MEDIA_RUN_BUDGET_EXCEEDED",
          `Legacy run ${overBudgetRun.run_id} would grow to ${overBudgetRun.total} distinct media assets, above MEDIA_MAX_ASSETS_PER_RUN=${this.mediaAdmission.maxAssetsPerRun}. Raise the limit or clean legacy collected data before restarting.`,
        );
      }
      this.assertMediaGlobalBudgets(baselineGlobal, true);
    });
  }

  private storageIsolatedCompletedMedia(
    assetId: string,
    asset: StoredMediaAssetRow,
    completed: CompletedMediaAsset,
  ): { readonly completed: CompletedMediaAsset; readonly storageGeneration: string } {
    const shared = this.database.prepare(`
      SELECT candidate.*
      FROM media_assets candidate
      LEFT JOIN media_gc_tombstones tombstone ON tombstone.asset_id = candidate.id
      WHERE candidate.id <> ?
        AND candidate.status = 'ready'
        AND candidate.content_sha256 = ?
        AND candidate.source_mime_type = ?
        AND candidate.original_size_bytes = ?
        AND candidate.thumbnail_size_bytes = ?
        AND candidate.gallery_size_bytes = ?
        AND candidate.width = ?
        AND candidate.height = ?
        AND candidate.original_object_key IS NOT NULL
        AND candidate.thumbnail_object_key IS NOT NULL
        AND candidate.gallery_object_key IS NOT NULL
        AND (tombstone.status IS NULL OR tombstone.status <> 'deleting')
      ORDER BY
        CASE WHEN EXISTS (
          SELECT 1 FROM listing_media linked WHERE linked.asset_id = candidate.id
        ) THEN 0 ELSE 1 END,
        candidate.updated_at DESC,
        candidate.id ASC
      LIMIT 1
    `).get(
      assetId,
      completed.contentSha256,
      completed.sourceMimeType,
      completed.originalSizeBytes,
      completed.thumbnailSizeBytes,
      completed.gallerySizeBytes,
      completed.width,
      completed.height,
    ) as StoredMediaAssetRow | undefined;
    if (shared) {
      const canonicalShared = isolateCompletedMediaStorage(
        completed,
        readString(shared, "storage_generation"),
      );
      if (
        shared.original_object_key === canonicalShared.originalObjectKey
        && shared.thumbnail_object_key === canonicalShared.thumbnailObjectKey
        && shared.gallery_object_key === canonicalShared.galleryObjectKey
      ) {
        return {
          completed: canonicalShared,
          storageGeneration: readString(shared, "storage_generation"),
        };
      }
    }
    const storageGeneration = readString(asset, "storage_generation");
    return {
      completed: isolateCompletedMediaStorage(completed, storageGeneration),
      storageGeneration,
    };
  }

  private assertMediaObjectKeysAreNotBeingDeleted(assetId: string, objectKeys: readonly string[]): void {
    const deletingAssets = this.database.prepare(`
      SELECT asset.*
      FROM media_assets asset
      JOIN media_gc_tombstones tombstone ON tombstone.asset_id = asset.id
      WHERE tombstone.status = 'deleting' AND asset.id <> ?
    `).all(assetId) as StoredMediaAssetRow[];
    const deletingKeys = new Set(deletingAssets.flatMap(mediaObjectKeys));
    if (!objectKeys.some((key) => deletingKeys.has(key))) return;
    throw new ApiError(
      409,
      "MEDIA_OBJECT_GC_IN_PROGRESS",
      "A content-addressed media object is currently being deleted; retry processing shortly.",
      { retryable: true },
    );
  }

  private queueOrphanMediaAssets(): void {
    const now = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO media_gc_tombstones (
        asset_id, status, attempts, next_attempt_at, created_at, updated_at
      )
      SELECT asset.id, 'pending', 0, ?, ?, ?
      FROM media_assets asset
      WHERE NOT EXISTS (SELECT 1 FROM listing_media lm WHERE lm.asset_id = asset.id)
      ON CONFLICT(asset_id) DO NOTHING
    `).run(now, now, now);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      this.database.prepare("SELECT version FROM schema_migrations").all().map((row) => readNumber(row, "version")),
    );

    for (const migration of DATABASE_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.database.exec(migration.sql);
        this.database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, this.now().toISOString());
      });
    }
  }

  private reconcileAbandonedEvaluationAttempts(): void {
    const now = this.now();
    const cutoff = new Date(now.getTime() - ABANDONED_EVALUATION_ATTEMPT_AFTER_MS).toISOString();
    this.database.prepare(`
      UPDATE evaluation_attempts
      SET status = 'failed', completed_at = ?, error_code = 'ATTEMPT_ABANDONED',
        error_stage = 'internal', retryable = 1
      WHERE status = 'running' AND started_at < ?
    `).run(now.toISOString(), cutoff);
  }

  private seedDefaultEvaluationPlan(): void {
    const existing = readNumber(
      this.database.prepare("SELECT COUNT(*) AS total FROM evaluation_plan_versions").get(),
      "total",
    );
    if (existing > 0) return;
    const activeRecipe = this.getActiveRecipe();
    if (!activeRecipe) return;
    const plan = this.saveEvaluationPlan("default-evaluation", {
      name: activeRecipe.name,
      operator: "all",
      recipes: [{ recipeId: activeRecipe.id, recipeVersion: activeRecipe.version }],
    });
    this.setDefaultEvaluationPlan(plan.id, plan.version);
  }

  private collectedDataCounts(): CollectedDataCounts {
    const count = (table: "listings" | "runs" | "run_listings" | "evaluations") =>
      readNumber(this.database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(), "total");
    return {
      listings: count("listings"),
      runs: count("runs"),
      runListings: count("run_listings"),
      evaluations: count("evaluations"),
    };
  }

  private upsertRun(incoming: RunIngestion): void {
    const existingRow = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(incoming.id) as StoredRunRow | undefined;
    const existing = existingRow ? parseRunData(existingRow.data_json) : undefined;
    const merged = existing ? mergeRun(existing, incoming) : runIngestionSchema.parse(incoming);
    const changed = !existing || JSON.stringify(existing) !== JSON.stringify(merged);
    const updatedAt = changed ? this.now().toISOString() : (existingRow?.updated_at ?? this.now().toISOString());
    this.database.prepare(`
      INSERT INTO runs (id, source, status, started_at, finished_at, updated_at, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        status = excluded.status,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at,
        data_json = excluded.data_json
    `).run(
      merged.id,
      merged.source,
      merged.status,
      merged.startedAt ?? null,
      merged.finishedAt ?? null,
      updatedAt,
      JSON.stringify(merged),
    );
  }

  private upsertRunListingSnapshot(runId: string, incomingValue: ListingIngestion): void {
    const incoming = normalizeListing(incomingValue);
    const existingRow = this.database.prepare(`
      SELECT * FROM run_listings WHERE run_id = ? AND source = ? AND external_id = ?
    `).get(runId, incoming.source, incoming.externalId) as StoredRunListingRow | undefined;

    const existing = existingRow ? parseListingData(existingRow.observation_json) : undefined;
    const snapshot = existing
      ? incoming.scrapedAt < existing.scrapedAt
        ? mergeOrderedListings(incoming, existing)
        : mergeOrderedListings(existing, incoming)
      : incoming;
    const firstObservedAt = minIso(existingRow?.first_observed_at, incoming.scrapedAt) ?? incoming.scrapedAt;
    const observedAt = maxIso(existingRow?.observed_at, incoming.scrapedAt) ?? incoming.scrapedAt;
    this.database.prepare(`
      INSERT INTO run_listings (
        run_id, source, external_id, first_observed_at, observed_at, status, scraped_at, observation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, source, external_id) DO UPDATE SET
        first_observed_at = excluded.first_observed_at,
        observed_at = excluded.observed_at,
        status = excluded.status,
        scraped_at = excluded.scraped_at,
        observation_json = excluded.observation_json
    `).run(
      runId,
      snapshot.source,
      snapshot.externalId,
      firstObservedAt,
      observedAt,
      snapshot.status,
      snapshot.scrapedAt,
      JSON.stringify(snapshot),
    );
  }

  private rebuildCanonicalListing(identity: ListingIdentity): "inserted" | "updated" | "unchanged" {
    const snapshots = this.database.prepare(`
      SELECT * FROM run_listings
      WHERE source = ? AND external_id = ?
      ORDER BY scraped_at ASC, run_id ASC
    `).all(identity.source, identity.externalId) as StoredRunListingRow[];
    const firstSnapshot = snapshots[0];
    const lastSnapshot = snapshots.at(-1);
    if (!firstSnapshot || !lastSnapshot) throw new Error("Cannot build a listing without a run observation.");

    const canonical = snapshots.slice(1).reduce(
      (merged, snapshot) => mergeOrderedListings(merged, parseListingData(snapshot.observation_json)),
      parseListingData(firstSnapshot.observation_json),
    );
    const firstSeenAt = snapshots.reduce(
      (minimum, snapshot) => minIso(minimum, snapshot.first_observed_at) ?? minimum,
      firstSnapshot.first_observed_at,
    );
    const lastSeenAt = lastSnapshot.scraped_at;
    const existingRow = this.findListingRow(identity);
    const existing = existingRow ? parseListingData(existingRow.data_json) : undefined;
    const changed = !existingRow ||
      JSON.stringify(existing) !== JSON.stringify(canonical) ||
      existingRow.first_seen_at !== firstSeenAt ||
      existingRow.last_seen_at !== lastSeenAt ||
      existingRow.last_run_id !== lastSnapshot.run_id;
    const updatedAt = changed ? this.now().toISOString() : (existingRow?.updated_at ?? this.now().toISOString());

    this.database.prepare(`
      INSERT INTO listings (
        source, external_id, url, status, scraped_at, first_seen_at, last_seen_at, updated_at,
        last_run_id, price_euros, surface_m2, property_type, energy_class, data_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET
        url = excluded.url,
        status = excluded.status,
        scraped_at = excluded.scraped_at,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at,
        last_run_id = excluded.last_run_id,
        price_euros = excluded.price_euros,
        surface_m2 = excluded.surface_m2,
        property_type = excluded.property_type,
        energy_class = excluded.energy_class,
        data_json = excluded.data_json
    `).run(
      canonical.source,
      canonical.externalId,
      canonical.url,
      canonical.status,
      canonical.scrapedAt,
      firstSeenAt,
      lastSeenAt,
      updatedAt,
      lastSnapshot.run_id,
      canonical.priceEuros ?? null,
      canonical.surfaceM2 ?? null,
      canonical.propertyType ?? null,
      canonical.energyClass ?? null,
      JSON.stringify(canonical),
    );

    if (!existingRow) return "inserted";
    return changed ? "updated" : "unchanged";
  }

  private findListingRow(identity: ListingIdentity): StoredListingRow | undefined {
    return this.database.prepare(`
      SELECT * FROM listings WHERE source = ? AND external_id = ?
    `).get(identity.source, identity.externalId) as StoredListingRow | undefined;
  }

  private findEvaluationExecutionRow(id: string): StoredEvaluationExecutionRow | undefined {
    return this.database.prepare(`
      SELECT * FROM evaluation_executions WHERE id = ?
    `).get(id) as StoredEvaluationExecutionRow | undefined;
  }

  private getEvaluationExecutionBudget(id: string): EvaluationExecutionBudget {
    const row = this.database.prepare(`
      SELECT limit_json, estimate_json, consumed_json
      FROM evaluation_execution_budgets WHERE execution_id = ?
    `).get(id) as StoredEvaluationExecutionBudgetRow | undefined;
    if (!row) throw new Error("The evaluation execution budget is missing.");
    return evaluationExecutionBudgetSchema.parse({
      limit: JSON.parse(row.limit_json) as unknown,
      estimate: JSON.parse(row.estimate_json) as unknown,
      consumed: JSON.parse(row.consumed_json) as unknown,
    });
  }

  private assertEvaluationExecutionLease(id: string, leaseOwner: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS owned FROM evaluation_executions
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).get(id, leaseOwner);
    if (!row) throw new Error("The evaluation execution lease is no longer owned by this worker.");
  }

  private rowToEvaluationExecution(row: StoredEvaluationExecutionRow): EvaluationExecutionRecord {
    const request = JSON.parse(row.request_json) as EvaluationExecutionCreateRequest & { listingIds: string[] };
    return evaluationExecutionRecordSchema.parse({
      id: row.id,
      runId: row.run_id,
      planId: row.plan_id,
      planVersion: row.plan_version,
      locale: row.locale,
      status: row.status,
      listingIds: request.listingIds,
      force: row.force === 1,
      ...(row.retry_of_execution_id ? { retryOfExecutionId: row.retry_of_execution_id } : {}),
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      counters: JSON.parse(row.counters_json) as unknown,
      budget: this.getEvaluationExecutionBudget(row.id),
      ...(row.error ? { error: row.error } : {}),
    });
  }

  private refreshEvaluationExecutionCounters(id: string): void {
    const rows = this.database.prepare(`
      SELECT result_json
      FROM evaluation_execution_items
      WHERE execution_id = ? AND result_json IS NOT NULL
    `).all(id);
    const results = rows.map((row) => evaluationExecutionListingResultSchema.parse(
      JSON.parse(readString(row, "result_json")) as unknown,
    ));
    const counters = {
      total: readNumber(this.database.prepare(`
        SELECT COUNT(*) AS total FROM evaluation_execution_items WHERE execution_id = ?
      `).get(id), "total"),
      processed: results.length,
      relevant: results.filter((result) => result.decision === "relevant").length,
      notRelevant: results.filter((result) => result.decision === "not-relevant").length,
      review: results.filter((result) => result.decision === "review").length,
      failed: results.filter((result) => result.steps.some((step) => step.status === "failed")).length,
    };
    this.database.prepare(`
      UPDATE evaluation_executions SET counters_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(counters), this.now().toISOString(), id);
  }

  private rowsToListings(rows: readonly StoredListingRow[]): ListingRecord[] {
    if (!rows.length) return [];
    const listings = rows.map((row) => {
      const data = parseListingData(row.data_json);
      return { row, data, mediaSourceUrls: listingMediaSourceUrls(data) };
    });
    // Resolve only this bounded page. Indexed LIMIT 1 lookups avoid loading evaluation history.
    const evaluationRows = this.database.prepare(`
      WITH requested(source, external_id) AS (VALUES ${rows.map(() => "(?, ?)").join(", ")})
      SELECT latest.* FROM requested
      JOIN evaluations latest ON latest.rowid = (
        SELECT e.rowid FROM evaluations e
        WHERE e.source = requested.source AND e.external_id = requested.external_id
        ORDER BY ${LATEST_EVALUATION_ORDER}
        LIMIT 1
      )
    `).all(...listings.flatMap(({ data }) => [data.source, data.externalId])) as StoredEvaluationRow[];
    const evaluationsByListingId = new Map(evaluationRows.map((row) => {
      const evaluation = rowToEvaluation(row);
      return [evaluation.listingId, evaluation];
    }));
    const mediaBySourceUrl = this.mediaAssetsBySourceUrl(uniqueStrings(
      listings.flatMap(({ mediaSourceUrls }) => mediaSourceUrls),
    ));
    return listings.map(({ row, data, mediaSourceUrls }) => this.rowToListing(row, {
      data,
      latestEvaluation: evaluationsByListingId.get(createListingKey(data)),
      imageAssets: mediaSourceUrls.flatMap((sourceUrl) => {
        const asset = mediaBySourceUrl.get(sourceUrl);
        return asset ? [asset] : [];
      }),
    }));
  }

  private rowToListing(row: StoredListingRow, related?: {
    readonly data: ListingIngestion;
    readonly latestEvaluation: ListingEvaluationRecord | undefined;
    readonly imageAssets: ListingImageAsset[];
  }): ListingRecord {
    const data = related?.data ?? parseListingData(row.data_json);
    const latestEvaluation = related ? related.latestEvaluation : this.latestEvaluation(data);
    return listingRecordSchema.parse({
      ...data,
      id: createListingKey(data),
      lastRunId: row.last_run_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
      imageAssets: related ? related.imageAssets : this.listListingMedia(data),
      ...(latestEvaluation ? { latestEvaluation } : {}),
    });
  }

  private rowToRunSnapshot(row: StoredRunListingRow, includeRelated = true): ListingRecord {
    const data = parseListingData(row.observation_json);
    const latestEvaluation = includeRelated ? this.latestEvaluation(data, row.run_id) : undefined;
    return listingRecordSchema.parse({
      ...data,
      id: createListingKey(data),
      lastRunId: row.run_id,
      firstSeenAt: row.first_observed_at,
      lastSeenAt: row.observed_at,
      updatedAt: row.observed_at,
      ...(includeRelated ? { imageAssets: this.listListingMedia(data) } : {}),
      ...(latestEvaluation ? { latestEvaluation } : {}),
    });
  }

  private rowToEvaluationPlan(row: StoredEvaluationPlanRow): EvaluationPlanVersion {
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const recipeRows = this.database.prepare(`
      SELECT recipe_id, recipe_version
      FROM evaluation_plan_recipes
      WHERE plan_id = ? AND plan_version = ?
      ORDER BY recipe_index ASC
    `).all(row.id, row.version) as StoredEvaluationPlanRecipeRow[];
    return evaluationPlanVersionSchema.parse({
      ...data,
      id: row.id,
      version: row.version,
      recipes: recipeRows.map((recipe) => ({
        recipeId: recipe.recipe_id,
        recipeVersion: recipe.recipe_version,
      })),
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
    });
  }

  private latestEvaluation(identity: ListingIdentity, runId?: string): ListingEvaluationRecord | undefined {
    const runClause = runId ? "AND run_id = ?" : "";
    const parameters = runId
      ? [identity.source, identity.externalId, runId]
      : [identity.source, identity.externalId];
    const row = this.database.prepare(`
      SELECT * FROM evaluations e
      WHERE source = ? AND external_id = ?
      ${runClause}
      ORDER BY ${LATEST_EVALUATION_ORDER}
      LIMIT 1
    `).get(...parameters) as StoredEvaluationRow | undefined;
    return row ? rowToEvaluation(row) : undefined;
  }

  private listEvaluations(identity: ListingIdentity): ListingEvaluationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM evaluations e
      WHERE source = ? AND external_id = ?
      ORDER BY ${LATEST_EVALUATION_ORDER}
    `).all(identity.source, identity.externalId) as StoredEvaluationRow[];
    return rows.map(rowToEvaluation);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function canonicalizeMediaSourceUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  url.hash = "";
  return url.toString();
}

function listingMediaSourceUrls(listing: ListingIngestion): string[] {
  return uniqueStrings(
    (normalizeListing(listing).imageUrls ?? []).map(canonicalizeMediaSourceUrl),
  );
}

function mediaAssetId(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

function toListingImageAsset(row: StoredMediaAssetRow): ListingImageAsset {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    status: row.status,
    ...(row.status === "ready" && row.thumbnail_object_key
      ? { thumbnailPath: `/v1/media/${row.id}/thumbnail.webp` }
      : {}),
    ...(row.status === "ready" && row.gallery_object_key
      ? { galleryPath: `/v1/media/${row.id}/gallery.webp` }
      : {}),
  };
}

function mapMediaAsset(row: StoredMediaAssetRow): MediaAssetRecord {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    status: row.status,
    ...(row.original_object_key ? { originalObjectKey: row.original_object_key } : {}),
    ...(row.thumbnail_object_key ? { thumbnailObjectKey: row.thumbnail_object_key } : {}),
    ...(row.gallery_object_key ? { galleryObjectKey: row.gallery_object_key } : {}),
    ...(row.thumbnail_size_bytes !== null ? { thumbnailSizeBytes: row.thumbnail_size_bytes } : {}),
    ...(row.gallery_size_bytes !== null ? { gallerySizeBytes: row.gallery_size_bytes } : {}),
  };
}

function parseMediaObjectKeys(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
    throw new Error("Stored media object keys are invalid.");
  }
  return parsed;
}

function mediaObjectKeys(row: {
  readonly original_object_key: string | null;
  readonly thumbnail_object_key: string | null;
  readonly gallery_object_key: string | null;
  readonly object_keys_json: string;
}): string[] {
  return uniqueStrings([
    row.original_object_key,
    row.thumbnail_object_key,
    row.gallery_object_key,
    ...parseMediaObjectKeys(row.object_keys_json),
  ].filter((key): key is string => Boolean(key)));
}

function storedMediaAssetBytes(row: StoredMediaAssetRow, fallbackReservation: number): number {
  if (
    row.original_size_bytes === null
    || row.thumbnail_size_bytes === null
    || row.gallery_size_bytes === null
  ) {
    return fallbackReservation;
  }
  return row.original_size_bytes + row.thumbnail_size_bytes + row.gallery_size_bytes;
}

function completedMediaSize(completed: CompletedMediaAsset): number {
  const sizes = [
    completed.originalSizeBytes,
    completed.thumbnailSizeBytes,
    completed.gallerySizeBytes,
  ];
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
    throw new Error("Completed media sizes must be safe non-negative integers.");
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Completed media size exceeds the safe integer range.");
  return total;
}

function completedMediaMatchesStored(row: StoredMediaAssetRow, completed: CompletedMediaAsset): boolean {
  return row.content_sha256 === completed.contentSha256
    && row.source_mime_type === completed.sourceMimeType
    && row.original_object_key === completed.originalObjectKey
    && row.thumbnail_object_key === completed.thumbnailObjectKey
    && row.gallery_object_key === completed.galleryObjectKey
    && row.original_size_bytes === completed.originalSizeBytes
    && row.thumbnail_size_bytes === completed.thumbnailSizeBytes
    && row.gallery_size_bytes === completed.gallerySizeBytes
    && row.width === completed.width
    && row.height === completed.height;
}

function isolateCompletedMediaStorage(
  completed: CompletedMediaAsset,
  storageGeneration: string,
): CompletedMediaAsset {
  if (!/^[a-f0-9-]{32,36}$/u.test(storageGeneration)) {
    throw new Error("The media storage generation is invalid.");
  }
  const originalExtension = (() => {
    switch (completed.sourceMimeType) {
      case "image/jpeg": return "jpg";
      case "image/png": return "png";
      case "image/webp": return "webp";
      case "image/avif": return "avif";
      default: throw new Error("The completed media MIME type is unsupported.");
    }
  })();
  const prefix = `media/${completed.contentSha256.slice(0, 2)}/${completed.contentSha256}/generation-${storageGeneration}`;
  return {
    ...completed,
    originalObjectKey: `${prefix}/original.${originalExtension}`,
    thumbnailObjectKey: `${prefix}/thumbnail.webp`,
    galleryObjectKey: `${prefix}/gallery.webp`,
  };
}

function normalizeListing(listing: ListingIngestion): ListingIngestion {
  const imageUrls = uniqueStrings([
    ...(listing.imageUrl ? [listing.imageUrl] : []),
    ...(listing.imageUrls ?? []),
  ]).slice(0, MAX_LISTING_IMAGE_URLS);
  return listingIngestionSchema.parse({
    ...listing,
    ...(imageUrls.length ? { imageUrl: imageUrls[0], imageUrls } : {}),
    ...(listing.features
      ? { features: uniqueStrings(listing.features).slice(0, MAX_LISTING_FEATURES) }
      : {}),
  });
}

function mergeOrderedListings(olderValue: ListingIngestion, newerValue: ListingIngestion): ListingIngestion {
  const older = normalizeListing(olderValue);
  const newer = normalizeListing(newerValue);
  const rank = { failed: 0, listing: 1, detailed: 2 } as const;
  const raw: Record<string, unknown> = { ...older, ...newer };
  const imageUrls = uniqueStrings([...(newer.imageUrls ?? []), ...(older.imageUrls ?? [])])
    .slice(0, MAX_LISTING_IMAGE_URLS);
  const features = uniqueStrings([...(older.features ?? []), ...(newer.features ?? [])])
    .slice(0, MAX_LISTING_FEATURES);

  raw.status = rank[newer.status] > rank[older.status] ? newer.status : older.status;
  raw.scrapedAt = maxIso(older.scrapedAt, newer.scrapedAt);
  raw.description = longerText(older.description, newer.description);
  raw.rawTextSample = longerText(older.rawTextSample, newer.rawTextSample);
  const coordinates = selectPreferredCoordinates(older.coordinates, newer.coordinates);
  if (coordinates) raw.coordinates = coordinates;
  else delete raw.coordinates;
  if (features.length) raw.features = features;
  if (imageUrls.length) {
    raw.imageUrl = newer.imageUrl ?? older.imageUrl ?? imageUrls[0];
    raw.imageUrls = imageUrls;
  }
  return listingIngestionSchema.parse(raw);
}

const COORDINATE_LOCATION_KIND_RANK: Readonly<Record<VerifiedCoordinates["locationKind"], number>> = {
  "source-property": 3,
  "source-locality": 2,
  "locality-centroid": 1,
  "postal-code-centroid": 1,
};

function selectPreferredCoordinates(
  first: VerifiedCoordinates | undefined,
  second: VerifiedCoordinates | undefined,
): VerifiedCoordinates | undefined {
  if (!first) return second;
  if (!second) return first;

  const rankDifference = COORDINATE_LOCATION_KIND_RANK[first.locationKind] -
    COORDINATE_LOCATION_KIND_RANK[second.locationKind];
  if (rankDifference !== 0) return rankDifference > 0 ? first : second;

  if (
    first.locationKind === second.locationKind &&
    first.latitude === second.latitude &&
    first.longitude === second.longitude &&
    first.provenance === second.provenance
  ) return first;

  const verifiedAtDifference = Date.parse(first.verifiedAt) - Date.parse(second.verifiedAt);
  if (verifiedAtDifference !== 0) return verifiedAtDifference > 0 ? first : second;

  return JSON.stringify(first).localeCompare(JSON.stringify(second)) >= 0 ? first : second;
}

function mergeRun(existing: RunIngestion, incoming: RunIngestion): RunIngestion {
  const terminal = new Set(["blocked-captcha", "blocked-activity", "completed", "cancelled", "failed", "legacy-import"]);
  const raw: Record<string, unknown> = { ...existing, ...incoming };
  raw.startedAt = minIso(existing.startedAt, incoming.startedAt);
  raw.finishedAt = maxIso(existing.finishedAt, incoming.finishedAt);
  for (const field of ["target", "found", "pagesVisited", "collected", "evaluated", "relevant", "notRelevant", "review"] as const) {
    if (existing[field] !== undefined || incoming[field] !== undefined) {
      raw[field] = Math.max(existing[field] ?? 0, incoming[field] ?? 0);
    }
  }
  if (terminal.has(existing.status) && !terminal.has(incoming.status)) raw.status = existing.status;
  return runIngestionSchema.parse(raw);
}

function parseListingData(value: string): ListingIngestion {
  return listingIngestionSchema.parse(JSON.parse(value));
}

function parseRunData(value: string): RunIngestion {
  return runIngestionSchema.parse(JSON.parse(value));
}

function rowToRun(row: StoredRunRow): RunRecord {
  return runRecordSchema.parse({ ...parseRunData(row.data_json), updatedAt: row.updated_at });
}

function rowToRecipe(row: StoredRecipeRow): RecipeVersion {
  const data = JSON.parse(row.data_json) as unknown;
  return recipeVersionSchema.parse({
    ...(typeof data === "object" && data !== null ? data : {}),
    active: row.active === 1,
    createdAt: row.created_at,
  });
}

function rowToEvaluation(row: StoredEvaluationRow): ListingEvaluationRecord {
  const result = JSON.parse(row.result_json) as unknown;
  return listingEvaluationRecordSchema.parse({
    ...(typeof result === "object" && result !== null ? result : {}),
    runId: row.run_id,
    source: row.source,
    externalId: row.external_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    locale: row.locale,
    evaluator: evaluatorSchema.parse(JSON.parse(row.evaluator_json)),
  });
}

function rowToStoredExecutionStep(row: StoredEvaluationExecutionStepRow): StoredExecutionStep {
  const base = { recipeId: row.recipe_id, recipeVersion: row.recipe_version };
  if (row.status === "succeeded" || row.status === "cached") {
    if (!row.evaluation_json) throw new Error("A successful execution step is missing its evaluation.");
    const stored = JSON.parse(row.evaluation_json) as {
      evaluation?: ListingEvaluationResult;
      evaluator?: Evaluator;
    };
    if (!stored.evaluation || !stored.evaluator) {
      throw new Error("A successful execution step is missing immutable evaluator provenance.");
    }
    return {
      ...base,
      status: row.status,
      evaluation: stored.evaluation,
      evaluator: stored.evaluator,
    };
  }
  if (row.status === "failed") {
    if (!row.error_json) throw new Error("A failed execution step is missing its error.");
    return {
      ...base,
      status: "failed",
      error: JSON.parse(row.error_json) as EvaluationItemError,
    };
  }
  if (row.status === "running") return { ...base, status: "running" };
  if (row.status === "skipped") return { ...base, status: "skipped" };
  return { ...base, status: "pending" };
}

function listingWhere(query: ListingsQuery): { where: string; parameters: SQLInputValue[] } {
  const clauses: string[] = [];
  const parameters: SQLInputValue[] = [];
  const add = (clause: string, value: SQLInputValue) => {
    clauses.push(clause);
    parameters.push(value);
  };
  if (query.source) add("l.source = ?", query.source);
  if (query.runId) {
    add(`EXISTS (
      SELECT 1 FROM run_listings rl
      WHERE rl.source = l.source AND rl.external_id = l.external_id AND rl.run_id = ?
    )`, query.runId);
  }
  if (query.status) add("l.status = ?", query.status);
  if (query.decision) {
    add(`(
      SELECT e.decision FROM evaluations e
      WHERE e.source = l.source AND e.external_id = l.external_id
      ORDER BY ${LATEST_EVALUATION_ORDER} LIMIT 1
    ) = ?`, query.decision);
  }
  if (query.propertyType) add("l.property_type = ?", query.propertyType);
  if (query.priceMin !== undefined) add("l.price_euros >= ?", query.priceMin);
  if (query.priceMax !== undefined) add("l.price_euros <= ?", query.priceMax);
  if (query.surfaceMin !== undefined) add("l.surface_m2 >= ?", query.surfaceMin);
  if (query.surfaceMax !== undefined) add("l.surface_m2 <= ?", query.surfaceMax);
  if (query.energyClass) add("l.energy_class = ?", query.energyClass);
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("offset" in decoded) ||
      typeof decoded.offset !== "number" ||
      !Number.isSafeInteger(decoded.offset) ||
      decoded.offset < 0
    ) {
      throw new Error("invalid cursor");
    }
    return decoded.offset;
  } catch (error) {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid.", { cause: error });
  }
}

interface RunListingsCursor {
  readonly observedAt: string;
  readonly source: string;
  readonly externalId: string;
}

function encodeRunListingsCursor(row: StoredRunListingRow): string {
  return Buffer.from(JSON.stringify({
    observedAt: row.observed_at,
    source: row.source,
    externalId: row.external_id,
  }), "utf8").toString("base64url");
}

function decodeRunListingsCursor(cursor: string | undefined): RunListingsCursor | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof decoded !== "object"
      || decoded === null
      || !("observedAt" in decoded)
      || typeof decoded.observedAt !== "string"
      || Number.isNaN(Date.parse(decoded.observedAt))
      || !("source" in decoded)
      || typeof decoded.source !== "string"
      || decoded.source.length === 0
      || !("externalId" in decoded)
      || typeof decoded.externalId !== "string"
      || decoded.externalId.length === 0
    ) {
      throw new Error("invalid run listings cursor");
    }
    return {
      observedAt: decoded.observedAt,
      source: decoded.source,
      externalId: decoded.externalId,
    };
  } catch (error) {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid.", { cause: error });
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function longerText(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return second.length > first.length ? second : first;
}

function maxIso(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return first >= second ? first : second;
}

function minIso(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return first <= second ? first : second;
}

function readString(row: Record<string, unknown> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string.`);
  return value;
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number") throw new Error(`Expected ${key} to be a number.`);
  return value;
}

function parseResourceUsage(value: string): EvaluationExecutionResourceUsage {
  return evaluationExecutionResourceUsageSchema.parse(JSON.parse(value) as unknown);
}

function assertMediaAdmissionPolicy(policy: MediaAdmissionPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Media admission policy ${name} must be a safe positive integer.`);
    }
  }
  if (policy.reservedBytesPerAsset > policy.maxReservedBytes) {
    throw new Error("Media admission reservation cannot exceed the total storage budget.");
  }
}

function openPrivateDatabase(requestedPath: string): PrivateDatabaseHandle {
  const absolutePath = resolve(requestedPath);
  const requestedDirectoryPath = dirname(absolutePath);
  assertNoUnsafeDirectorySymlinkComponents(requestedDirectoryPath);
  const existingDirectory = tryLstat(requestedDirectoryPath);
  if (existingDirectory?.isSymbolicLink()) {
    throw unsafeFilesystemPath("database directory", requestedDirectoryPath, "is a symbolic link");
  }
  if (existingDirectory && !existingDirectory.isDirectory()) {
    throw unsafeFilesystemPath("database directory", requestedDirectoryPath, "is not a directory");
  }

  mkdirSync(requestedDirectoryPath, {
    recursive: true,
    mode: PRIVATE_DATABASE_DIRECTORY_MODE,
  });

  assertNoUnsafeDirectorySymlinkComponents(requestedDirectoryPath);
  const createdDirectory = lstatSync(requestedDirectoryPath);
  if (createdDirectory.isSymbolicLink()) {
    throw unsafeFilesystemPath("database directory", requestedDirectoryPath, "is a symbolic link");
  }
  if (!createdDirectory.isDirectory()) {
    throw unsafeFilesystemPath("database directory", requestedDirectoryPath, "is not a directory");
  }
  assertPrivateDatabaseDirectory(createdDirectory, requestedDirectoryPath);

  // Resolve inherited system-level aliases (for example macOS /var -> /private/var)
  // once, then keep descriptors for the canonical directory and database inode.
  // Every permission change below uses a descriptor opened with O_NOFOLLOW.
  const directoryPath = realpathSync.native(requestedDirectoryPath);
  const databasePath = join(directoryPath, basename(absolutePath));
  const directoryDescriptor = openSync(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let databaseDescriptor: number | undefined;
  let database: DatabaseSync | undefined;

  try {
    const directoryIdentity = fstatSync(directoryDescriptor);
    assertSameIdentity(
      createdDirectory,
      directoryIdentity,
      requestedDirectoryPath,
      "database directory",
    );
    assertDirectoryIdentity(directoryPath, directoryIdentity);

    hardenPrivateSqliteSidecars(databasePath);
    assertSafeFilePath(databasePath, "database");

    databaseDescriptor = openSync(
      databasePath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      PRIVATE_DATABASE_FILE_MODE,
    );
    const databaseIdentity = fstatSync(databaseDescriptor);
    assertRegularSingleLinkFile(databaseIdentity, databasePath, "database");
    assertFileIdentity(databasePath, databaseIdentity, "database");
    fchmodSync(databaseDescriptor, PRIVATE_DATABASE_FILE_MODE);
    assertFileIdentity(databasePath, databaseIdentity, "database");

    database = new DatabaseSync(databasePath, { timeout: 5_000 });
    assertDirectoryIdentity(directoryPath, directoryIdentity);
    assertFileIdentity(databasePath, databaseIdentity, "database");

    return {
      database,
      databasePath,
      directoryPath,
      databaseDescriptor,
      directoryDescriptor,
    };
  } catch (error) {
    database?.close();
    if (databaseDescriptor !== undefined) closeSync(databaseDescriptor);
    closeSync(directoryDescriptor);
    throw error;
  }
}

function hardenPrivateDatabaseFiles(handle: PrivateDatabaseHandle): void {
  const directoryIdentity = fstatSync(handle.directoryDescriptor);
  assertDirectoryIdentity(handle.directoryPath, directoryIdentity);

  const databaseIdentity = fstatSync(handle.databaseDescriptor);
  assertRegularSingleLinkFile(databaseIdentity, handle.databasePath, "database");
  assertFileIdentity(handle.databasePath, databaseIdentity, "database");
  fchmodSync(handle.databaseDescriptor, PRIVATE_DATABASE_FILE_MODE);
  assertFileIdentity(handle.databasePath, databaseIdentity, "database");

  hardenPrivateSqliteSidecars(handle.databasePath);
}

function releasePrivateDatabaseHandle(handle: PrivateDatabaseHandle): void {
  closeSync(handle.databaseDescriptor);
  closeSync(handle.directoryDescriptor);
}

function hardenPrivateFileIfPresent(path: string, label: string): void {
  const initialIdentity = tryLstat(path);
  if (!initialIdentity) return;
  assertRegularSingleLinkFile(initialIdentity, path, label);

  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const descriptorIdentity = fstatSync(descriptor);
    assertRegularSingleLinkFile(descriptorIdentity, path, label);
    assertSameIdentity(initialIdentity, descriptorIdentity, path, label);
    assertFileIdentity(path, descriptorIdentity, label);
    fchmodSync(descriptor, PRIVATE_DATABASE_FILE_MODE);
    assertFileIdentity(path, descriptorIdentity, label);
  } finally {
    closeSync(descriptor);
  }
}

function hardenPrivateSqliteSidecars(databasePath: string): void {
  hardenPrivateFileIfPresent(`${databasePath}-journal`, "SQLite rollback-journal sidecar");
  hardenPrivateFileIfPresent(`${databasePath}-wal`, "SQLite WAL sidecar");
  hardenPrivateFileIfPresent(`${databasePath}-shm`, "SQLite shared-memory sidecar");
}

function assertSafeFilePath(path: string, label: string): void {
  const identity = tryLstat(path);
  if (identity) assertRegularSingleLinkFile(identity, path, label);
}

function assertNoUnsafeDirectorySymlinkComponents(path: string): void {
  const root = parse(path).root;
  let currentPath = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    currentPath = join(currentPath, component);
    const identity = tryLstat(currentPath);
    if (!identity) continue;
    if (identity.isSymbolicLink()) {
      // macOS exposes stable root-owned aliases such as /var -> /private/var.
      // Resolve those once below, but reject every user-controlled nested alias.
      const trustedRootAlias = dirname(currentPath) === root && identity.uid === 0;
      if (!trustedRootAlias) {
        throw unsafeFilesystemPath("database directory component", currentPath, "is a symbolic link");
      }
      continue;
    }
    if (!identity.isDirectory()) {
      throw unsafeFilesystemPath("database directory component", currentPath, "is not a directory");
    }
    if (currentPath !== path && isReplaceableDirectory(identity)) {
      throw unsafeFilesystemPath(
        "database directory ancestor",
        currentPath,
        "is group/world writable without the sticky bit",
      );
    }
  }
}

function isReplaceableDirectory(identity: Stats): boolean {
  const GROUP_OR_WORLD_WRITABLE = 0o022;
  const STICKY_BIT = 0o1000;
  return (identity.mode & GROUP_OR_WORLD_WRITABLE) !== 0 && (identity.mode & STICKY_BIT) === 0;
}

function assertDirectoryIdentity(path: string, descriptorIdentity: Stats): void {
  if (!descriptorIdentity.isDirectory()) {
    throw unsafeFilesystemPath("database directory", path, "is not a directory");
  }
  assertPrivateDatabaseDirectory(descriptorIdentity, path);
  const pathIdentity = lstatSync(path);
  if (pathIdentity.isSymbolicLink()) {
    throw unsafeFilesystemPath("database directory", path, "is a symbolic link");
  }
  if (!pathIdentity.isDirectory()) {
    throw unsafeFilesystemPath("database directory", path, "is not a directory");
  }
  assertPrivateDatabaseDirectory(pathIdentity, path);
  assertSameIdentity(pathIdentity, descriptorIdentity, path, "database directory");
}

function assertPrivateDatabaseDirectory(identity: Stats, path: string): void {
  if ((identity.mode & 0o777) !== PRIVATE_DATABASE_DIRECTORY_MODE) {
    throw unsafeFilesystemPath(
      "database directory",
      path,
      "is not a private owner-only directory (expected mode 0700)",
    );
  }
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId !== undefined && identity.uid !== effectiveUserId) {
    throw unsafeFilesystemPath(
      "database directory",
      path,
      "is not owned by the effective runtime user",
    );
  }
}

function assertFileIdentity(path: string, descriptorIdentity: Stats, label: string): void {
  const pathIdentity = lstatSync(path);
  assertRegularSingleLinkFile(pathIdentity, path, label);
  assertSameIdentity(pathIdentity, descriptorIdentity, path, label);
}

function assertRegularSingleLinkFile(identity: Stats, path: string, label: string): void {
  if (identity.isSymbolicLink()) {
    throw unsafeFilesystemPath(label, path, "is a symbolic link");
  }
  if (!identity.isFile()) {
    throw unsafeFilesystemPath(label, path, "is not a regular file");
  }
  if (identity.nlink !== 1) {
    throw unsafeFilesystemPath(label, path, "has multiple hard links");
  }
}

function assertSameIdentity(first: Stats, second: Stats, path: string, label: string): void {
  if (first.dev !== second.dev || first.ino !== second.ino) {
    throw unsafeFilesystemPath(label, path, "changed while it was being opened");
  }
}

function tryLstat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function unsafeFilesystemPath(label: string, path: string, reason: string): Error {
  return new Error(`Unsafe ${label} path ${JSON.stringify(path)}: ${reason}.`);
}
