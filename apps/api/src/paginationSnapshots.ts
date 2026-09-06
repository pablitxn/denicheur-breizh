import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors.js";

export const PAGINATION_SNAPSHOT_MIGRATION = `
  CREATE TABLE collection_revisions (
    collection TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  INSERT INTO collection_revisions(collection, epoch) VALUES
    ('listings', lower(hex(randomblob(16)))),
    ('runs', lower(hex(randomblob(16)))),
    ('executions', lower(hex(randomblob(16))));
  CREATE TABLE pagination_snapshots (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    revision TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX pagination_snapshots_query_idx
    ON pagination_snapshots(collection, query_hash, revision);
  CREATE INDEX pagination_snapshots_expiry_idx ON pagination_snapshots(expires_at);
  CREATE TABLE listing_read_revisions (
    source TEXT NOT NULL, external_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(source, external_id)
  ) STRICT;
  INSERT INTO listing_read_revisions SELECT source, external_id, 1 FROM listings;
  CREATE TABLE listing_projection_payloads (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
    projection TEXT NOT NULL, revision INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    size_bytes INTEGER GENERATED ALWAYS AS (length(CAST(payload AS BLOB))) STORED,
    UNIQUE(source, external_id, projection, revision)
  ) STRICT;
  CREATE TABLE projection_cache_usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), bytes INTEGER NOT NULL);
  INSERT INTO projection_cache_usage VALUES (1, 0);
  CREATE TRIGGER projection_cache_admit BEFORE INSERT ON listing_projection_payloads
  WHEN (SELECT bytes FROM projection_cache_usage) + length(CAST(NEW.payload AS BLOB)) > 536870912
  BEGIN SELECT RAISE(ABORT, 'PAGINATION_PAYLOAD_BUDGET_EXCEEDED'); END;
  CREATE TRIGGER projection_cache_insert AFTER INSERT ON listing_projection_payloads
  BEGIN UPDATE projection_cache_usage SET bytes = bytes + NEW.size_bytes; END;
  CREATE TRIGGER projection_cache_delete AFTER DELETE ON listing_projection_payloads
  BEGIN UPDATE projection_cache_usage SET bytes = bytes - OLD.size_bytes; END;
  CREATE TABLE pagination_snapshot_items (
    snapshot_id TEXT NOT NULL REFERENCES pagination_snapshots(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    payload_id INTEGER REFERENCES listing_projection_payloads(id),
    PRIMARY KEY(snapshot_id, position)
  ) STRICT;
  CREATE INDEX pagination_snapshot_payload_idx ON pagination_snapshot_items(payload_id);
  ${[
    ["listings", "listings"], ["evaluations", "listings"], ["media_assets", "listings"],
    ["listing_media", "listings"], ["runs", "runs"],
    ["evaluation_executions", "executions"], ["evaluation_execution_budgets", "executions"],
  ].flatMap(([table, collection]) => ["INSERT", "UPDATE", "DELETE"].map((event) => `
    CREATE TRIGGER ${table}_${event.toLowerCase()}_collection_revision AFTER ${event} ON ${table}
    BEGIN UPDATE collection_revisions SET revision = revision + 1 WHERE collection = '${collection}'; END;
  `)).join("\n")}
  ${["listings", "evaluations", "listing_media"].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((event) => {
    const row = event === "DELETE" ? "OLD" : "NEW";
    return `CREATE TRIGGER ${table}_${event.toLowerCase()}_listing_revision AFTER ${event} ON ${table}
      BEGIN INSERT INTO listing_read_revisions(source, external_id, revision) VALUES (${row}.source, ${row}.external_id, 1)
        ON CONFLICT(source, external_id) DO UPDATE SET revision = revision + 1; END;`;
  })).join("\n")}
  CREATE TRIGGER media_assets_update_listing_revision AFTER UPDATE ON media_assets
  BEGIN UPDATE listing_read_revisions SET revision = revision + 1 WHERE (source, external_id) IN (
    SELECT source, external_id FROM listing_media WHERE asset_id = NEW.id
  ); END;
`;

