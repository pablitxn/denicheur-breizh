import { describe, expect, it, vi } from "vitest";
import { IDLE_RUN } from "../storage/chromeStorage";
import type { ScrapeRun } from "../lib/types";
import {
  hasLiveDashboardRunner,
  reconcileDashboardRun,
  withDashboardRunnerLease,
} from "./DashboardApp";

const FINISHED_AT = "2026-07-15T18:30:00.000Z";

function pausedRun(): ScrapeRun {
  return {
    ...IDLE_RUN,
    id: "paused-run",
    status: "paused-captcha",
    startedAt: "2026-07-15T18:00:00.000Z",
  };
}

describe("dashboard runner ownership recovery", () => {
  it("cancels a restored pause in every dashboard when no runner owner exists", () => {
    const persisted = pausedRun();

    const firstDashboard = reconcileDashboardRun(persisted, false, FINISHED_AT);
    const secondDashboard = reconcileDashboardRun(persisted, false, FINISHED_AT);

    expect(firstDashboard).toMatchObject({
      status: "cancelled",
      finishedAt: FINISHED_AT,
      message: { id: "run.interrupted" },
    });
    expect(secondDashboard).toEqual(firstDashboard);
  });

  it("preserves a pause when this dashboard still owns its runner", async () => {
    const persisted = pausedRun();
    const query = vi.fn();

    const hasLiveRunner = await hasLiveDashboardRunner(true, { query });
    const recovered = reconcileDashboardRun(persisted, hasLiveRunner, FINISHED_AT);

    expect(query).not.toHaveBeenCalled();
    expect(recovered).toBe(persisted);
  });

  it("preserves a pause observed from another dashboard while its runner lease is held", async () => {
    const persisted = pausedRun();
    const query = vi.fn(async () => ({
      held: [{ name: "denicheur:crawler:dashboard-runner", mode: "exclusive" as const }],
      pending: [],
    }));

    const hasLiveRunner = await hasLiveDashboardRunner(false, { query });
    const recovered = reconcileDashboardRun(persisted, hasLiveRunner, FINISHED_AT);

    expect(hasLiveRunner).toBe(true);
    expect(recovered).toBe(persisted);
  });

  it("treats an unavailable ownership snapshot as no live runner", async () => {
    const query = vi.fn(async () => {
      throw new Error("Lock query unavailable");
    });

    await expect(hasLiveDashboardRunner(false, { query })).resolves.toBe(false);
  });

  it("holds an exclusive lease for the operation and rejects a competing start", async () => {
    const operation = vi.fn(async () => "completed");
    const observedOptions: LockOptions[] = [];
    const grantedLockManager = {
      async request<T>(
        _name: string,
        options: LockOptions,
        callback: LockGrantedCallback<T>,
      ): Promise<T> {
        observedOptions.push(options);
        return callback({ name: "denicheur:crawler:dashboard-runner", mode: "exclusive" } as Lock);
      },
    };

    await expect(withDashboardRunnerLease(operation, grantedLockManager)).resolves.toBe("completed");
    expect(observedOptions).toEqual([{ ifAvailable: true }]);
    expect(operation).toHaveBeenCalledOnce();

    const deniedOperation = vi.fn(async () => "should-not-run");
    const deniedLockManager = {
      async request<T>(
        _name: string,
        _options: LockOptions,
        callback: LockGrantedCallback<T>,
      ): Promise<T> {
        return callback(null);
      },
    };

    await expect(withDashboardRunnerLease(deniedOperation, deniedLockManager))
      .rejects.toThrow("Another dashboard already owns the crawler run.");
    expect(deniedOperation).not.toHaveBeenCalled();
  });
});
