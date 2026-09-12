import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRequestSchema, dataFields, observationInputSchema } from "@denicheur-breizh/collector-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type CaptureProvider, type ProviderStepContext, type ProviderStepResult } from "./adapter.js";
import { readConfig } from "./config.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";

const listing = "https://www.leboncoin.fr/ad/ventes_immobilieres/1";
const search = "https://www.leboncoin.fr/recherche?category=9&locations=Rennes";
const resources: Array<{ store: CollectorStore; worker: CaptureWorker; directory: string }> = [];
afterEach(async () => { for (const { store, worker, directory } of resources.splice(0)) { await worker.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } });
function result(amount = 1): ProviderStepResult {
  return { observations: [observationInputSchema.parse({ url: listing, detailStatus: "captured", data: { title: "Maison" }, absentFields:dataFields.filter(field=>field!=="title"), evidence: [{ url: listing, text: "Maison", kind: "page" }] })], nextPages: [], exhausted: false, usage: { amount, unit: "credits" }, warnings: [] };
}
function fixture(id: "firecrawl" | "xai" = "firecrawl", mode: "urls" | "search" = "urls") {
  const directory = mkdtempSync(join(tmpdir(), "collector-worker-"));
  const store = new CollectorStore(":memory:", directory);
  const step = vi.fn<(context: ProviderStepContext) => Promise<ProviderStepResult>>();
  const cancel = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const provider: CaptureProvider = { id, model: "fixture", strategy: "fixture", configured: true, step, cancel };
  const config = readConfig({ COLLECTOR_DATA_DIR: directory, COLLECTOR_TEST_MODE: "1" });
  const worker = new CaptureWorker(store, new Map([[id, provider]]), config);
  resources.push({ store, worker, directory });
  const request = captureRequestSchema.parse({ provider: id, mode, name: "Fixture", urls: [listing], ...(mode === "search" ? { searchUrl: search } : {}) });
  return { store, worker, config, step, cancel, request, provider };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("worker recovery and bounded spending", () => {
  it("automatically resumes saved remote polling after graceful shutdown without cancelling or recharging the job", async () => {
    const { store, worker, config, step, cancel, request, provider } = fixture();
    const entered = deferred();
    step.mockImplementationOnce(async ctx => {
      await ctx.onRemoteJob("shutdown-agent");
      await ctx.onUsage({ amount: 2, unit: "credits", final: false });
      entered.resolve();
      await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new ProviderError("provider_cancelled", "Polling interrupted.", true);
    });
    const run = worker.create(request, "shutdown"); await entered.promise;
    await worker.stop();
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted", remoteJobId: "shutdown-agent", cost: 2, costUnknown: true });
    expect(cancel).not.toHaveBeenCalled();
    step.mockImplementationOnce(async ctx => { expect(ctx.remoteJobId).toBe("shutdown-agent"); return result(9); });
    const restarted = new CaptureWorker(store, new Map([[provider.id, provider]]), config);
    resources.find(value => value.store === store)!.worker = restarted;
    restarted.start(); await restarted.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", cost: 9, costUnknown: false });
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(1);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("keeps user cancellation stopped across recovery instead of treating it as graceful shutdown", async () => {
    const { store, worker, step, cancel, request } = fixture();
    const entered = deferred();
    step.mockImplementationOnce(async ctx => {
      await ctx.onRemoteJob("cancelled-agent"); entered.resolve();
      await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new ProviderError("provider_cancelled", "User cancelled.", true);
    });
    const run = worker.create(request, "user-cancel"); await entered.promise;
    await worker.cancel(run.id); await worker.drain();
    store.recover();
    expect(store.getRun(run.id).status).toBe("cancelled");
    expect(store.runnable("firecrawl")).toBeUndefined();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("cancelled-agent");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("cancels a job ID that arrives after user cancellation and accounts a late result exactly once", async () => {
    const { store, worker, step, cancel, request } = fixture();
    const entered = deferred(), release = deferred();
    step.mockImplementationOnce(async ctx => {
      entered.resolve(); await release.promise;
      await ctx.onRemoteJob("late-agent");
      await ctx.onUsage({ amount: 4, unit: "credits", final: true });
      return result(4);
    });
    const run = worker.create(request, "late-cancel"); await entered.promise;
    await worker.cancel(run.id); release.resolve(); await worker.drain();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("late-agent");
    expect(store.getRun(run.id)).toMatchObject({ status: "cancelled", cost: 4, costUnknown: false });
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(1);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("reconciles the same remote job through unknown usage and an exhausted budget, without double charging its cumulative total", async () => {
    const { store, worker, config, step, request } = fixture();
    step.mockImplementationOnce(async ctx => { await ctx.onRemoteJob("saved-agent"); await ctx.onUsage({ amount: 2, unit: "credits" }); throw new ProviderError("provider_job_interrupted", "Polling stopped.", true); });
    const run = worker.create(request, "resume"); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted", remoteJobId: "saved-agent", cost: 2, costUnknown: true });
    config.firecrawlBudget = 2;
    step.mockImplementationOnce(async ctx => { expect(ctx.remoteJobId).toBe("saved-agent"); return result(7); });
    worker.resume(run.id); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", cost: 7, costUnknown: false });
    expect(store.getRun(run.id).remoteJobId).toBeUndefined();
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(1);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("allows cancelling a recoverable job after polling already stopped", async () => {
    const { store, worker, step, cancel, request } = fixture();
    step.mockImplementationOnce(async ctx => { await ctx.onRemoteJob("saved-agent"); throw new ProviderError("provider_job_interrupted", "Polling stopped.", true); });
    const run = worker.create(request, "cancel"); await worker.drain();
    await worker.cancel(run.id);
    expect(cancel).toHaveBeenCalledWith("saved-agent");
    expect(store.getRun(run.id)).toMatchObject({ status: "cancelled", remoteJobId: "saved-agent", costUnknown: true });
  });

  it("clears a terminal failed remote job so an explicit retry creates genuinely new work", async () => {
    const { store, worker, step, request } = fixture();
    step.mockImplementationOnce(async ctx => { await ctx.onRemoteJob("failed-agent"); await ctx.onUsage({ amount: 3, unit: "credits" }); throw new ProviderError("provider_failed", "The remote job failed."); });
    const run = worker.create(request, "terminal"); await worker.drain();
    expect(store.getRun(run.id).remoteJobId).toBeUndefined();
    step.mockImplementationOnce(async ctx => { expect(ctx.remoteJobId).toBeUndefined(); return result(5); });
    worker.resume(run.id); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", cost: 8 });
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(2);
  });

  it.each(["failed", "pending", "omitted"] as const)("makes %s detail work available on explicit resume", async status => {
    const { store, worker, step, request } = fixture();
    const initial = result();
    if (status === "omitted") initial.observations = [];
    else initial.observations[0]!.detailStatus = status;
    step.mockResolvedValueOnce(initial).mockResolvedValueOnce(result());
    const run = worker.create(request, status); await worker.drain();
    expect(store.getRun(run.id).status).toBe("partial");
    worker.resume(run.id); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", captured: 1, failed: 0 });
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("does not follow a repeated seed URL or accept its claimed end as full execution", async () => {
    const { store, worker, step, request } = fixture("firecrawl", "search");
    step.mockResolvedValueOnce({ ...result(), nextPages: [search], exhausted: true });
    const run = worker.create(request, "cycle"); await worker.drain();
    expect(step).toHaveBeenCalledTimes(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "partial", coverage: "incomplete" });
  });

  it("adapts a billed truncated discovery to URL-only work once and preserves every charge", async () => {
    const { store, worker, step, request } = fixture("xai", "search");
    step.mockImplementationOnce(async ctx => { await ctx.onUsage({ amount: 0.1, unit: "usd" }); throw new ProviderError("provider_output_truncated", "Too much output."); });
    step.mockImplementationOnce(async ctx => { expect(ctx.work.cursor).toContain("compact-discovery-v1"); return { ...result(), exhausted: true, usage: { amount: 0.2, unit: "usd" } }; });
    const run = worker.create(request, "compact"); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", cost: 0.3, captured: 1 });
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("retains a partial limitation when compact discovery also truncates instead of repeating indefinitely", async () => {
    const { store, worker, step, request } = fixture("xai", "search");
    step.mockImplementation(async ctx => { await ctx.onUsage({ amount: 0.1, unit: "usd" }); throw new ProviderError("provider_output_truncated", "Too much output."); });
    const run = worker.create(request, "compact-failed"); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ status: "partial", cost: 0.2 });
    expect(step).toHaveBeenCalledTimes(2);
  });
});
