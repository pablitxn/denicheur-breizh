import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRequestSchema, dataFields, observationInputSchema } from "@denicheur-breizh/collector-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureProvider, ProviderStrategyRegistry } from "./adapter.js";
import { readConfig } from "./config.js";
import { createProviderStrategyRegistry } from "./runtime.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";

const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/1";
const resources: Array<{ store: CollectorStore; worker: CaptureWorker; directory: string }> = [];
afterEach(async () => { for (const { store, worker, directory } of resources.splice(0)) { await worker.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } });
function provider(strategy: string, model: string): CaptureProvider {
  return { id: "firecrawl", strategy, model, configured: true, step: vi.fn().mockResolvedValue({
    observations: [observationInputSchema.parse({ url, detailStatus: "captured", data: { title: "Maison" }, absentFields: dataFields.filter(field => field !== "title"), evidence: [{ url, kind: "page", text: "Fixture detail: Maison; other fields absent." }] })],
    nextPages: [], exhausted: false, warnings: [], usage: { amount: 7, unit: "credits" },
  }) };
}
function fixture(base: CaptureProvider, registry?: ProviderStrategyRegistry) {
  const directory = mkdtempSync(join(tmpdir(), "collector-strategy-"));
  const store = new CollectorStore(":memory:", directory);
  const worker = new CaptureWorker(store, new Map([[base.id, base]]), readConfig({ COLLECTOR_DATA_DIR: directory, COLLECTOR_TEST_MODE: "1" }), registry);
  resources.push({ store, worker, directory });
  return { store, worker };
}

describe("immutable capture strategy and model", () => {
  it("registers the versioned Firecrawl strategies and can recreate the exact saved xAI model without making a request", () => {
    const registry = createProviderStrategyRegistry(readConfig({ COLLECTOR_XAI_MODEL: "new-default-model" }));
    expect(registry.choices("firecrawl").map(choice => choice.id)).toEqual(["firecrawl-agent-scrape-v1", "firecrawl-agent-native-v2", "firecrawl-agent-expanded-v3"]);
    expect(registry.resolve("xai", "xai-web-search-v1", "saved-model").model).toBe("saved-model");
    expect(registry.resolve("firecrawl", "firecrawl-agent-native-v2").strategy).toBe("firecrawl-agent-native-v2");
    expect(() => registry.resolve("xai", "firecrawl-agent-native-v2")).toThrow("selected strategy");
  });

  it.each(["firecrawl-agent-native-v2", "firecrawl-agent-expanded-v3"] as const)("dispatches an explicitly selected %s and persists that selection", async selectedStrategy => {
    const v1 = provider("firecrawl-agent-scrape-v1", "spark-2"), v2 = provider(selectedStrategy, "spark-2");
    const registry: ProviderStrategyRegistry = { resolve: (_id, strategy) => strategy === v2.strategy ? v2 : v1, choices: () => [{ id: v1.strategy, label: "V1" }, { id: v2.strategy, label: "V2" }] };
    const { store, worker } = fixture(v1, registry);
    const request = captureRequestSchema.parse({ provider: "firecrawl", strategy: selectedStrategy, mode: "urls", name: "Selected strategy", urls: [url] });
    const run = worker.create(request, "native"); await worker.drain();
    expect(store.getRun(run.id)).toMatchObject({ strategy: selectedStrategy, model: "spark-2", request: { strategy: selectedStrategy } });
    expect(v2.step).toHaveBeenCalledTimes(1);
    expect(v1.step).not.toHaveBeenCalled();
    expect(worker.metadata().providers[0]?.strategies).toHaveLength(2);
  });

  it("resumes the saved strategy/model and same remote operation after defaults change", async () => {
    const historical = provider("firecrawl-agent-scrape-v1", "historical-model");
    const current = provider("firecrawl-agent-native-v2", "current-model");
    const resolve = vi.fn<ProviderStrategyRegistry["resolve"]>().mockImplementation((_id, strategy, model) => strategy === historical.strategy && model === historical.model ? historical : current);
    const { store, worker } = fixture(current, { resolve, choices: () => [{ id: current.strategy, label: "Current" }] });
    const request = captureRequestSchema.parse({ provider: "firecrawl", mode: "urls", name: "Old default", urls: [url] });
    const { run } = store.createRun(request, "old", historical.strategy, historical.model);
    const work = store.nextWork(run.id)!, operation = store.startOperation(run, work, 100);
    store.usage(operation, { amount: 2, unit: "credits", final: false });
    store.updateRun(run.id, { status: "interrupted", remoteJobId: "saved-job", activeWork: work });
    worker.resume(run.id); await worker.drain();
    expect(resolve).toHaveBeenCalledWith("firecrawl", historical.strategy, historical.model);
    expect(historical.step).toHaveBeenCalledWith(expect.objectContaining({ remoteJobId: "saved-job" }));
    expect(current.step).not.toHaveBeenCalled();
    expect(store.getRun(run.id)).toMatchObject({ strategy: historical.strategy, model: historical.model, cost: 7 });
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(1);
  });

  it("refuses silently replacing an unavailable saved model before dispatch", () => {
    const current = provider("firecrawl-agent-scrape-v1", "current-model");
    const { store, worker } = fixture(current);
    const request = captureRequestSchema.parse({ provider: "firecrawl", mode: "urls", name: "Historical", urls: [url] });
    const { run } = store.createRun(request, "unavailable", current.strategy, "old-model");
    store.updateRun(run.id, { status: "interrupted" });
    expect(() => worker.resume(run.id)).toThrow("cannot silently change models");
    expect(current.step).not.toHaveBeenCalled();
    expect(store.getRun(run.id).model).toBe("old-model");
  });
});
