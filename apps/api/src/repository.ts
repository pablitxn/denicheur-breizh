import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  createListingKey,
  evaluatorSchema,
  MAX_LISTING_FEATURES,
  MAX_LISTING_IMAGE_URLS,
  listingDetailSchema,
  listingEvaluationRecordSchema,
  listingIngestionSchema,
  listingRecordSchema,
  parseListingKey,
  recipeVersionSchema,
  runDetailSchema,
  runIngestionSchema,
  runRecordSchema,
  type EvaluationRequest,
  type EvaluationFailureStage,
  type Evaluator,
  type FilterListingsResponse,
  type IngestionRequest,
  type IngestionResponse,
  type ListingDetail,
  type ListingEvaluationRecord,
  type ListingEvaluationResult,
  type ListingIdentity,
  type ListingIngestion,
  type ListingRecord,
  type ListingsPage,
  type ListingsQuery,
  type RecipeDraft,
  type RecipeVersion,
  type RunDetail,
  type RunIngestion,
  type RunRecord,
  type RunsPage,
  type RunsQuery,
  type VerifiedCoordinates,
} from "./contracts.js";
import { ApiError } from "./errors.js";

interface Migration {
  readonly version: number;
  readonly sql: string;
}

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
}

export interface CollectedDataCounts {
  readonly listings: number;
  readonly runs: number;
  readonly runListings: number;
  readonly evaluations: number;
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

export class DenicheurRepository {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(options: RepositoryOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.database = new DatabaseSync(options.path, { timeout: 5_000 });
    this.now = options.now ?? (() => new Date());
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    this.reconcileAbandonedEvaluationAttempts();
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

  clearCollectedData(options: ClearCollectedDataOptions = {}): CollectedDataCounts {
    return this.transaction(() => {
      if (!options.allowActiveRun) {
        const activeRun = this.database.prepare(`
          SELECT id, status
          FROM runs
          WHERE status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")})
          ORDER BY updated_at DESC
          LIMIT 1
        `).get(...ACTIVE_RUN_STATUSES) as Record<string, unknown> | undefined;
        if (activeRun) {
          const runId = readString(activeRun, "id");
          const status = readString(activeRun, "status");
          throw new ApiError(
            409,
            "ACTIVE_RUN",
            `Run ${runId} is still active (${status}). Wait for it to finish or cancel it before clearing data.`,
          );
        }
      }

      const deleted = this.collectedDataCounts();
      this.database.exec(`
        DELETE FROM evaluation_attempts;
        DELETE FROM evaluations;
        DELETE FROM run_listings;
        DELETE FROM listings;
        DELETE FROM runs;
      `);

      const remaining = this.collectedDataCounts();
      if (Object.values(remaining).some((count) => count !== 0) || this.countEvaluationAttempts() !== 0) {
        throw new Error("Collected data cleanup did not leave every iteration table empty.");
      }
      return deleted;
    });
  }

  ingest(request: IngestionRequest): IngestionResponse {
    return this.transaction(() => {
      this.upsertRun(request.run);
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const incoming of request.listings) {
        this.upsertRunListingSnapshot(request.run.id, incoming);
        const outcome = this.rebuildCanonicalListing(incoming);
        if (outcome === "inserted") inserted += 1;
        else if (outcome === "updated") updated += 1;
        else unchanged += 1;
      }

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
    const items = rows.map((row) => this.rowToListing(row));
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
    const listingRows = this.database.prepare(`
      SELECT * FROM run_listings
      WHERE run_id = ?
      ORDER BY observed_at DESC, source ASC, external_id ASC
    `).all(id) as StoredRunListingRow[];

    return runDetailSchema.parse({
      ...rowToRun(row),
      listings: listingRows.map((listing) => this.rowToRunSnapshot(listing)),
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

  private rowToListing(row: StoredListingRow): ListingRecord {
    const data = parseListingData(row.data_json);
    const latestEvaluation = this.latestEvaluation(data);
    return listingRecordSchema.parse({
      ...data,
      id: createListingKey(data),
      lastRunId: row.last_run_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
      ...(latestEvaluation ? { latestEvaluation } : {}),
    });
  }

  private rowToRunSnapshot(row: StoredRunListingRow): ListingRecord {
    const data = parseListingData(row.observation_json);
    const latestEvaluation = this.latestEvaluation(data, row.run_id);
    return listingRecordSchema.parse({
      ...data,
      id: createListingKey(data),
      lastRunId: row.run_id,
      firstSeenAt: row.first_observed_at,
      lastSeenAt: row.observed_at,
      updatedAt: row.observed_at,
      ...(latestEvaluation ? { latestEvaluation } : {}),
    });
  }

  private latestEvaluation(identity: ListingIdentity, runId?: string): ListingEvaluationRecord | undefined {
    const runClause = runId ? "AND run_id = ?" : "";
    const parameters = runId
      ? [identity.source, identity.externalId, runId]
      : [identity.source, identity.externalId];
    const row = this.database.prepare(`
      SELECT * FROM evaluations
      WHERE source = ? AND external_id = ?
      ${runClause}
      ORDER BY evaluated_at DESC, run_id DESC, recipe_id ASC, recipe_version DESC, locale ASC
      LIMIT 1
    `).get(...parameters) as StoredEvaluationRow | undefined;
    return row ? rowToEvaluation(row) : undefined;
  }

  private listEvaluations(identity: ListingIdentity): ListingEvaluationRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM evaluations
      WHERE source = ? AND external_id = ?
      ORDER BY evaluated_at DESC, run_id DESC, recipe_id ASC, recipe_version DESC, locale ASC
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
      ORDER BY e.evaluated_at DESC LIMIT 1
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
