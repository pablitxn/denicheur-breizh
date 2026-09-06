// Synthetic temporary databases only; no providers. Timing is diagnostic, never a test threshold.
// node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/evaluationCounters.ts
// Optional BENCH_BASELINE_MODULE points at a local prior repository module.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DenicheurRepository } from "../../src/repository.js";
import { EXECUTION_NOW, executionResult, seedExecution } from "../fixtures/evaluationExecution.js";

const repositories = [{ name: "current", Repository: DenicheurRepository }];
if (process.env.BENCH_BASELINE_MODULE) repositories.unshift({
  name: "baseline", Repository: (await import(process.env.BENCH_BASELINE_MODULE)).DenicheurRepository,
});
for (const { name, Repository } of repositories) {
  for (const count of [100, 500, 1000]) {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-counter-bench-"));
    const repository = new Repository({ path: join(directory, "synthetic.sqlite"), now: () => new Date(EXECUTION_NOW) });
    try {
      seedExecution(repository, count);
      repository.claimNextEvaluationExecution("worker", 60_000);
      const results = Array.from({ length: count }, (_, index) => ({
        ...executionResult(index, index % 3 === 0 ? "review" : "relevant", index % 3 === 0),
        summary: "Synthetic completed evaluation. ".repeat(50),
      }));
      const checkpointMs: number[] = [];
      const start = performance.now();
      for (const result of results) {
        const checkpointStart = performance.now();
        repository.completeEvaluationExecutionItem("worker", result);
        checkpointMs.push(performance.now() - checkpointStart);
      }
      const completionMs = performance.now() - start;
      const finishStart = performance.now();
      const execution = repository.finishEvaluationExecution("execution", "worker")!;
      const finishMs = performance.now() - finishStart;
      if (execution.counters.processed !== count || execution.counters.failed !== Math.ceil(count / 3)) throw new Error("Unexpected synthetic counters");
      const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)];
      process.stdout.write(JSON.stringify({ name, count, completionMs, firstTenMedianMs: percentile(checkpointMs.slice(0, 10), 0.5),
        lastTenMedianMs: percentile(checkpointMs.slice(-10), 0.5), checkpointP95Ms: percentile(checkpointMs, 0.95), finishMs }) + "\n");
    } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
  }
}