export interface PaginationSnapshotPolicy {
  ttlMs: number;
  maxSnapshots: number;
  maxSnapshotRows: number;
  maxSnapshotBytes: number;
  maxTotalBytes: number;
  maxTotalRows: number;
}

export const DEFAULT_PAGINATION_SNAPSHOT_POLICY: PaginationSnapshotPolicy = {
  ttlMs: 15 * 60_000,
  maxSnapshots: 64,
  maxSnapshotRows: 100_000,
  maxSnapshotBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxTotalRows: 500_000,
};

interface SnapshotHeader {
  id: string;
  collection: string;
  query_hash: string;
  revision: string;
  total: number;
  size_bytes: number;
}

interface SnapshotCursor { v: 1; snapshot: string; offset: number }
export interface SnapshotPayload { payload: string; payload_id?: number; size_bytes?: number }

export function paginationQueryHash(query: object): string {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(
    Object.entries(query).filter(([key, value]) => key !== "cursor" && key !== "limit" && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ))).digest("hex");
}

export function collectionEtag(revision: string, query: object): string {
  return `W/"${revision}-${paginationQueryHash(query)}"`;
}

/** Immutable payloads keep membership, order and values stable without holding a DB read transaction across HTTP calls. */
export class PaginationSnapshots {
  private readonly policy: PaginationSnapshotPolicy;

  constructor(private readonly database: DatabaseSync, private readonly now: () => Date, policy?: Partial<PaginationSnapshotPolicy>) {
    this.policy = { ...DEFAULT_PAGINATION_SNAPSHOT_POLICY, ...policy };
    for (const value of Object.values(this.policy)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Pagination snapshot limits must be positive safe integers.");
    }
    if (this.policy.maxSnapshotBytes > this.policy.maxTotalBytes) {
      throw new Error("A pagination snapshot cannot exceed the total snapshot byte budget.");
    }
    if (this.policy.maxSnapshotRows > this.policy.maxTotalRows) throw new Error("A pagination snapshot cannot exceed the total row budget.");
  }

  prune(forcePayloadCleanup = false): void {
    const removed = this.database.prepare("DELETE FROM pagination_snapshots WHERE expires_at <= ?").run(this.now().toISOString());
    if (forcePayloadCleanup || removed.changes !== 0) this.prunePayloads();
  }

  revision(collection: "listings" | "runs" | "executions"): string {
    const row = this.database.prepare("SELECT epoch, revision FROM collection_revisions WHERE collection = ?")
      .get(collection) as { epoch: string; revision: number };
    return `${row.epoch}-${row.revision}`;
  }

