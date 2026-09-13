import { sourceRecordInputSchema, type SourceRecordInput } from "@denicheur-breizh/contracts";
import { ingestSourceRecord, type SyncFetcher } from "./api";
import type { ExtensionSyncState } from "./types";

export const SOURCE_RECORD_OUTBOX_KEY = "denicheur:source-records:outbox:v1";
const STORAGE_LOCK = "denicheur:source-records:storage";
const FLUSH_LOCK = "denicheur:source-records:flush";
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const MAX_RECORDS_PER_FLUSH = 20;

interface SourceRecordQueueEntry {
  record: SourceRecordInput;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface SourceRecordOutbox {
  version: 1;
  entries: SourceRecordQueueEntry[];
}

export interface SourceRecordSyncStatus {
  pending: number;
  lastError?: string;
}

export interface AcceptedSourceExtraction {
  source: "leboncoin";
  externalId: string;
  runId: string;
  url: string;
  observedAt: string;
  kind: "extension-search-result" | "extension-detail";
  payload: object;
}

export class SourceRecordPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceRecordPersistenceError";
  }
}

/** Persist the accepted extractor output before replacing its display projection. */
export async function enqueueSourceExtractions(extractions: readonly AcceptedSourceExtraction[]): Promise<void> {
  if (extractions.length === 0) return;
  try {
    // Serialize now, not during a later sync: callers may subsequently update projections.
    const records = extractions.map(({ payload, ...metadata }) => {
      const parsed = sourceRecordInputSchema.safeParse({
        ...metadata,
        id: crypto.randomUUID(),
        extractorVersion: "leboncoin-extractors-v1",
        payloadJson: JSON.stringify(payload),
      });
      if (!parsed.success) throw new Error("The accepted extraction does not fit the source-record archive contract.");
      return parsed.data;
    });
    await withLock(STORAGE_LOCK, async () => {
      const current = await readOutbox();
      const existingIds = new Set(current.entries.map((entry) => entry.record.id));
      if (records.some((record) => existingIds.has(record.id)) || new Set(records.map((record) => record.id)).size !== records.length) {
        throw new Error("A source-record capture identifier was reused.");
      }
      await writeOutbox({
        version: 1,
        entries: [...current.entries, ...records.map((record) => ({ record, attempts: 0, nextAttemptAt: 0 }))],
      });
    });
  } catch (cause) {
    throw new SourceRecordPersistenceError(
      "The original extraction could not be saved. Collection stopped so it is not silently discarded.",
      { cause },
    );
  }
}

export async function readSourceRecordSyncStatus(): Promise<SourceRecordSyncStatus> {
  return withLock(STORAGE_LOCK, async () => statusOf(await readOutbox()));
}

export function withSourceRecordSyncStatus(state: ExtensionSyncState, archive: SourceRecordSyncStatus): ExtensionSyncState {
  const errors = [state.lastError, archive.lastError].filter((value): value is string => Boolean(value));
  return {
    ...state,
    sourceRecordsPending: archive.pending,
    status: errors.length ? "error" : archive.pending > 0 && state.status === "idle" ? "pending" : state.status,
    ...(errors.length ? { lastError: errors.join(" · ") } : {}),
  };
}

/** This outbox is independent of projection resets and is removed only after a valid API ACK. */
export async function flushSourceRecordOutbox(options: {
  force?: boolean;
  now?: () => Date;
  fetcher?: SyncFetcher;
  baseUrl?: string;
} = {}): Promise<SourceRecordSyncStatus> {
  const now = options.now ?? (() => new Date());
  return withLock(FLUSH_LOCK, async () => {
    const attempted = new Set<string>();
    while (attempted.size < MAX_RECORDS_PER_FLUSH) {
      const entry = await withLock(STORAGE_LOCK, async () => (await readOutbox()).entries.find((candidate) =>
        !attempted.has(candidate.record.id) && (options.force || candidate.nextAttemptAt <= now().getTime())));
      if (!entry) break;
      attempted.add(entry.record.id);
      try {
        await ingestSourceRecord(entry.record, options);
        await withLock(STORAGE_LOCK, async () => {
          const current = await readOutbox();
          await writeOutbox({ ...current, entries: current.entries.filter((candidate) => !sameRecord(candidate.record, entry.record)) });
        });
      } catch (error) {
        await withLock(STORAGE_LOCK, async () => {
          const current = await readOutbox();
          await writeOutbox({
            ...current,
            entries: current.entries.map((candidate) => !sameRecord(candidate.record, entry.record) ? candidate : {
              ...candidate,
              attempts: candidate.attempts + 1,
              nextAttemptAt: now().getTime() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(candidate.attempts, 6)),
              lastError: error instanceof Error ? error.message : "The source-record archive could not be reached.",
            }),
          });
        });
        // A failing endpoint should cost one request timeout, not a timeout for every capture.
        break;
      }
    }
    return readSourceRecordSyncStatus();
  });
}

function sameRecord(left: SourceRecordInput, right: SourceRecordInput): boolean {
  return left.id === right.id && JSON.stringify(left) === JSON.stringify(right);
}

function statusOf(outbox: SourceRecordOutbox): SourceRecordSyncStatus {
  const lastError = outbox.entries.find((entry) => entry.lastError)?.lastError;
  return { pending: outbox.entries.length, ...(lastError ? { lastError } : {}) };
}

async function withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) throw new SourceRecordPersistenceError("This browser cannot safely coordinate the source-record archive.");
  return navigator.locks.request(name, { mode: "exclusive" }, operation);
}

function readOutbox(): Promise<SourceRecordOutbox> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([SOURCE_RECORD_OUTBOX_KEY], (values) => {
      const error = chrome.runtime.lastError;
      if (error) { reject(new SourceRecordPersistenceError("The pending source records could not be read.")); return; }
      const value: unknown = values[SOURCE_RECORD_OUTBOX_KEY];
      if (value === undefined) { resolve({ version: 1, entries: [] }); return; }
      if (!isOutbox(value)) {
        reject(new SourceRecordPersistenceError("The source-record outbox is invalid. Its stored contents were preserved."));
        return;
      }
      resolve(value);
    });
  });
}

function isOutbox(value: unknown): value is SourceRecordOutbox {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
    !("entries" in value) || !Array.isArray(value.entries)) return false;
  const ids = new Set<string>();
  return value.entries.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("record" in entry) ||
      !("attempts" in entry) || !Number.isSafeInteger(entry.attempts) || Number(entry.attempts) < 0 ||
      !("nextAttemptAt" in entry) || typeof entry.nextAttemptAt !== "number" || !Number.isFinite(entry.nextAttemptAt) ||
      ("lastError" in entry && typeof entry.lastError !== "string")) return false;
    const parsed = sourceRecordInputSchema.safeParse(entry.record);
    if (!parsed.success || ids.has(parsed.data.id)) return false;
    ids.add(parsed.data.id);
    return true;
  });
}

function writeOutbox(outbox: SourceRecordOutbox): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [SOURCE_RECORD_OUTBOX_KEY]: outbox }, () => {
      const error = chrome.runtime.lastError;
      if (error) { reject(new SourceRecordPersistenceError("The pending source records could not be saved.")); return; }
      resolve();
    });
  });
}
