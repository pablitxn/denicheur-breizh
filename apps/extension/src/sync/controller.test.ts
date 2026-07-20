import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearApiCollectedData: vi.fn(),
  clearRecordsAndSyncQueue: vi.fn(),
  flushEvaluationQueue: vi.fn(),
  flushQueuedIngestion: vi.fn(),
  loadCrawlerState: vi.fn(),
  loadExtensionSyncState: vi.fn(),
  reconcileStoredCrawlerState: vi.fn(),
  refreshDefaultPlanCache: vi.fn(),
}));

vi.mock("../storage/chromeStorage", () => ({
  clearRecordsAndSyncQueue: mocks.clearRecordsAndSyncQueue,
  loadCrawlerState: mocks.loadCrawlerState,
}));
vi.mock("./api", () => ({ clearApiCollectedData: mocks.clearApiCollectedData }));
vi.mock("./storage", () => ({ loadExtensionSyncState: mocks.loadExtensionSyncState }));
vi.mock("./syncService", () => ({
  flushEvaluationQueue: mocks.flushEvaluationQueue,
  flushQueuedIngestion: mocks.flushQueuedIngestion,
  reconcileStoredCrawlerState: mocks.reconcileStoredCrawlerState,
  refreshDefaultPlanCache: mocks.refreshDefaultPlanCache,
}));

import {
  ITERATION_RESET_TIMEOUT_MS,
  resetExtensionIteration,
  scheduleExtensionSync,
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
  });

  afterEach(() => {
    vi.useRealTimers();
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
