import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  sourceRecordSchema,
  sourceRecordsPageSchema,
  sourceRecordsResponseSchema,
  type ListingIngestion,
  type SourceRecordInput,
} from "../src/contracts.js";
import { DATABASE_MIGRATIONS, DenicheurRepository } from "../src/repository.js";

const NOW = "2026-09-12T10:00:00.000Z";
const IDENTITY = { source: "leboncoin", externalId: "123456" } as const;
const HISTORY_URL = `/v1/listings/${IDENTITY.source}/${IDENTITY.externalId}/source-records`;
const LIST_QUERY = { limit: 100, sort: "updatedAt", order: "desc" } as const;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("source record archive", () => {
  it("preserves the exact JSON text, unknown attributes and null values with a verifiable digest", () => {
    const repository = memoryRepository();
    const payloadJson = ' \n{ "title": "  Maison blanche  ", "unknown": {"nullable":null,"values":[1,null," x "]}, "empty":"" }\n ';
    const input = record("exact", { payloadJson });
    try {
      expect(repository.archiveSourceRecords([input])).toEqual({ accepted: 1, inserted: 1, unchanged: 0 });
      const stored = repository.getSourceRecord(input.id);
      expect(stored).toMatchObject({
        ...input,
        sequence: expect.any(Number),
        receivedAt: NOW,
        payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
      });
      expect(sourceRecordSchema.parse(stored)).toEqual(stored);
      expect(stored?.payloadJson).toBe(payloadJson);
      expect(JSON.parse(stored!.payloadJson)).toMatchObject({
        title: "  Maison blanche  ", unknown: { nullable: null, values: [1, null, " x "] }, empty: "",
      });
    } finally { repository.close(); }
  });

  it("accepts records without a canonical listing or run and does not mutate existing projections", () => {
    const repository = memoryRepository();
    try {
      repository.ingest({ run: { id: "catalog-run", source: "leboncoin", status: "completed" }, listings: [listing()] });
      const listingBefore = repository.getListing(IDENTITY);
      const metadataBefore = repository.listingsMetadata();
      repository.archiveSourceRecords([
        record("raw-existing", { payloadJson: '{"priceEuros":1,"title":"raw-only change"}' }),
        record("raw-missing", { externalId: "not-in-catalog" }),
      ]);

      expect(repository.getListing(IDENTITY)).toEqual(listingBefore);
      expect(repository.getListing({ source: "leboncoin", externalId: "not-in-catalog" })).toBeUndefined();
      expect(repository.getRun("capture-run")).toBeUndefined();
      expect(repository.listingsMetadata()).toEqual(metadataBefore);
      expect(repository.listListings(LIST_QUERY).total).toBe(1);
    } finally { repository.close(); }
  });

  it("makes identical retries idempotent without replacing receipt time, digest or sequence", () => {
    let now = NOW;
    const repository = new DenicheurRepository({ path: ":memory:", now: () => new Date(now) });
    const input = record("retry");
    try {
      expect(repository.archiveSourceRecords([input, input])).toEqual({ accepted: 2, inserted: 1, unchanged: 1 });
      const first = repository.getSourceRecord(input.id);
      now = "2026-09-13T12:00:00.000Z";
      expect(repository.archiveSourceRecords([input])).toEqual({ accepted: 1, inserted: 0, unchanged: 1 });
      expect(repository.getSourceRecord(input.id)).toEqual(first);
      expect(repository.listSourceRecords(IDENTITY, { limit: 100 }).items).toHaveLength(1);
    } finally { repository.close(); }
  });

  it.each([
    ["payload", { payloadJson: '{ "priceEuros": 300000 }' }],
    ["observation time", { observedAt: "2026-09-12T09:01:00.000Z" }],
    ["run", { runId: "another-run" }],
    ["listing", { externalId: "another-listing" }],
    ["URL", { url: "https://www.leboncoin.fr/ad/ventes_immobilieres/999" }],
    ["kind", { kind: "extension-search-result" }],
    ["extractor", { extractorVersion: "2.0.0" }],
  ] satisfies Array<[string, Partial<SourceRecordInput>]>)
  ("rejects conflicting %s for an existing ID and rolls back the entire batch", (_, change) => {
    const repository = memoryRepository();
    const original = record("immutable");
    try {
      repository.archiveSourceRecords([original]);
      const before = repository.getSourceRecord(original.id);
      expect(() => repository.archiveSourceRecords([record("must-rollback"), { ...original, ...change }]))
        .toThrow(expect.objectContaining({ statusCode: 409, code: "SOURCE_RECORD_CONFLICT" }));
      expect(repository.getSourceRecord("must-rollback")).toBeUndefined();
      expect(repository.getSourceRecord(original.id)).toEqual(before);
      expect(repository.listSourceRecords(IDENTITY, { limit: 100 }).items).toHaveLength(1);
    } finally { repository.close(); }
  });

  it("rolls back conflicting duplicates within a previously unseen batch", () => {
    const repository = memoryRepository();
    try {
      expect(() => repository.archiveSourceRecords([
        record("same-batch"), record("same-batch", { payloadJson: '{"priceEuros":1}' }),
      ])).toThrow(expect.objectContaining({ code: "SOURCE_RECORD_CONFLICT" }));
      expect(repository.getSourceRecord("same-batch")).toBeUndefined();
    } finally { repository.close(); }
  });

  it("retains successive prices within one ingestion run while the projection exposes the latest", () => {
    const repository = memoryRepository();
    const run = { id: "price-history", source: "leboncoin", status: "completed" } as const;
    const first = listing({ title: "  Maison avec jardin  ", priceEuros: 350000, scrapedAt: "2026-09-12T08:00:00.000Z" });
    const latest = listing({ title: "  Maison avec jardin  ", priceEuros: 325000, scrapedAt: "2026-09-12T09:00:00.000Z" });
    try {
      repository.ingest({ run, listings: [first] });
      repository.ingest({ run, listings: [latest] });
      repository.ingest({ run, listings: [latest] });

      const history = repository.listSourceRecords(IDENTITY, { limit: 100 });
      expect(history.items).toHaveLength(2);
      expect(history.items.map((item) => item.kind)).toEqual(["api-ingestion", "api-ingestion"]);
      const captures = history.items.map((item) => JSON.parse(repository.getSourceRecord(item.id)!.payloadJson));
      expect(captures).toEqual([latest, first]);
      expect(captures[0].title).toBe("  Maison avec jardin  ");
      expect(repository.getListing(IDENTITY)).toMatchObject({ title: "Maison avec jardin", priceEuros: 325000 });
      expect(repository.getListing(IDENTITY)?.runs).toHaveLength(1);
    } finally { repository.close(); }
  });

  it("paginates metadata by descending receipt sequence despite out-of-order observation times and new arrivals", () => {
    const repository = memoryRepository();
    try {
      repository.archiveSourceRecords([
        record("one", { observedAt: "2026-09-12T09:00:00.000Z" }),
        record("two", { observedAt: "2026-09-11T09:00:00.000Z" }),
        record("other", { externalId: "other" }),
        record("three", { observedAt: "2026-09-10T09:00:00.000Z" }),
        record("four", { observedAt: "2026-09-09T09:00:00.000Z" }),
      ]);
      const first = repository.listSourceRecords(IDENTITY, { limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(["four", "three"]);
      expect(first.nextBeforeSequence).toBe(first.items[1]?.sequence);
      for (const item of first.items) expect(item).not.toHaveProperty("payloadJson");
      expect(sourceRecordsPageSchema.parse(first)).toEqual(first);

      repository.archiveSourceRecords([record("five")]);
      const second = repository.listSourceRecords(IDENTITY, { limit: 2, beforeSequence: first.nextBeforeSequence! });
      expect(second.items.map((item) => item.id)).toEqual(["two", "one"]);
      expect(second.nextBeforeSequence).toBeUndefined();
      expect(repository.listSourceRecords({ source: "leboncoin", externalId: "absent" }, { limit: 2 }).items).toEqual([]);
    } finally { repository.close(); }
  });

  it("preserves captures through collected-data cleanup and database reopen", () => {
    const path = temporaryDatabase();
    const first = new DenicheurRepository({ path, now: () => new Date(NOW) });
    let before;
    try {
      first.ingest({ run: { id: "cleanup-run", source: "leboncoin", status: "completed" }, listings: [listing()] });
      first.archiveSourceRecords([record("durable")]);
      before = first.listSourceRecords(IDENTITY, { limit: 100 }).items
        .map((item) => first.getSourceRecord(item.id));
      first.clearCollectedData();
      expect(first.listListings(LIST_QUERY).total).toBe(0);
      expect(first.listSourceRecords(IDENTITY, { limit: 100 }).items).toHaveLength(2);
    } finally { first.close(); }

    const reopened = new DenicheurRepository({ path, now: () => new Date("2026-09-13T00:00:00.000Z") });
    try {
      expect(reopened.listSourceRecords(IDENTITY, { limit: 100 }).items.map((item) => reopened.getSourceRecord(item.id)))
        .toEqual(before);
      expect(reopened.archiveSourceRecords([record("durable")])).toEqual({ accepted: 1, inserted: 0, unchanged: 1 });
      expect(reopened.getListing(IDENTITY)).toBeUndefined();
    } finally { reopened.close(); }
  });

  it("migrates only surviving version-eleven run snapshots and labels their legacy provenance", () => {
    const path = temporaryDatabase();
    const snapshot = listing({ priceEuros: 325000, scrapedAt: "2026-09-11T09:00:00.000Z" });
    const payloadJson = JSON.stringify(snapshot, null, 2);
    seedLegacySnapshot(path, snapshot, payloadJson);

    const upgraded = new DenicheurRepository({ path, now: () => new Date(NOW) });
    let id: string;
    try {
      const history = upgraded.listSourceRecords(IDENTITY, { limit: 100 });
      expect(history.items).toHaveLength(1);
      id = history.items[0]!.id;
      expect(upgraded.getSourceRecord(id)).toMatchObject({
        kind: "legacy-run-snapshot", runId: "legacy-run", observedAt: snapshot.scrapedAt,
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), payloadJson,
      });
      // The older first_observed_at cannot reconstruct a lost earlier payload or price.
      expect(history.items[0]?.observedAt).not.toBe("2026-09-10T09:00:00.000Z");
    } finally { upgraded.close(); }
    const reopened = new DenicheurRepository({ path, now: () => new Date(NOW) });
    try {
      expect(reopened.listSourceRecords(IDENTITY, { limit: 100 }).items.map((item) => item.id)).toEqual([id]);
    } finally { reopened.close(); }
  });

  it("reads migrated legacy payloads larger than new-capture admission limits without trimming or truncation", async () => {
    const path = temporaryDatabase();
    const snapshot = listing({ title: `${" ".repeat(270000)}Legacy title`, description: "  Original description  " });
    const payloadJson = ` \n${JSON.stringify(snapshot, null, 2)}\n `;
    expect(Buffer.byteLength(payloadJson, "utf8")).toBeGreaterThan(262144);
    seedLegacySnapshot(path, snapshot, payloadJson);

    const { app, repository } = testApp(new DenicheurRepository({ path, now: () => new Date(NOW) }));
    try {
      const history = await request(app).get(HISTORY_URL).expect(200);
      expect(history.body.items).toHaveLength(1);
      const metadata = history.body.items[0];
      expect(metadata.kind).toBe("legacy-run-snapshot");
      expect(metadata).not.toHaveProperty("payloadJson");
      const detail = await request(app).get(`/v1/source-records/${metadata.id}`).expect(200);
      expect(sourceRecordSchema.parse(detail.body).payloadJson).toBe(payloadJson);
      expect(JSON.parse(detail.body.payloadJson)).toEqual(snapshot);
      expect(detail.body.payloadSha256).toBe(createHash("sha256").update(payloadJson).digest("hex"));
    } finally { repository.close(); }
  });
});

describe("source record HTTP API", () => {
  it("accepts a Unicode capture larger than the global HTTP body limit through the dedicated archive route", async () => {
    const { app, repository } = testApp();
    const input = record("unicode-body", { payloadJson: JSON.stringify({ text: "家".repeat(100000) }) });
    const body = { records: [input] };
    const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    expect(requestBytes).toBeGreaterThan(256 * 1024);
    expect(requestBytes).toBeLessThan(1024 * 1024);
    try {
      await request(app).post("/v1/source-records").send(body)
        .expect(200, { accepted: 1, inserted: 1, unchanged: 0 });
      const response = await request(app).get(`/v1/source-records/${input.id}`).expect(200);
      expect(response.body.payloadJson).toBe(input.payloadJson);
      expect(response.body.payloadSha256).toBe(createHash("sha256").update(input.payloadJson, "utf8").digest("hex"));
    } finally { repository.close(); }
  });

  it("archives, lists and reads raw-only captures, with idempotency and atomic conflict errors", async () => {
    const { app, repository } = testApp();
    const input = record("http", { payloadJson: ' \n{"unknown":null,"title":"  original  "}\n' });
    try {
      const accepted = await request(app).post("/v1/source-records").send({ records: [input] }).expect(200);
      expect(sourceRecordsResponseSchema.parse(accepted.body)).toEqual({ accepted: 1, inserted: 1, unchanged: 0 });
      await request(app).post("/v1/source-records").send({ records: [input] })
        .expect(200, { accepted: 1, inserted: 0, unchanged: 1 });
      const detail = await request(app).get(`/v1/source-records/${input.id}`).expect(200);
      expect(sourceRecordSchema.parse(detail.body)).toMatchObject(input);
      expect(detail.body.payloadJson).toBe(input.payloadJson);
      const list = await request(app).get(HISTORY_URL).query({ limit: 1 }).expect(200);
      expect(sourceRecordsPageSchema.parse(list.body).items).toHaveLength(1);
      expect(list.body.items[0]).not.toHaveProperty("payloadJson");
      await request(app).get(`/v1/listings/${IDENTITY.source}/${IDENTITY.externalId}`).expect(404);
      await request(app).get("/v1/source-records/missing").expect(404);

      const conflict = await request(app).post("/v1/source-records").send({ records: [
        record("http-rollback"), { ...input, payloadJson: '{"changed":true}' },
      ] }).expect(409);
      expect(conflict.body.error.code).toBe("SOURCE_RECORD_CONFLICT");
      await request(app).get("/v1/source-records/http-rollback").expect(404);
      expect(repository.getSourceRecord(input.id)?.payloadJson).toBe(input.payloadJson);
    } finally { repository.close(); }
  });

  it("rejects malformed, oversized or non-object JSON and invalid metadata without partial writes", async () => {
    const { app, repository } = testApp();
    const invalid = [
      ...["", "null", "[]", "1", '"text"', "{invalid", JSON.stringify({ huge: "x".repeat(262144) })]
        .map((payloadJson) => ({ payloadJson })),
      { id: "x".repeat(129) }, { id: "" }, { source: "unsupported" },
      { url: "http://www.leboncoin.fr/ad/ventes_immobilieres/123456" },
      { observedAt: "yesterday" }, { kind: "unknown" }, { surprise: true },
    ];
    try {
      for (const [index, change] of invalid.entries()) {
        const response = await request(app).post("/v1/source-records").send({ records: [
          record(`valid-prefix-${index}`), { ...record(`invalid-${index}`), ...change },
        ] });
        expect(response.status, JSON.stringify({ caseIndex: index, response: response.body })).toBe(400);
        expect(response.body.error.code).toBe("INVALID_REQUEST");
        expect(repository.getSourceRecord(`valid-prefix-${index}`)).toBeUndefined();
      }
      expect(repository.listSourceRecords(IDENTITY, { limit: 100 }).items).toEqual([]);
    } finally { repository.close(); }
  });

  it("rejects invalid pagination and identity parameters instead of silently broadening reads", async () => {
    const { app, repository } = testApp();
    try {
      for (const query of [
        "limit=0", "limit=100001", "limit=1.5", "limit=nope", "limit=1&limit=2",
        "beforeSequence=0", "beforeSequence=-1", "beforeSequence=1.5", "beforeSequence=nope", "unknown=1",
      ]) {
        const response = await request(app).get(`${HISTORY_URL}?${query}`).expect(400);
        expect(response.body.error.code).toBe("INVALID_REQUEST");
      }
      await request(app).get("/v1/listings/unsupported/123456/source-records").expect(400);
      await request(app).get(`/v1/source-records/${"x".repeat(129)}`).expect(400);
    } finally { repository.close(); }
  });

  it("archives the original ingestion listing before validation trims its projected text", async () => {
    const { app, repository } = testApp();
    const original = listing({ title: "  Original title  ", description: "\n Original description \n" });
    try {
      await request(app).put("/v1/ingestion/runs/http-ingest").send({
        run: { id: "http-ingest", source: "leboncoin", status: "completed" }, listings: [original],
      }).expect(200);
      const [metadata] = repository.listSourceRecords(IDENTITY, { limit: 100 }).items;
      expect(metadata?.kind).toBe("api-ingestion");
      expect(JSON.parse(repository.getSourceRecord(metadata!.id)!.payloadJson)).toEqual(original);
      expect(repository.getListing(IDENTITY)).toMatchObject({ title: "Original title", description: "Original description" });

      await request(app).put("/v1/ingestion/runs/invalid-ingest").send({
        run: { id: "invalid-ingest", source: "leboncoin", status: "completed" },
        listings: [listing({ priceEuros: -1 })],
      }).expect(400);
      expect(repository.getRun("invalid-ingest")).toBeUndefined();
      expect(repository.listSourceRecords(IDENTITY, { limit: 100 }).items).toHaveLength(1);
    } finally { repository.close(); }
  });

  it("keeps valid ingestion with long pre-trim text compatible while preserving the original capture", async () => {
    const { app, repository } = testApp();
    const original = listing({ title: `${" ".repeat(132000)}Maison`, description: "\n Original description \n" });
    const ingestion = {
      run: { id: "long-text-ingest", source: "leboncoin", status: "completed" }, listings: [original],
    };
    expect(Buffer.byteLength(JSON.stringify(ingestion), "utf8")).toBeLessThan(256 * 1024);
    try {
      await request(app).put("/v1/ingestion/runs/long-text-ingest").send(ingestion).expect(200);
      expect(repository.getListing(IDENTITY)).toMatchObject({ title: "Maison", description: "Original description" });
      const [metadata] = repository.listSourceRecords(IDENTITY, { limit: 100 }).items;
      expect(metadata?.kind).toBe("api-ingestion");
      const detail = await request(app).get(`/v1/source-records/${metadata!.id}`).expect(200);
      expect(detail.body.payloadJson).toBe(JSON.stringify(original));
      expect(JSON.parse(detail.body.payloadJson)).toEqual(original);
    } finally { repository.close(); }
  });
});

function record(id: string, overrides: Partial<SourceRecordInput> = {}): SourceRecordInput {
  return {
    id, ...IDENTITY, runId: "capture-run", kind: "extension-detail", extractorVersion: "1.0.0",
    observedAt: "2026-09-12T09:00:00.000Z",
    url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${IDENTITY.externalId}`,
    payloadJson: '{"priceEuros":300000}',
    ...overrides,
  };
}

function listing(overrides: Partial<ListingIngestion> = {}): ListingIngestion {
  return {
    ...IDENTITY, url: `https://www.leboncoin.fr/ad/ventes_immobilieres/${IDENTITY.externalId}`,
    status: "detailed", scrapedAt: NOW, title: "Maison", priceEuros: 300000, ...overrides,
  };
}

function memoryRepository() {
  return new DenicheurRepository({ path: ":memory:", now: () => new Date(NOW) });
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "denicheur-source-records-"));
  directories.push(directory);
  return join(directory, "archive.sqlite");
}

