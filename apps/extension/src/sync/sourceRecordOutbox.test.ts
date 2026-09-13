import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SOURCE_RECORD_PAYLOAD_CHARS, type SourceRecordInput } from "@denicheur-breizh/contracts";
import { clearRecordsAndSyncQueue, CRAWLER_STORAGE_KEYS } from "../storage/chromeStorage";
import { RUNTIME_API_STORAGE_KEYS } from "../api/runtimeConfig";
import {
  enqueueSourceExtractions,
  flushSourceRecordOutbox,
  readSourceRecordSyncStatus,
  SOURCE_RECORD_OUTBOX_KEY,
  SourceRecordPersistenceError,
  withSourceRecordSyncStatus,
  type AcceptedSourceExtraction,
} from "./sourceRecordOutbox";
import { EMPTY_SYNC_STATE } from "./storage";

const NOW = new Date("2026-09-12T15:00:00.000Z");
let storage: Record<string, unknown>;
let failNextWrite: boolean;
let runtime: { lastError?: { message: string } };

beforeEach(() => {
  storage = {};
  failNextWrite = false;
  runtime = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime,
      storage: { local: {
        get(keys: string[], callback: (values: Record<string, unknown>) => void) {
          callback(structuredClone(Object.fromEntries(keys.map((key) => [key, storage[key]]))));
        },
        set(patch: Record<string, unknown>, callback: () => void) {
          if (failNextWrite) {
            failNextWrite = false;
            runtime.lastError = { message: "Synthetic quota exceeded" };
          } else Object.assign(storage, structuredClone(patch));
          callback();
          delete runtime.lastError;
        },
        remove(keys: string[], callback: () => void) {
          for (const key of keys) delete storage[key];
          callback();
        },
      } },
    },
  });
});

function capture(payload: object = { title: "  Maison originale  ", features: ["Jardin", "Jardin"], unknownFutureField: null }): AcceptedSourceExtraction {
  return {
    source: "leboncoin", externalId: "3007106066", runId: "run-source-1",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/3007106066",
    observedAt: NOW.toISOString(), kind: "extension-detail", payload,
  };
}

function entries(): Array<{ record: SourceRecordInput; attempts: number; nextAttemptAt: number; lastError?: string }> {
  return (storage[SOURCE_RECORD_OUTBOX_KEY] as { entries: ReturnType<typeof entries> }).entries;
}

function ack(inserted = 1): Response {
  return new Response(JSON.stringify({ accepted: 1, inserted, unchanged: 1 - inserted }), { status: 200 });
}

