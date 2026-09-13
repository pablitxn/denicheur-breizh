import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearApiCollectedData: vi.fn(),
  clearRecordsAndSyncQueue: vi.fn(),
  flushEvaluationQueue: vi.fn(),
  enqueueDefaultPlanEvaluation: vi.fn(),
  flushQueuedIngestion: vi.fn(),
  loadCrawlerState: vi.fn(),
  loadExtensionSyncState: vi.fn(),
  reconcileStoredCrawlerState: vi.fn(),
  refreshDefaultPlanCache: vi.fn(),
  flushSourceRecordOutbox: vi.fn(),
  readSourceRecordSyncStatus: vi.fn(),
}));

vi.mock("../storage/chromeStorage", () => ({
  clearRecordsAndSyncQueue: mocks.clearRecordsAndSyncQueue,
  loadCrawlerState: mocks.loadCrawlerState,
}));
vi.mock("./api", () => ({ clearApiCollectedData: mocks.clearApiCollectedData }));
vi.mock("./storage", () => ({ loadExtensionSyncState: mocks.loadExtensionSyncState }));
vi.mock("./syncService", () => ({
  enqueueDefaultPlanEvaluation: mocks.enqueueDefaultPlanEvaluation,
  flushEvaluationQueue: mocks.flushEvaluationQueue,
  flushQueuedIngestion: mocks.flushQueuedIngestion,
  reconcileStoredCrawlerState: mocks.reconcileStoredCrawlerState,
  refreshDefaultPlanCache: mocks.refreshDefaultPlanCache,
}));
vi.mock("./sourceRecordOutbox", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sourceRecordOutbox")>(),
  flushSourceRecordOutbox: mocks.flushSourceRecordOutbox,
  readSourceRecordSyncStatus: mocks.readSourceRecordSyncStatus,
}));

import {
  ITERATION_RESET_TIMEOUT_MS,
  resetExtensionIteration,
  scheduleExtensionSync,
  queueDefaultPlanEvaluation,
} from "./controller";

const idleSyncState = {
  version: 2 as const,
  status: "idle" as const,
  queue: [],
  syncedFingerprints: {},
  activePlan: { status: "unknown" as const },
  evaluationQueue: [],
  activeRecipe: { status: "unknown" as const },
};

