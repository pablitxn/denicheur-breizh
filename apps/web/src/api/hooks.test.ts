import { describe, expect, it } from "vitest";
import { executionPollingInterval, isExecutionTerminal } from "./hooks";

describe("evaluation execution polling", () => {
  it("polls queued and running executions every two seconds", () => {
    expect(executionPollingInterval("queued")).toBe(2_000);
    expect(executionPollingInterval("running")).toBe(2_000);
  });

  it("stops polling every terminal execution state", () => {
    for (const status of ["completed", "partial", "failed", "cancelled"] as const) {
      expect(isExecutionTerminal(status)).toBe(true);
      expect(executionPollingInterval(status)).toBe(false);
    }
  });
});
