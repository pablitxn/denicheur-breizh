import { describe, expect, it } from "vitest";
import { IDLE_RUN, reconcileInterruptedRun } from "./chromeStorage";

describe("crawler run recovery", () => {
  it("marks a persisted active run as interrupted", () => {
    const run = reconcileInterruptedRun(
      { ...IDLE_RUN, id: "run-1", status: "collecting-details", startedAt: "2026-07-11T10:00:00.000Z" },
      "2026-07-11T10:10:00.000Z",
    );

    expect(run).toMatchObject({
      id: "run-1",
      status: "failed",
      finishedAt: "2026-07-11T10:10:00.000Z",
      error: "The dashboard closed before the crawl finished.",
    });
  });

  it("keeps terminal runs unchanged", () => {
    const completed = { ...IDLE_RUN, status: "completed" as const };
    expect(reconcileInterruptedRun(completed)).toBe(completed);
  });
});