describe("coordinated iteration reset", () => {
  beforeEach(() => {
    mocks.flushSourceRecordOutbox.mockReset().mockResolvedValue({ pending: 0 });
    mocks.readSourceRecordSyncStatus.mockReset().mockResolvedValue({ pending: 0 });
    mocks.clearRecordsAndSyncQueue.mockReset().mockResolvedValue(undefined);
    mocks.clearApiCollectedData.mockReset().mockResolvedValue({
      listings: 0,
      runs: 0,
      runListings: 0,
      evaluations: 0,
    });
    mocks.loadExtensionSyncState.mockReset().mockResolvedValue(idleSyncState);
    mocks.reconcileStoredCrawlerState.mockReset().mockResolvedValue(idleSyncState);
    mocks.refreshDefaultPlanCache.mockReset().mockResolvedValue(idleSyncState);
    mocks.flushQueuedIngestion.mockReset().mockResolvedValue(idleSyncState);
    mocks.flushEvaluationQueue.mockReset().mockResolvedValue(idleSyncState);
    mocks.enqueueDefaultPlanEvaluation.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs the catalog, queues evaluations, and resets while the independent upload is still pending", async () => {
    let releaseUpload!: (status: { pending: number }) => void;
    const upload = new Promise<{ pending: number }>((resolve) => { releaseUpload = resolve; });
    mocks.flushSourceRecordOutbox.mockReturnValue(upload);
    mocks.readSourceRecordSyncStatus.mockResolvedValue({ pending: 1 });
    const entry = { key: "evaluation-1", status: "polling" };
    mocks.enqueueDefaultPlanEvaluation.mockResolvedValue(entry);
    mocks.loadExtensionSyncState.mockResolvedValue({ ...idleSyncState, evaluationQueue: [entry] });

    const sync = scheduleExtensionSync();
    try {
      await vi.waitFor(() => expect(mocks.flushEvaluationQueue).toHaveBeenCalledOnce());
      expect(await sync).toMatchObject({ ok: true, catalogOk: true, state: { sourceRecordsPending: 1 } });
      expect(await queueDefaultPlanEvaluation({ runId: "run-1", locale: "es" })).toMatchObject({ ok: true });
      expect(await resetExtensionIteration()).toMatchObject({ ok: true });
      expect(mocks.clearRecordsAndSyncQueue).toHaveBeenCalledOnce();
      expect(mocks.clearApiCollectedData).toHaveBeenCalledOnce();
      expect(mocks.flushSourceRecordOutbox).toHaveBeenCalledOnce();
    } finally {
      releaseUpload({ pending: 0 });
      await sync;
      await scheduleExtensionSync();
    }
  });

  it("keeps archive errors visible without failing an accepted evaluation or a completed reset", async () => {
    const archiveError = "Original capture remains queued offline";
    mocks.readSourceRecordSyncStatus.mockResolvedValue({ pending: 1, lastError: archiveError });
    mocks.flushSourceRecordOutbox.mockResolvedValue({ pending: 1, lastError: archiveError });
    const entry = { key: "evaluation-1", status: "polling" };
    mocks.enqueueDefaultPlanEvaluation.mockResolvedValue(entry);
    mocks.loadExtensionSyncState.mockResolvedValue({ ...idleSyncState, evaluationQueue: [entry] });

    expect(await scheduleExtensionSync()).toMatchObject({
      ok: false, catalogOk: true, error: archiveError,
      state: { status: "error", sourceRecordsPending: 1, lastError: archiveError },
    });
    const evaluation = await queueDefaultPlanEvaluation({ runId: "run-1", locale: "es" });
    expect(evaluation).toMatchObject({ ok: true, catalogOk: true, state: { lastError: archiveError } });
    expect(evaluation.error).toBeUndefined();
    const reset = await resetExtensionIteration();
    expect(reset).toMatchObject({ ok: true, state: { status: "error", lastError: archiveError } });
    expect(reset.error).toBeUndefined();
    expect(mocks.clearRecordsAndSyncQueue).toHaveBeenCalledOnce();
    expect(mocks.clearApiCollectedData).toHaveBeenCalledOnce();
  });

  it("aborts maintenance before the outer CLI callback deadline", async () => {
    vi.useFakeTimers();
    let maintenanceSignal: AbortSignal | undefined;
    mocks.clearApiCollectedData.mockImplementation(({ signal }: { signal?: AbortSignal }) => {
      maintenanceSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const reset = resetExtensionIteration();
    const timeoutExpectation = expect(reset).rejects.toMatchObject({ code: "RESET_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(ITERATION_RESET_TIMEOUT_MS);

    await timeoutExpectation;
    expect(maintenanceSignal?.aborted).toBe(true);
    expect(mocks.clearRecordsAndSyncQueue).toHaveBeenCalledOnce();
  });

  it("does not mutate storage when the caller deadline has already expired", async () => {
    await expect(resetExtensionIteration(Date.now() - 1))
      .rejects.toMatchObject({ code: "RESET_TIMEOUT" });

    expect(mocks.clearRecordsAndSyncQueue).not.toHaveBeenCalled();
    expect(mocks.clearApiCollectedData).not.toHaveBeenCalled();
  });

  it("does not start a mutating phase when an active sync resolves after the effective deadline", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-18T14:00:00.000Z");
    vi.setSystemTime(startedAt);
    let releaseSync!: (state: typeof idleSyncState) => void;
    mocks.flushQueuedIngestion.mockImplementation(() => new Promise((resolve) => {
      releaseSync = resolve;
    }));

    const sync = scheduleExtensionSync();
    await vi.waitFor(() => expect(mocks.flushQueuedIngestion).toHaveBeenCalledOnce());
    const reset = resetExtensionIteration(startedAt.getTime() + 2_000);
    const timeoutExpectation = expect(reset).rejects.toMatchObject({ code: "RESET_TIMEOUT" });

    vi.setSystemTime(startedAt.getTime() + 1_500);
    releaseSync(idleSyncState);
    await sync;
    await timeoutExpectation;

    expect(mocks.clearRecordsAndSyncQueue).not.toHaveBeenCalled();
    expect(mocks.clearApiCollectedData).not.toHaveBeenCalled();
  });
});