function seedLegacySnapshot(path: string, snapshot: ListingIngestion, payloadJson: string) {
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;");
    for (const migration of DATABASE_MIGRATIONS.filter((item) => item.version <= 11)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, NOW);
    }
    legacy.prepare("INSERT INTO runs (id, source, status, updated_at, data_json) VALUES (?, ?, ?, ?, ?)")
      .run("legacy-run", "leboncoin", "completed", NOW, JSON.stringify({ id: "legacy-run", source: "leboncoin", status: "completed" }));
    legacy.prepare(`INSERT INTO run_listings
      (run_id, source, external_id, first_observed_at, observed_at, status, scraped_at, observation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-run", IDENTITY.source, IDENTITY.externalId, "2026-09-10T09:00:00.000Z", snapshot.scrapedAt,
        snapshot.status, snapshot.scrapedAt, payloadJson);
  } finally { legacy.close(); }
}

function testApp(repository = memoryRepository()) {
  const app = createApp({
    config: loadConfig({}), repository,
    filterService: { filter: vi.fn().mockRejectedValue(new Error("Unexpected evaluator call")) },
    logger: { info: vi.fn(), error: vi.fn() },
    evaluationExecutionWorker: { start: vi.fn(), kick: vi.fn(), dispose: vi.fn().mockResolvedValue(undefined) },
  });
  return { app, repository };
}
