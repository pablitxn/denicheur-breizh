import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRequestSchema, dataFields, observationInputSchema, type CaptureObservation, type DataField } from "@denicheur-breizh/collector-contracts";
import type { CaptureProvider, ProviderStepContext, ProviderStrategyRegistry } from "./adapter.js";
import { readConfig } from "./config.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";
import { canonicalIdentity } from "./sources.js";
import { createRepair, mergeRepairFields, REPAIR_STRATEGY } from "./repair.js";

const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
const resources: Array<{ store: CollectorStore; worker: CaptureWorker; dir: string }> = [];
afterEach(async () => { for (const { store, worker, dir } of resources.splice(0)) { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } });

function fixture(fields: DataField[] = ["gesClass"]) {
  const dir = mkdtempSync(join(tmpdir(), "collector-repair-"));
  const config = readConfig({ COLLECTOR_DATA_DIR: dir, COLLECTOR_TEST_MODE: "1" });
  const store = new CollectorStore(config.dbPath, join(dir, "artifacts"));
  const step = vi.fn(async (context: ProviderStepContext) => ({ observations: [observationInputSchema.parse({ url, data: { title: "Unrequested replacement title", gesClass: "B" }, detailStatus: "captured", evidence: [{ url, text: "GES: B", kind: "page" }] })],
    nextPages: [], exhausted: false, warnings: [], usage: { amount: 5, unit: "credits" as const } }));
  const provider: CaptureProvider = { id: "firecrawl", configured: true, model: "synthetic", strategy: REPAIR_STRATEGY, step };
  const registry: ProviderStrategyRegistry = { resolve: () => provider, choices: () => [{ id: REPAIR_STRATEGY, label: "Repair" }] };
  const worker = new CaptureWorker(store, new Map([["firecrawl", provider]]), config, registry);
  resources.push({ store, worker, dir });
  const request = captureRequestSchema.parse({ name: "Original", provider: "firecrawl", mode: "urls", urls: [url] });
  const { run } = store.createRun(request, "original", "firecrawl-agent-expanded-v3", "spark-2");
  store.setWorkStatus(store.nextWork(run.id)!.id, "failed");
  const observation: CaptureObservation = { ...observationInputSchema.parse({ url, data: { title: "Original title" }, detailStatus: "failed", missingFields: fields,
    absentFields: dataFields.filter(field => field !== "title" && !fields.includes(field)), evidence: [{ url, text: "Original full detail; unspecified attributes absent.", kind: "page" }] }), ...canonicalIdentity("leboncoin", url),
    source: "leboncoin", provider: "firecrawl", runId: run.id, observedAt: new Date().toISOString() };
  store.saveObservation(observation); store.updateRun(run.id, { status: "partial" }); store.refresh(run.id);
  return { store, worker, step, run: store.getRun(run.id), observation };
}

const diagnosticRaw = (grade: string, markdown = "", sourceURL = url) => ({ success: true, data: { metadata: { sourceURL }, markdown,
  actions: { javascriptReturns: [{ value: { preparation: "leboncoin-detail-repair-v4", phase: "observe", blocked: false, url: sourceURL,
    fields: { energyClass: { value: grade, selected: true, selector: "[data-qa-id=criteria_item_energy_rate]", evidence: `Classe énergie: ${grade}; explicitly selected DOM value` } } } }] } } });

