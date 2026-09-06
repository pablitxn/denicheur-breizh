import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DenicheurRepository } from "../src/repository.js";
import { EXECUTION_NOW, executionResult, seedExecution } from "./fixtures/evaluationExecution.js";

describe("durable execution counter contributions", () => {
  it("counts each checkpoint once, replaces previous contributions and preserves provider consumption", () => {
    const repository = new DenicheurRepository({ path: ":memory:", now: () => new Date(EXECUTION_NOW) });
    try {
      seedExecution(repository);
      repository.claimNextEvaluationExecution("worker", 60_000);
      const reservation = repository.reserveEvaluationProviderCall("execution", "worker", {
        providerCalls: 1, inputTokens: 100, outputTokens: 100, costMicroUsd: 10,
      });
      repository.settleEvaluationProviderCall("execution", "worker", reservation, {
        providerCalls: 1, inputTokens: 70, outputTokens: 30, costMicroUsd: 7,
      });
      const budget = repository.getEvaluationExecution("execution")!.budget;
      repository.completeEvaluationExecutionItem("worker", executionResult(0));
      repository.completeEvaluationExecutionItem("worker", executionResult(0));
      repository.completeEvaluationExecutionItem("worker", executionResult(0, "review", true));
      repository.completeEvaluationExecutionItem("worker", executionResult(1, "not-relevant"));
      expect(repository.getEvaluationExecution("execution")?.counters).toEqual({
        total: 3, processed: 2, relevant: 0, notRelevant: 1, review: 1, failed: 1,
      });
      repository.completeEvaluationExecutionItem("worker", executionResult(0));
      repository.completeEvaluationExecutionItem("worker", executionResult(2, "review", true));
      expect(repository.finishEvaluationExecution("execution", "worker")).toMatchObject({
        status: "partial", budget,
        counters: { total: 3, processed: 3, relevant: 1, notRelevant: 1, review: 1, failed: 1 },
      });
    } finally { repository.close(); }
  });

  it("rejects foreign items, plan mismatches, lost ownership and completion after cancellation atomically", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      seedExecution(repository);
      repository.claimNextEvaluationExecution("worker", 60_000);
      const before = repository.getEvaluationExecution("execution");
      expect(() => repository.completeEvaluationExecutionItem("worker", executionResult(999)))
        .toThrowError(expect.objectContaining({ code: "EVALUATION_ITEM_NOT_FOUND" }));
      expect(() => repository.completeEvaluationExecutionItem("worker", { ...executionResult(0), planVersion: 2 }))
        .toThrowError(expect.objectContaining({ code: "EVALUATION_PLAN_MISMATCH" }));
      expect(() => repository.completeEvaluationExecutionItem("foreign-worker", executionResult(0))).toThrow(/lease/);
      expect(repository.getEvaluationExecution("execution")).toEqual(before);
      repository.markEvaluationExecutionCancelled("execution", "worker");
      expect(() => repository.completeEvaluationExecutionItem("worker", executionResult(0))).toThrow(/lease/);
      expect(repository.getEvaluationExecution("execution")?.counters.processed).toBe(0);
      expect(repository.getEvaluationExecutionResults("execution")?.items).toEqual([]);
    } finally { repository.close(); }
  });

  it("does constant checkpoint work without reading or parsing previous result payloads", () => {
    const repository = new DenicheurRepository({ path: ":memory:" });
    try {
      seedExecution(repository, 200);
      repository.claimNextEvaluationExecution("worker", 60_000);
      for (let index = 0; index < 199; index += 1) repository.completeEvaluationExecutionItem("worker", executionResult(index));
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const parse = vi.spyOn(JSON, "parse");
      repository.completeEvaluationExecutionItem("worker", executionResult(199));
      expect(prepare.mock.calls).toHaveLength(4);
      expect(parse).not.toHaveBeenCalled();
      expect(prepare.mock.calls.map(([sql]) => sql).filter((sql) => /^\s*SELECT/.test(sql)).join("\n")).not.toContain("result_json");
      prepare.mockRestore(); parse.mockRestore();
      expect(repository.finishEvaluationExecution("execution", "worker")?.counters.processed).toBe(200);
    } finally { repository.close(); }
  });

  it("migrates persisted legacy result history once and continues with accurate deltas after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-counter-migration-"));
    const path = join(directory, "synthetic.sqlite");
    let repository = new DenicheurRepository({ path, now: () => new Date(EXECUTION_NOW) });
    try {
      seedExecution(repository);
      repository.claimNextEvaluationExecution("worker", 60_000);
      repository.completeEvaluationExecutionItem("worker", executionResult(0));
      repository.completeEvaluationExecutionItem("worker", executionResult(1, "review", true));
      repository.close();
      // Restore the pre-migration table shape while preserving real persisted checkpoints.
      const legacy = new DatabaseSync(path);
      try {
        legacy.exec(`DROP INDEX execution_items_counter_idx;
          ALTER TABLE evaluation_execution_items DROP COLUMN result_decision;
          ALTER TABLE evaluation_execution_items DROP COLUMN result_failed;
          DELETE FROM schema_migrations WHERE version = 11;
          UPDATE evaluation_executions SET counters_json = '{"total":3,"processed":0,"relevant":0,"notRelevant":0,"review":0,"failed":0}';`);
      } finally { legacy.close(); }
      repository = new DenicheurRepository({ path, now: () => new Date(EXECUTION_NOW) });
      expect(repository.getEvaluationExecution("execution")?.counters).toEqual({
        total: 3, processed: 2, relevant: 1, notRelevant: 0, review: 1, failed: 1,
      });
      repository.completeEvaluationExecutionItem("worker", executionResult(1, "not-relevant"));
      repository.completeEvaluationExecutionItem("worker", executionResult(2));
      expect(repository.finishEvaluationExecution("execution", "worker")).toMatchObject({
        status: "completed", counters: { total: 3, processed: 3, relevant: 2, notRelevant: 1, review: 0, failed: 0 },
      });
    } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
