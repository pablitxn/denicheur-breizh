import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRequestSchema } from "@denicheur-breizh/collector-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorStore } from "./store.js";

const resources: Array<{ store: CollectorStore; directory: string }> = [];
afterEach(() => { for (const { store, directory } of resources.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); } });
function fixture(provider: "firecrawl" | "xai" = "firecrawl") {
  const directory = mkdtempSync(join(tmpdir(), "collector-ledger-"));
  const store = new CollectorStore(":memory:", directory);
  resources.push({ store, directory });
  const request = captureRequestSchema.parse({ provider, mode: "urls", name: "Fixture", urls: ["https://www.leboncoin.fr/ad/ventes_immobilieres/1"] });
  const { run } = store.createRun(request, "test", "fixture", "fixture");
  const work = store.nextWork(run.id)!;
  return { store, run, work };
}

describe("cumulative operation ledger", () => {
  it("keeps the remaining remote allowance committed across progress and shutdown, releasing it only at terminal usage", () => {
    const { store, run, work } = fixture();
    const operation = store.startOperation(run, work, 1000);
    store.usage(operation, { amount: 2, unit: "credits", final: false });
    expect(store.budget("firecrawl", 1000, true, null)).toMatchObject({ spent: 2, reserved: 998, remaining: 0 });
    store.usage(operation, { amount: 3, unit: "credits", final: false });
    expect(store.budget("firecrawl", 1000, true, null)).toMatchObject({ spent: 3, reserved: 997, remaining: 0 });
    store.usage(operation, { amount: null, unit: "credits", final: false, detail: { lastReportedAmount: 3 } });
    expect(store.budget("firecrawl", 1000, true, null)).toMatchObject({ spent: 3, reserved: 997, remaining: 0, unknownCalls: 1 });
    store.usage(operation, { amount: 8, unit: "credits", final: true });
    expect(store.budget("firecrawl", 1000, true, null)).toMatchObject({ spent: 8, reserved: 0, remaining: 992, unknownCalls: 0 });
  });

  it("reuses the remote operation after reported or unknown intermediate usage without double counting", () => {
    const { store, run, work } = fixture();
    const operation = store.startOperation(run, work, 20);
    store.usage(operation, { amount: 2, unit: "credits" });
    expect(store.startOperation(run, work, 18, true)).toBe(operation);
    store.usage(operation, { amount: null, unit: "credits", detail: { lastReportedAmount: 2 } });
    expect(store.refresh(run.id)).toMatchObject({ cost: 2, costUnknown: true });
    expect(store.startOperation(run, work, 0, true)).toBe(operation);
    store.usage(operation, { amount: 7, unit: "credits" });
    expect(store.refresh(run.id)).toMatchObject({ cost: 7, costUnknown: false });
    expect(store.db.prepare("SELECT count(*) n FROM operations").get()?.n).toBe(1);
  });

  it("separates estimated balance deltas, retains them through uncertainty, then replaces them with reconciled charges", () => {
    const { store, run, work } = fixture();
    const operation = store.startOperation(run, work, 5);
    store.usage(operation, { amount: 5, unit: "credits", detail: { basis: "account_balance_delta", estimated: true } });
    expect(store.refresh(run.id)).toMatchObject({ cost: 0, costEstimated: 5, costUnknown: false });
    expect(store.budget("firecrawl", 20, true, null)).toMatchObject({ spent: 0, estimated: 5, remaining: 15 });
    store.usage(operation, { amount: null, unit: "credits" });
    expect(store.refresh(run.id)).toMatchObject({ cost: 0, costEstimated: 5, costUnknown: true });
    store.usage(operation, { amount: 6, unit: "credits", detail: { basis: "manual_reconciliation" } });
    expect(store.refresh(run.id)).toMatchObject({ cost: 6, costEstimated: 0, costUnknown: false });
    expect(store.budget("firecrawl", 20, true, null)).toMatchObject({ spent: 6, estimated: 0, remaining: 14 });
  });

  it("charges a genuinely new retry separately after the original operation was reconciled", () => {
    const { store, run, work } = fixture();
    const first = store.startOperation(run, work, 5);
    store.usage(first, { amount: 5, unit: "credits" });
    const second = store.startOperation(run, work, 5);
    expect(second).not.toBe(first);
    store.usage(second, { amount: 5, unit: "credits" });
    expect(store.refresh(run.id).cost).toBe(10);
  });

  it("marks a crashed unrecoverable paid request unknown without automatically queuing a duplicate", () => {
    const { store, run, work } = fixture("xai");
    store.startOperation(run, work, 0);
    store.setWorkStatus(work.id, "active");
    store.updateRun(run.id, { status: "running", activeWork: work });
    store.recover();
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted", costUnknown: true });
    expect(store.runnable("xai")).toBeUndefined();
    expect(store.unknownOperations()).toHaveLength(1);
  });

  it("queues read-only recovery of an interrupted saved remote job and keeps its ledger identity", () => {
    const { store, run, work } = fixture();
    const operation = store.startOperation(run, work, 20);
    store.usage(operation, { amount: 3, unit: "credits" });
    store.setWorkStatus(work.id, "failed");
    store.updateRun(run.id, { status: "interrupted", activeWork: work, remoteJobId: "saved-agent" });
    store.recover();
    expect(store.getRun(run.id)).toMatchObject({ status: "queued", remoteJobId: "saved-agent" });
    expect(store.nextWork(run.id)?.id).toBe(work.id);
    expect(store.startOperation(run, work, 0, true)).toBe(operation);
  });
});