  read<T>(options: {
    collection: "listings" | "runs" | "executions";
    query: object;
    limit: number;
    cursor?: string | undefined;
    ifNoneMatch?: string | undefined;
    etagQuery?: object;
    load: () => Iterable<SnapshotPayload>;
    parse: (payload: string) => T;
  }): { items: T[]; nextCursor: string | null; total: number; revision: string; notModified: boolean } {
    const cursor = decodeSnapshotCursor(options.cursor);
    const queryHash = paginationQueryHash(options.query);
    this.prune();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now().toISOString();
      let header: SnapshotHeader | undefined;
      if (cursor) {
        header = this.database.prepare("SELECT * FROM pagination_snapshots WHERE id = ?").get(cursor.snapshot) as SnapshotHeader | undefined;
        if (!header) throw expiredCursor();
        if (header.collection !== options.collection || header.query_hash !== queryHash || cursor.offset >= header.total) {
          throw new ApiError(400, "INVALID_CURSOR", "The cursor does not belong to this query.");
        }
      } else {
        const revision = this.revision(options.collection);
        if (options.ifNoneMatch === collectionEtag(revision, options.etagQuery ?? options.query)) {
          this.database.exec("COMMIT");
          return { items: [], nextCursor: null, total: 0, revision, notModified: true };
        }
        header = this.database.prepare(`
          SELECT * FROM pagination_snapshots WHERE collection = ? AND query_hash = ? AND revision = ?
        `).get(options.collection, queryHash, revision) as SnapshotHeader | undefined;
        if (!header) {
          this.preparePayloadCache();
          const iterator = options.load()[Symbol.iterator]();
          try {
            const first: SnapshotPayload[] = [];
            for (let index = 0; index <= options.limit; index += 1) {
              const row = iterator.next();
              if (row.done) {
                const items = this.resolvePayloads(first).map(options.parse);
                this.database.exec("COMMIT");
                return { items, nextCursor: null, total: items.length, revision, notModified: false };
              }
              first.push(row.value);
            }
            const id = randomUUID();
            this.database.prepare(`
              INSERT INTO pagination_snapshots(id, collection, query_hash, revision, expires_at, last_accessed_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(id, options.collection, queryHash, revision, new Date(this.now().getTime() + this.policy.ttlMs).toISOString(), now);
            let total = 0;
            let sizeBytes = 0;
            const batch: Array<string | number | null> = [];
            const inserts = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
            const flush = () => {
              if (batch.length === 0) return;
              let insert = inserts.get(batch.length);
              if (!insert) {
                insert = this.database.prepare(`INSERT INTO pagination_snapshot_items(snapshot_id, position, payload, payload_id) VALUES ${Array.from({ length: batch.length / 4 }, () => "(?, ?, ?, ?)").join(",")}`);
                inserts.set(batch.length, insert);
              }
              insert.run(...batch);
              batch.length = 0;
            };
            const append = (entry: SnapshotPayload) => {
              total += 1;
              sizeBytes += entry.size_bytes ?? Buffer.byteLength(entry.payload, "utf8");
              if (total > this.policy.maxSnapshotRows || sizeBytes > this.policy.maxSnapshotBytes) {
                throw new ApiError(422, "PAGINATION_SNAPSHOT_TOO_LARGE", "This result exceeds the snapshot budget. Narrow the filters before retrying.");
              }
              batch.push(id, total - 1, entry.payload, entry.payload_id ?? null);
              if (batch.length === 400) flush();
            };
            first.forEach(append);
            for (let row = iterator.next(); !row.done; row = iterator.next()) append(row.value);
            flush();
            this.database.prepare("UPDATE pagination_snapshots SET total = ?, size_bytes = ? WHERE id = ?").run(total, sizeBytes, id);
            header = { id, collection: options.collection, query_hash: queryHash, revision, total, size_bytes: sizeBytes };
            this.evict(id);
          } finally {
            iterator.return?.();
          }
        }
      }
      const offset = cursor?.offset ?? 0;
      const rows = this.database.prepare(`
        SELECT COALESCE(shared.payload, item.payload) AS payload FROM pagination_snapshot_items item
        LEFT JOIN listing_projection_payloads shared ON shared.id = item.payload_id
        WHERE snapshot_id = ? AND position >= ? ORDER BY position LIMIT ?
      `).all(header.id, offset, options.limit) as Array<{ payload: string }>;
      const items = rows.map(({ payload }) => options.parse(payload));
      this.database.prepare("UPDATE pagination_snapshots SET last_accessed_at = ? WHERE id = ?").run(now, header.id);
      this.database.exec("COMMIT");
      const nextOffset = offset + items.length;
      return {
        items, total: header.total, revision: header.revision, notModified: false,
        nextCursor: nextOffset < header.total ? encodeSnapshotCursor({ v: 1, snapshot: header.id, offset: nextOffset }) : null,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("PAGINATION_PAYLOAD_BUDGET_EXCEEDED")) {
        throw new ApiError(422, "PAGINATION_SNAPSHOT_TOO_LARGE", "The immutable payload cache budget was exceeded. Narrow the filters before retrying.");
      }
      throw error;
    }
  }

  private resolvePayloads(entries: SnapshotPayload[]): string[] {
    const ids = entries.flatMap((entry) => entry.payload_id === undefined ? [] : [entry.payload_id]);
    if (!ids.length) return entries.map((entry) => entry.payload);
    const rows = this.database.prepare(`SELECT id, payload FROM listing_projection_payloads WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<{ id: number; payload: string }>;
    const payloads = new Map(rows.map((row) => [row.id, row.payload]));
    return entries.map((entry) => {
      if (entry.payload_id === undefined) return entry.payload;
      const payload = payloads.get(entry.payload_id);
      if (!payload) throw new Error("The immutable listing payload is missing.");
      return payload;
    });
  }

  private prunePayloads(allUnreferenced = false): void {
    this.database.prepare(`DELETE FROM listing_projection_payloads AS payload WHERE
      NOT EXISTS(SELECT 1 FROM pagination_snapshot_items item WHERE item.payload_id = payload.id)
      ${allUnreferenced ? "" : `AND NOT EXISTS(SELECT 1 FROM listing_read_revisions revision JOIN listings l USING(source, external_id)
        WHERE revision.source = payload.source AND revision.external_id = payload.external_id AND revision.revision = payload.revision)`}
    `).run();
  }

  private preparePayloadCache(): void {
    this.prunePayloads();
    const usage = () => (this.database.prepare("SELECT bytes FROM projection_cache_usage").get() as { bytes: number }).bytes;
    if (usage() <= 384 * 1024 * 1024) return;
    this.prunePayloads(true);
    const candidates = this.database.prepare("SELECT id FROM pagination_snapshots ORDER BY last_accessed_at, rowid").all() as Array<{ id: string }>;
    for (const candidate of candidates) {
      if (usage() <= 384 * 1024 * 1024) break;
      this.database.prepare("DELETE FROM pagination_snapshots WHERE id = ?").run(candidate.id);
      this.prunePayloads(true);
    }
  }

  private evict(retainedId: string): void {
    const usage = this.database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes, COALESCE(SUM(total), 0) AS rows FROM pagination_snapshots")
      .get() as { count: number; bytes: number; rows: number };
    const fits = () => usage.count <= this.policy.maxSnapshots && usage.bytes <= this.policy.maxTotalBytes && usage.rows <= this.policy.maxTotalRows;
    if (fits()) return;
    const candidates = this.database.prepare(`
      SELECT id, size_bytes, total FROM pagination_snapshots WHERE id != ? ORDER BY last_accessed_at, rowid
    `).all(retainedId) as Array<{ id: string; size_bytes: number; total: number }>;
    const remove = this.database.prepare("DELETE FROM pagination_snapshots WHERE id = ?");
    for (const candidate of candidates) {
      if (fits()) break;
      remove.run(candidate.id);
      usage.count -= 1;
      usage.bytes -= candidate.size_bytes;
      usage.rows -= candidate.total;
    }
    this.prunePayloads(true);
  }
}

function encodeSnapshotCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function expiredCursor(): ApiError {
  return new ApiError(410, "PAGINATION_CURSOR_EXPIRED", "The pagination snapshot expired or was evicted. Restart from the first page.");
}

function decodeSnapshotCursor(cursor?: string): SnapshotCursor | undefined {
  if (!cursor) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid."); }
  if (typeof decoded !== "object" || decoded === null) throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid.");
  if (!("v" in decoded) && "offset" in decoded && typeof decoded.offset === "number" && Number.isSafeInteger(decoded.offset) && decoded.offset >= 0) {
    throw new ApiError(410, "PAGINATION_CURSOR_RESTART_REQUIRED", "Legacy offset cursors cannot preserve snapshot consistency. Restart from the first page.");
  }
  if (!("v" in decoded) || decoded.v !== 1 || !("snapshot" in decoded) || typeof decoded.snapshot !== "string" ||
    !/^[a-f0-9-]{36}$/.test(decoded.snapshot) || !("offset" in decoded) || typeof decoded.offset !== "number" ||
    !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || Object.keys(decoded).length !== 3) {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid.");
  }
  return decoded as SnapshotCursor;
}
