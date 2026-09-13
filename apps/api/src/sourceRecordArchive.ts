import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  sourceRecordSchema, sourceRecordSummarySchema,
  type ListingIdentity, type ListingIngestion, type SourceRecord, type SourceRecordInput,
  type SourceRecordsPage, type SourceRecordsQuery, type SourceRecordsResponse,
} from "./contracts.js";
import { ApiError } from "./errors.js";

// No foreign keys to the disposable catalog, runs or pagination snapshots.
// Legacy rows are explicitly marked: their original pre-merge captures are unavailable.
export const SOURCE_RECORD_ARCHIVE_MIGRATION = `
  CREATE TABLE source_records (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    url TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('extension-search-result', 'extension-detail', 'api-ingestion', 'legacy-run-snapshot')),
    extractor_version TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64)
  ) STRICT;
  CREATE INDEX source_records_listing_history_idx ON source_records(source, external_id, sequence DESC);
  CREATE INDEX source_records_run_idx ON source_records(run_id, sequence);

  INSERT INTO source_records (
    id, source, external_id, run_id, url, observed_at, received_at, kind, payload_json, payload_sha256
  ) SELECT
    'legacy-' || lower(hex(randomblob(16))), source, external_id, run_id,
    json_extract(observation_json, '$.url'), scraped_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'legacy-run-snapshot', observation_json,
    source_record_sha256(observation_json)
  FROM run_listings ORDER BY scraped_at, run_id, source, external_id;

  CREATE TRIGGER source_records_immutable_update BEFORE UPDATE ON source_records BEGIN
    SELECT RAISE(ABORT, 'Source records are immutable');
  END;
  CREATE TRIGGER source_records_immutable_delete BEFORE DELETE ON source_records BEGIN
    SELECT RAISE(ABORT, 'Source records are retained independently of collected data');
  END;
`;

export function registerSourceRecordFunctions(database: DatabaseSync): void {
  database.function("source_record_sha256", { deterministic: true }, (value) => sha256(String(value)));
}

/** Call writes within the repository transaction, including batch conflict rollback. */
export class SourceRecordArchive {
  constructor(private readonly database: DatabaseSync, private readonly now: () => Date) {}

  append(records: readonly SourceRecordInput[]): SourceRecordsResponse {
    const validated = records.map((record) => storedRecordInputSchema.parse(record));
    let inserted = 0;
    const receivedAt = this.now().toISOString();
    for (const record of validated) {
      const existing = this.get(record.id);
      if (existing) {
        if (!sameRecord(existing, record)) {
          throw new ApiError(409, "SOURCE_RECORD_CONFLICT", "A source record id already belongs to a different capture.");
        }
        continue;
      }
      this.database.prepare(`
        INSERT INTO source_records (
          id, source, external_id, run_id, url, observed_at, received_at, kind,
          extractor_version, payload_json, payload_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.source, record.externalId, record.runId, record.url,
        record.observedAt, receivedAt, record.kind, record.extractorVersion ?? null,
        record.payloadJson, sha256(record.payloadJson));
      inserted += 1;
    }
    return { accepted: validated.length, inserted, unchanged: validated.length - inserted };
  }

  get(id: string): SourceRecord | undefined {
    const row = this.database.prepare(`SELECT ${RECORD_COLUMNS}, payload_json AS payloadJson
      FROM source_records WHERE id = ?`).get(id);
    return row ? sourceRecordSchema.parse(withoutNullVersion(row)) : undefined;
  }

  list(identity: ListingIdentity, query: SourceRecordsQuery): SourceRecordsPage {
    const rows = this.database.prepare(`SELECT ${RECORD_COLUMNS}
      FROM source_records WHERE source = ? AND external_id = ?
        ${query.beforeSequence === undefined ? "" : "AND sequence < ?"}
      ORDER BY sequence DESC LIMIT ?
    `).all(identity.source, identity.externalId,
      ...(query.beforeSequence === undefined ? [] : [query.beforeSequence]), query.limit + 1);
    const items = rows.slice(0, query.limit).map((row) => sourceRecordSummarySchema.parse(withoutNullVersion(row)));
    return {
      items,
      ...(rows.length > query.limit ? { nextBeforeSequence: items.at(-1)!.sequence } : {}),
    };
  }
}

/** Compatibility boundary: exactly the received listing JSON, before schema trims and merging. */
export function ingestionSourceRecord(runId: string, raw: ListingIngestion, identity: ListingIngestion): SourceRecordInput {
  const payloadJson = JSON.stringify(raw);
  return {
    id: `api-${sha256(JSON.stringify([runId, identity.source, identity.externalId, payloadJson]))}`,
    source: identity.source,
    externalId: identity.externalId,
    runId,
    url: identity.url,
    observedAt: identity.scrapedAt,
    kind: "api-ingestion",
    payloadJson,
  };
}

const RECORD_COLUMNS = `sequence, id, source, external_id AS externalId, run_id AS runId,
  url, observed_at AS observedAt, received_at AS receivedAt, kind,
  extractor_version AS extractorVersion, payload_sha256 AS payloadSha256`;

const storedRecordInputSchema = sourceRecordSchema.omit({ sequence: true, receivedAt: true, payloadSha256: true });

function withoutNullVersion(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, extractorVersion: row.extractorVersion ?? undefined };
}

function sameRecord(a: SourceRecordInput, b: SourceRecordInput): boolean {
  return a.id === b.id && a.source === b.source && a.externalId === b.externalId
    && a.runId === b.runId && a.url === b.url && a.observedAt === b.observedAt
    && a.kind === b.kind && a.extractorVersion === b.extractorVersion && a.payloadJson === b.payloadJson;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