describe("targeted Firecrawl repairs", () => {
  it("previews only missing fields without writes, provider calls or spending", () => {
    const { store, worker, step, run } = fixture();
    const before = { run: store.getRun(run.id), events: store.events(run.id), observations: store.observations(run.id) };
    expect(worker.repairPlan(run.id)).toMatchObject({ eligible: true, total: 1, requiresCapture: 1, items: [{ listingId: "leboncoin:123456", fields: ["gesClass"], locallyResolved: [] }] });
    expect({ run: store.getRun(run.id), events: store.events(run.id), observations: store.observations(run.id) }).toEqual(before);
    expect(step).not.toHaveBeenCalled(); expect(worker.budget("firecrawl").spent).toBe(0);
  });

  it("offers an already filled but contradicted diagnostic as a read-only local repair and preserves both snapshots", async () => {
    const { store, worker, step, run, observation } = fixture([]);
    const original={...observation,data:{...observation.data,energyClass:"A"},detailStatus:"captured" as const,absentFields:observation.absentFields.filter(field=>field!=="energyClass")};
    store.saveObservation(original,{replaceSnapshot:true});store.updateRun(run.id,{status:"completed"});
    store.artifact(run.id,"firecrawl_scrape",diagnosticRaw("C"));
    const before={run:store.getRun(run.id),events:store.events(run.id),observation:store.observation(run.id,observation.id)};
    const plan=worker.repairPlan(run.id);
    expect(plan).toMatchObject({eligible:true,requiresCapture:0,items:[{fields:["energyClass"],locallyResolved:["energyClass"],fieldStates:{energyClass:{status:"unresolved",reason:expect.stringContaining("differs")}}}]});
    expect({run:store.getRun(run.id),events:store.events(run.id),observation:store.observation(run.id,observation.id)}).toEqual(before);
    const child=worker.repair(run.id,{fields:["energyClass"]},"correct-dpe"),duplicate=worker.repair(run.id,{fields:["energyClass"]},"correct-dpe");await worker.drain();
    expect(child.id).toBe(duplicate.id);expect(step).not.toHaveBeenCalled();expect(store.getRun(child.id)).toMatchObject({status:"completed",cost:0,captured:1});
    expect(store.observation(child.id,observation.id)).toMatchObject({data:{title:"Original title",energyClass:"C"},missingFields:[],fieldStates:{energyClass:{status:"observed"}}});
    expect(store.observation(run.id,observation.id)).toEqual(original);
  });
  it("surfaces source-proven partial images despite a previously filled snapshot, preserving values and their original timestamps", () => {
    const {store,worker,run,observation,step}=fixture([]);
    const urls=[1,2,3].map(i=>`https://img.leboncoin.fr/api/v1/lbcpb1/images/${i}.jpg`);
    const original={...observation,data:{...observation.data,imageUrls:urls},absentFields:observation.absentFields.filter(field=>field!=="imageUrls"),fieldStates:{imageUrls:{status:"observed" as const,reason:"Earlier image URLs were cited",evidence:[{url,kind:"page" as const,text:urls.join("\n")}]}}};
    store.saveObservation(original,{replaceSnapshot:true});store.updateRun(run.id,{status:"completed"});
    store.artifact(run.id,"firecrawl_scrape",{success:true,data:{metadata:{sourceURL:url},actions:{javascriptReturns:[{value:{preparation:"leboncoin-native-inventory-v5",phase:"observe",url,listingId:"123456",inventory:{listingId:"123456",images:{urls,declaredCount:12,observedCount:3,inventoryComplete:false}}}}]}}});
    const before={run:store.getRun(run.id),events:store.events(run.id),observation:store.observation(run.id,observation.id)};
    expect(worker.repairPlan(run.id)).toMatchObject({eligible:true,requiresCapture:1,items:[{fields:["imageUrls"],locallyResolved:[],fieldStates:{imageUrls:{status:"unresolved"}}}]});
    expect({run:store.getRun(run.id),events:store.events(run.id),observation:store.observation(run.id,observation.id)}).toEqual(before);
    // Use the store-level constructor so the assertion is about preparation, with no worker dispatch.
    const child=createRepair(store,run.id,{fields:["imageUrls"]},"partial-evidence","synthetic");
    const pending=store.observation(child.id,observation.id)!;
    expect(pending.data.imageUrls).toEqual(urls);expect(pending.missingFields).toContain("imageUrls");expect(pending.fieldStates?.imageUrls?.status).toBe("unresolved");
    expect(pending.fieldObservedAt?.imageUrls).toBe(original.observedAt);expect(store.getRun(child.id).pending).toBe(1);expect(step).not.toHaveBeenCalled();
    expect(store.observation(run.id,observation.id)).toEqual(original);
  });

  it("follows only explicit saved raw pointers for a local child's contradiction repair and retains their original ownership", async () => {
    const { store, worker, step, run, observation } = fixture(["features"]);
    const original={...observation,data:{...observation.data,energyClass:"A",description:"Cette maison dispose d'une cuisine ouverte."},absentFields:observation.absentFields.filter(field=>!["energyClass","description"].includes(field))};
    store.saveObservation(original,{replaceSnapshot:true});
    const rawId=store.artifact(run.id,"firecrawl_scrape",diagnosticRaw("C","## Description\nCette maison dispose d'une cuisine ouverte.\nVoir moins"));
    const first=worker.repair(run.id,{fields:["features"]},"local-features");await worker.drain();
    expect(store.observation(first.id,observation.id)?.data.energyClass).toBe("A");
    expect(worker.repairPlan(first.id)).toMatchObject({eligible:true,requiresCapture:0,items:[{fields:["energyClass"],locallyResolved:["energyClass"]}]});
    const before=store.observation(first.id,observation.id);
    const corrected=worker.repair(first.id,{fields:["energyClass"]},"local-linked-dpe");await worker.drain();
    expect(step).not.toHaveBeenCalled();expect(store.getRun(corrected.id).cost).toBe(0);
    expect(store.observation(corrected.id,observation.id)?.data).toMatchObject({title:"Original title",energyClass:"C",features:["Cette maison dispose d'une cuisine ouverte."]});
    expect(store.observation(first.id,observation.id)).toEqual(before);
    const event=store.events(corrected.id).find(item=>item.message==="repair_lineage")!;
    expect(store.readArtifact(corrected.id,event.artifactId!)).toMatchObject({payload:{supportingArtifacts:[{parentRunId:run.id,artifactId:rawId}]}});
    expect(worker.repairPlan(corrected.id).total).toBe(0);
  });

  it("does not reinterpret case, spacing or reordered proven features as conflicting source values", () => {
    const { store, worker, run, observation } = fixture([]);
    const original={...observation,data:{...observation.data,energyClass:" c ",features:["Terrasse","Balcon"]},absentFields:observation.absentFields.filter(field=>!["energyClass","features"].includes(field)),fieldStates:{features:{status:"observed" as const,reason:"Native features",evidence:[{url,kind:"page" as const,text:"Caractéristiques: Terrasse, Balcon"}]}}};
    store.saveObservation(original,{replaceSnapshot:true});
    store.artifact(run.id,"firecrawl_scrape",diagnosticRaw("C","## Les informations clés\nCaractéristiques\nBalcon, Terrasse\n## Localisation\nLannion"));
    expect(worker.repairPlan(run.id).total).toBe(0);
  });

  it("rejects foreign or malformed lineage pointers instead of searching other runs for corroboration", () => {
    const { store, worker, run, observation, step } = fixture([]);
    const owner=store.createRun(captureRequestSchema.parse({...run.request,provider:"xai"}),"foreign-xai","xai-web-search-v1","synthetic").run;
    store.saveObservation({...observation,runId:owner.id,provider:"xai"});
    const foreignId=store.artifact(owner.id,"firecrawl_scrape",diagnosticRaw("C"));
    const targets=[{listingId:observation.id,fields:["features"]}];
    const child=store.createRun(captureRequestSchema.parse({...run.request,repair:{parentRunId:run.id,targets}}),"child-pointer",REPAIR_STRATEGY,"synthetic").run;
    store.setWorkStatus(store.nextWork(child.id)!.id,"done");store.updateRun(child.id,{status:"completed"});
    store.saveObservation({...observation,runId:child.id,data:{...observation.data,energyClass:"A"},absentFields:observation.absentFields.filter(field=>field!=="energyClass")});
    store.artifact(child.id,"repair_lineage",{parentRunId:run.id,provider:"firecrawl",source:"leboncoin",targets,supportingArtifacts:[{parentRunId:owner.id,artifactId:foreignId},{parentRunId:child.id,artifactId:"cycle"}]});
    expect(worker.repairPlan(child.id).total).toBe(0);expect(step).not.toHaveBeenCalled();
  });

  it("creates one linked paid run on duplicate submission and preserves the original and unselected fields", async () => {
    const { store, worker, step, run, observation } = fixture();
    const a = worker.repair(run.id, {}, "same-repair"), b = worker.repair(run.id, {}, "same-repair");
    expect(a.id).toBe(b.id); await worker.drain();
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]![0].work.repairFields).toEqual(["gesClass"]);
    expect(store.observation(run.id, observation.id)).toEqual(observation);
    expect(store.getRun(run.id)).toEqual(run);
    expect(store.observation(a.id, observation.id)).toMatchObject({ data: { title: "Original title", gesClass: "B" }, detailStatus: "captured", missingFields: [], fieldStates: { gesClass: { status: "observed", observedAt: expect.any(String) } } });
    expect(store.observation(a.id,observation.id)?.fieldObservedAt?.title).toBe(observation.observedAt);
    expect(store.observation(a.id,observation.id)?.fieldObservedAt?.gesClass).toBe(store.observation(a.id,observation.id)?.fieldStates?.gesClass?.observedAt);
    expect(store.getRun(a.id)).toMatchObject({ cost: 5, coverage: "unknown", request: { mode: "urls", repair: { parentRunId: run.id, targets: [{ listingId: observation.id, fields: ["gesClass"] }] } } });
    expect(store.events(a.id).some(event => event.message === "repair_lineage")).toBe(true);
  });

  it("can repair a field subset while retaining other gaps", async () => {
    const { store, worker, step, run, observation } = fixture(["gesClass", "landSurfaceM2"]);
    const child = worker.repair(run.id, { fields: ["gesClass"] }, "ges-only"); await worker.drain();
    expect(step.mock.calls[0]![0].work.repairFields).toEqual(["gesClass"]);
    expect(store.observation(child.id, observation.id)).toMatchObject({ data: { gesClass: "B" }, detailStatus: "failed", missingFields: ["landSurfaceM2"] });
    expect(store.getRun(child.id).coverage).toBe("incomplete");
  });

  it("resumes with only fields still unresolved and preserves earlier field observation times", async () => {
    const { store, worker, step, run, observation } = fixture(["gesClass", "landSurfaceM2"]);
    const child = worker.repair(run.id, {}, "resume-targets"); await worker.drain();
    const first = store.observation(child.id, observation.id)!;
    step.mockImplementationOnce(async () => ({ observations: [observationInputSchema.parse({ url, data: { landSurfaceM2: 240 }, detailStatus: "captured", evidence: [{ url, kind: "page", text: "Surface du terrain: 240 m²" }] })],
      nextPages: [], exhausted: false, warnings: [], usage: { amount: 5, unit: "credits" as const } }));
    worker.resume(child.id); await worker.drain();
    expect(step.mock.calls[1]![0].work.repairFields).toEqual(["landSurfaceM2"]);
    expect(store.observation(child.id, observation.id)).toMatchObject({ data: { gesClass: "B", landSurfaceM2: 240 }, detailStatus: "captured", fieldStates: { gesClass: { observedAt: first.fieldStates!.gesClass!.observedAt } } });
    expect(store.getRun(child.id).cost).toBe(10);
  });

  it("retains all baseline data and state evidence when the provider omits the requested listing", async () => {
    const { store, worker, step, run, observation } = fixture();
    step.mockImplementationOnce(async () => ({ observations: [], nextPages: [], exhausted: false, warnings: [], usage: { amount: 5, unit: "credits" as const } }));
    const child = worker.repair(run.id, {}, "omitted-target"); await worker.drain();
    const after = store.observation(child.id, observation.id)!;
    expect(after.data).toEqual(observation.data); expect(after.evidence).toEqual(observation.evidence);
    expect(after.missingFields).toEqual(["gesClass"]); expect(after.detailStatus).toBe("failed");
    expect(store.getRun(child.id).cost).toBe(5);
  });

  it("does not expand the selected fields when replaying a linked repair's stored response", async () => {
    const { store, worker, run, observation } = fixture();
    const child = worker.repair(run.id, {}, "replay-scope"); await worker.drain();
    store.artifact(child.id, "step_result", { observations: [observationInputSchema.parse({ url, data: { title: "Later unrelated title", gesClass: "B" }, detailStatus: "captured", absentFields: dataFields.filter(field => !["title", "gesClass"].includes(field)), evidence: [{ url, kind: "page", text: "Later unrelated title. GES: B. Other attributes absent." }] })], warnings: [] });
    worker.reprocessEvidence(child.id);
    expect(store.observation(child.id, observation.id)?.data.title).toBe("Original title");
    expect(store.observation(child.id, observation.id)?.data.gesClass).toBe("B");
    expect(store.observation(run.id, observation.id)).toEqual(observation);
  });

  it("resolves explicit DPE exemption locally before any paid dispatch", async () => {
    const { store, worker, step, run, observation } = fixture(["energyClass"]);
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: "## Description\nNon soumis au DPE.\nVoir moins\n## Localisation\nLannion" } });
    store.saveObservation({ ...observation, observedAt: new Date(Date.now() + 10).toISOString() }, { replaceSnapshot: true });
    expect(worker.repairPlan(run.id).items[0]?.locallyResolved).toContain("energyClass");
    const child = worker.repair(run.id, {}, "local-only"); await worker.drain();
    expect(step).not.toHaveBeenCalled();
    expect(store.getRun(child.id)).toMatchObject({ captured: 1, cost: 0, pending: 0, status: "completed", coverage: "unknown" });
    expect(store.observation(child.id, observation.id)?.fieldStates?.energyClass?.status).toBe("not_applicable");
  });

  it("can repair from a newer raw response even when its invalid model output retained an old baseline timestamp", async () => {
    const { store, worker, step, run, observation } = fixture(["energyClass"]);
    const old={...observation,observedAt:"2026-01-01T00:00:00.000Z"};
    store.saveObservation(old,{replaceSnapshot:true});
    store.artifact(run.id,"firecrawl_scrape",{success:true,data:{metadata:{sourceURL:url},markdown:"## Description\nNon soumis au DPE.\nVoir moins"}});
    const child=worker.repair(run.id,{},"newer-raw");await worker.drain();
    expect(step).not.toHaveBeenCalled();
    const repaired=store.observation(child.id,old.id)!;
    expect(repaired.fieldObservedAt?.title).toBe(old.observedAt);
    expect(Date.parse(repaired.fieldObservedAt!.energyClass!)).toBeGreaterThan(Date.parse(old.observedAt));
    expect(repaired.fieldStates?.energyClass?.status).toBe("not_applicable");
  });

  it("does not use another listing's raw page or classify an unobserved field as absent", () => {
    const { store, worker, run, observation } = fixture(["energyClass", "landSurfaceM2"]);
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url.replace("123456", "99999") }, markdown: "## Description\nNon soumis au DPE.\nVoir moins" } });
    store.saveObservation({ ...observation, observedAt: new Date(Date.now() + 10).toISOString() }, { replaceSnapshot: true });
    expect(worker.repairPlan(run.id).items[0]?.locallyResolved).toEqual([]);
    const candidate = observationInputSchema.parse({ url, absentFields: ["landSurfaceM2"], evidence: [{ url, text: "No visible terrain on the extracted markdown", kind: "page" }] });
    expect(mergeRepairFields(observation, candidate, ["landSurfaceM2"]).missingFields).toContain("landSurfaceM2");
  });

  it("rejects foreign IDs, resolved selections, active runs and forged lineage before dispatch", () => {
    const { store, worker, step, run } = fixture();
    expect(() => worker.repair(run.id, { listingIds: ["leboncoin:99999"] }, "foreign")).toThrow("belonging");
    expect(() => worker.repair(run.id, { fields: ["title"] }, "resolved")).toThrow("No unresolved fields");
    expect(() => worker.create(captureRequestSchema.parse({ ...run.request, repair: { parentRunId: run.id, targets: [{ listingId: "leboncoin:123456", fields: ["gesClass"] }] } }), "forged")).toThrow("repair endpoint");
    store.updateRun(run.id, { status: "running" });
    expect(worker.repairPlan(run.id).eligible).toBe(false);
    expect(() => worker.repair(run.id, {}, "active")).toThrow("Stop the source run");
    expect(step).not.toHaveBeenCalled(); expect(store.listRuns().total).toBe(1);
  });

  it("enforces the persisted remaining budget before a repair dispatch", async () => {
    const { store, worker, step, run } = fixture();
    store.saveBalance("firecrawl", { remaining: 0, expiresAt: null, note: "Exhausted fixture" });
    const child = worker.repair(run.id, {}, "no-budget"); await worker.drain();
    expect(store.getRun(child.id).status).toBe("budget_exhausted"); expect(step).not.toHaveBeenCalled();
  });
});