describe("independent source-record outbox", () => {
  it("stores exact serialized extractor output once and keeps separate events for identical listing identities", async () => {
    const payload = { title: "  Original\ntext  ", features: ["Jardin", "Jardin"], extra: { unknown: null } };
    const serialized = JSON.stringify(payload);
    await enqueueSourceExtractions([capture(payload), capture(payload)]);
    payload.title = "Changed projection";
    payload.features.pop();

    expect(entries()).toHaveLength(2);
    expect(new Set(entries().map((entry) => entry.record.id)).size).toBe(2);
    expect(entries().every((entry) => entry.record.payloadJson === serialized)).toBe(true);
    expect(entries()[0].record).toMatchObject({ kind: "extension-detail", extractorVersion: "leboncoin-extractors-v1", observedAt: NOW.toISOString() });
  });

  it("preserves pending originals when collected data and the projection outbox are reset", async () => {
    await enqueueSourceExtractions([capture()]);
    const original = structuredClone(storage[SOURCE_RECORD_OUTBOX_KEY]);
    storage[CRAWLER_STORAGE_KEYS.records] = [{ id: "projection" }];

    await clearRecordsAndSyncQueue();

    expect(storage[SOURCE_RECORD_OUTBOX_KEY]).toEqual(original);
    expect(storage[CRAWLER_STORAGE_KEYS.records]).toEqual([]);
    expect(await readSourceRecordSyncStatus()).toEqual({ pending: 1 });
  });

  it("retries the same durable ID after network failure and restart without truncating its payload", async () => {
    await enqueueSourceExtractions([capture()]);
    const original = structuredClone(entries()[0].record);
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error("Synthetic offline"));
    const failed = await flushSourceRecordOutbox({ fetcher: offline, now: () => NOW });
    expect(failed).toMatchObject({ pending: 1, lastError: expect.stringContaining("offline") });
    expect(entries()[0]).toMatchObject({ record: original, attempts: 1, nextAttemptAt: NOW.getTime() + 60_000 });
    await flushSourceRecordOutbox({ fetcher: offline, now: () => NOW });
    expect(offline).toHaveBeenCalledOnce();

    vi.resetModules();
    const restarted = await import("./sourceRecordOutbox");
    const retry = vi.fn<typeof fetch>().mockResolvedValue(ack(0));
    expect(await restarted.flushSourceRecordOutbox({ fetcher: retry, now: () => new Date(NOW.getTime() + 60_000) })).toEqual({ pending: 0 });
    expect(JSON.parse(String(retry.mock.calls[0][1]?.body))).toEqual({ records: [original] });
    expect(entries()).toEqual([]);
  });

  it("removes only the acknowledged event while another capture is appended during its request", async () => {
    await enqueueSourceExtractions([capture({ price: 300_000 })]);
    const first = structuredClone(entries()[0].record);
    let resolveFirst!: (value: Response) => void;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => {
      requestStarted();
      return new Promise((resolve) => { resolveFirst = resolve; });
    }).mockRejectedValue(new Error("New capture still offline"));
    const flush = flushSourceRecordOutbox({ fetcher, now: () => NOW });
    await started;
    await enqueueSourceExtractions([capture({ price: 280_000 })]);
    const second = structuredClone(entries()[1].record);
    resolveFirst(ack());
    await flush;

    expect(entries()).toEqual([expect.objectContaining({ record: second, attempts: 1 })]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ records: [first] });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ records: [second] });
  });

  it("stops after one failed upload instead of waiting for each pending capture to time out", async () => {
    await enqueueSourceExtractions([capture({ price: 300_000 }), capture({ price: 280_000 })]);
    const original = entries().map((entry) => structuredClone(entry.record));
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("Synthetic archive timeout"));

    expect(await flushSourceRecordOutbox({ fetcher, now: () => NOW })).toMatchObject({ pending: 2 });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(entries().map((entry) => entry.record)).toEqual(original);
    expect(entries().map((entry) => entry.attempts)).toEqual([1, 0]);
  });

  it("keeps originals pending on invalid acknowledgement and exposes archive failures in sync status", async () => {
    await enqueueSourceExtractions([capture()]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ accepted: 0, inserted: 0, unchanged: 0 })));
    const status = await flushSourceRecordOutbox({ fetcher, now: () => NOW });
    expect(entries()).toHaveLength(1);
    expect(withSourceRecordSyncStatus(EMPTY_SYNC_STATE, status)).toMatchObject({
      status: "error", sourceRecordsPending: 1, lastError: expect.stringContaining("invalid source-record"),
    });
  });

  it("does not lose a pending capture if storing its acknowledgement fails", async () => {
    await enqueueSourceExtractions([capture()]);
    const original = structuredClone(entries()[0].record);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { failNextWrite = true; return ack(); });
    const status = await flushSourceRecordOutbox({ fetcher, now: () => NOW });
    expect(status.pending).toBe(1);
    expect(entries()[0].record).toEqual(original);
  });

  it("rejects persistence or size failures without claiming the capture was saved or truncating it", async () => {
    failNextWrite = true;
    await expect(enqueueSourceExtractions([capture()])).rejects.toBeInstanceOf(SourceRecordPersistenceError);
    expect(storage[SOURCE_RECORD_OUTBOX_KEY]).toBeUndefined();
    await expect(enqueueSourceExtractions([capture({ text: "x".repeat(MAX_SOURCE_RECORD_PAYLOAD_CHARS + 1) })])).rejects.toBeInstanceOf(SourceRecordPersistenceError);
    expect(storage[SOURCE_RECORD_OUTBOX_KEY]).toBeUndefined();
  });

  it("preserves a corrupted outbox instead of filtering or replacing its records", async () => {
    const original = { version: 1, entries: [{ unexpected: "capture still recoverable" }] };
    storage[SOURCE_RECORD_OUTBOX_KEY] = original;
    await expect(enqueueSourceExtractions([capture()])).rejects.toBeInstanceOf(SourceRecordPersistenceError);
    await expect(readSourceRecordSyncStatus()).rejects.toThrow("stored contents were preserved");
    expect(storage[SOURCE_RECORD_OUTBOX_KEY]).toEqual(original);
  });

  it("uses the configured endpoint and its bound operator authorization for archive posts", async () => {
    const endpoint = "http://localhost:14310";
    storage[RUNTIME_API_STORAGE_KEYS.baseUrl] = endpoint;
    storage[RUNTIME_API_STORAGE_KEYS.credential] = { endpoint, token: "synthetic-test-credential" };
    await enqueueSourceExtractions([capture()]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(ack());
    await flushSourceRecordOutbox({ fetcher, now: () => NOW });
    expect(fetcher.mock.calls[0][0]).toBe(`${endpoint}/v1/source-records`);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-test-credential");
  });
});
