import { describe, expect, it } from "vitest";
import { updateStorageRefreshErrors } from "./storageRefresh";

describe("storage refresh error ownership", () => {
  it("does not clear a newer failure when an older request succeeds", () => {
    const errors = { run: "Current run failed", plan: "Plan unavailable" };

    expect(updateStorageRefreshErrors<"run" | "plan">(errors, ["run"], { run: 1, plan: 1 }, { run: 2, plan: 1 }))
      .toEqual(errors);
  });

  it("recovers only current requested fields while retaining unrelated failures", () => {
    expect(updateStorageRefreshErrors<"run" | "records" | "plan">(
      { run: "Run failed", records: "Records failed", plan: "Plan unavailable" },
      ["run", "records"],
      { run: 2, records: 1, plan: 1 },
      { run: 2, records: 2, plan: 1 },
    )).toEqual({ records: "Records failed", plan: "Plan unavailable" });
  });
});
