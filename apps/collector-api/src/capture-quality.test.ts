import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRequestSchema, type CaptureObservation, type ObservationInput, type ProviderId } from "@denicheur-breizh/collector-contracts";
import { detailFieldStates, detailGaps } from "./capture-quality.js";
import { type CaptureProvider, type ProviderStepContext, type ProviderStepResult } from "./adapter.js";
import { readConfig } from "./config.js";
import { canonicalIdentity } from "./sources.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";
import { scrapeEvidenceWarnings } from "./providers/scrape-quality.js";

const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
const searchUrl = "https://www.leboncoin.fr/recherche?category=9&locations=Lannion";
const resources: Array<{ directory: string; worker: CaptureWorker; store: CollectorStore }> = [];
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.worker.stop(); resource.store.close(); rmSync(resource.directory, { recursive: true, force: true }); } });
function complete(): ObservationInput {
  return { url, detailStatus: "captured", missingFields: [], absentFields: [], evidence: [{ url, kind: "page", text: "Synthetic complete property detail evidence." }], data: { title: "House", priceEuros: 200000, propertyType: "house", location: "Lannion", surfaceM2: 100, landSurfaceM2: 500, rooms: 4, bedrooms: 3, description: "Complete property description, with its entire final paragraph.", energyClass: "D", gesClass: "B", sellerName: "Synthetic seller", sellerType: "private", postedAt: "2026-09-12", features: ["garden"], imageUrls: ["https://img.leboncoin.fr/fixture.jpg"] } };
}
function output(observation: ObservationInput, provider: ProviderId = "firecrawl"): ProviderStepResult { return { observations: [observation], nextPages: [], exhausted: true, warnings: [], usage: { amount: 1, unit: provider === "xai" ? "usd" : "credits" } }; }
function fixture(provider: ProviderId = "firecrawl") {
  const directory = mkdtempSync(join(tmpdir(), "collector-quality-"));
  const config = readConfig({ COLLECTOR_TEST_MODE: "1", COLLECTOR_DATA_DIR: directory });
  const store = new CollectorStore(":memory:", directory);
  const step = vi.fn<(context: ProviderStepContext) => Promise<ProviderStepResult>>();
  const unusedStep = vi.fn<(context: ProviderStepContext) => Promise<ProviderStepResult>>();
  const adapter: CaptureProvider = { id: provider, model: "fixture", strategy: "quality-test-v1", configured: true, step };
  const other: CaptureProvider = { id: provider === "xai" ? "firecrawl" : "xai", model: "fixture", strategy: "unused-test-v1", configured: true, step: unusedStep };
  const worker = new CaptureWorker(store, new Map([[provider, adapter], [other.id, other]]), config);
  resources.push({ directory, worker, store });
  const request = captureRequestSchema.parse({ name: "Full detail quality", mode: "search", source: "leboncoin", provider, searchUrl });
  return { worker, store, step, unusedStep, request };
}

describe("source detail completeness", () => {
  it("requires field-specific proof for new states and never converts string null or an unrelated number into an observation",()=>{
    const observation=complete();
    observation.fieldStates={landSurfaceM2:{status:"observed",reason:"Claimed land area",evidence:[{url,kind:"page",text:"Prix du bien: 500 €. Surface habitable: 100 m²."}]}};
    expect(detailFieldStates(observation).landSurfaceM2.status).toBe("unresolved");expect(detailGaps(observation)).toContain("landSurfaceM2");
    observation.fieldStates.landSurfaceM2!.evidence=[{url,kind:"page",text:"Surface totale du terrain: 500 m²"}];observation.missingFields=["landSurfaceM2"];
    expect(detailGaps(observation)).not.toContain("landSurfaceM2");
    observation.data.energyClass="null";expect(detailGaps(observation)).toContain("energyClass");
  });
  it("accepts explicit same-listing DPE exemption without inventing a rating or exempting GES",()=>{
    const observation=complete();delete observation.data.energyClass;delete observation.data.gesClass;
    observation.missingFields=["energyClass","gesClass"];
    observation.fieldStates={energyClass:{status:"not_applicable",reason:"Explicit exemption",evidence:[{url,kind:"page",text:"Ce bien est non soumis au DPE."}]},gesClass:{status:"not_applicable",reason:"Assumed same",evidence:[{url,kind:"page",text:"Ce bien est non soumis au DPE."}]}};
    expect(detailFieldStates(observation).energyClass.status).toBe("not_applicable");expect(detailFieldStates(observation).gesClass.status).toBe("unresolved");
    expect(detailGaps(observation)).toEqual(["gesClass"]);
    observation.data.energyClass="A";expect(detailGaps(observation)).toContain("energyClass");
  });
  it("rejects claimed absence inferred from an apartment, unrelated URL, or an empty source",()=>{
    const observation=complete();delete observation.data.landSurfaceM2;
    for(const evidence of [[{url,kind:"page" as const,text:"Appartement 3 pièces"}],[{url:"https://www.leboncoin.fr/ad/ventes_immobilieres/999999",kind:"page" as const,text:"Surface du terrain: non renseigné"}],[]]){
      observation.fieldStates={landSurfaceM2:{status:"absent",reason:"Claimed missing land",evidence}};expect(detailGaps(observation)).toContain("landSurfaceM2");
    }
    observation.fieldStates={landSurfaceM2:{status:"absent",reason:"Explicit source statement",evidence:[{url,kind:"page",text:"Surface du terrain: non renseigné"}]}};
    expect(detailGaps(observation)).not.toContain("landSurfaceM2");
  });
  it("requires field presence or explicit observed absence rather than silently interpreting null as absent", () => {
    const observation = complete(); delete observation.data.sellerName;
    expect(detailGaps(observation)).toEqual(["sellerName"]);
    observation.absentFields = ["sellerName"];
    expect(detailGaps(observation)).toEqual([]);
    observation.data.sellerName = "Contradiction";
    expect(detailGaps(observation)).toEqual(["sellerName"]);
  });
  it("preserves explicit missing-field declarations even when a partial value exists", () => {
    const observation = complete(); observation.missingFields = ["description"];
    expect(detailGaps(observation)).toEqual(["description"]);
  });
  it("rejects navigation labels as energy ratings and identifies warning-confirmed collapsed descriptions", () => {
    const observation = complete(); observation.data.energyClass = "En savoir plus"; observation.data.gesClass = "DPE non renseigné"; observation.data.description = "Description cut at the collapsed UI…";
    expect(detailGaps(observation, undefined, ["Some descriptions are truncated by the detail page UI (Voir plus)."])).toEqual(["energyClass", "gesClass", "description"]);
    expect(detailGaps({ ...complete(), data: { ...complete().data, description: "An intentionally open-ended sentence…" } })).toEqual([]);
  });
  it.each(["xai", "firecrawl"] as const)("automatically completes every %s discovered listing with missing detail through the same provider", async provider => {
    const { worker, store, step, unusedStep, request } = fixture(provider);
    const initial = complete(); delete initial.data.sellerName; initial.data.description = "Collapsed description…"; initial.data.energyClass = "En savoir plus";
    step.mockResolvedValueOnce({ ...output(initial, provider), warnings: ["Descriptions are truncated by the detail UI."] });
    step.mockImplementationOnce(async context => { expect(context.work.kind).toBe("details"); expect(context.work.urls).toEqual([url]); expect(context.instructions).toContain("Voir plus"); return output(complete(), provider); });
    const run = worker.create(request, `quality-${provider}`); await worker.drain();
    expect(step).toHaveBeenCalledTimes(2); expect(unusedStep).not.toHaveBeenCalled();
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", captured: 1, pending: 0, failed: 0, cost: 2 });
    expect(store.observations(run.id).items[0]).toMatchObject({ detailStatus: "captured", missingFields: [], data: { description: complete().data.description, energyClass: "D", sellerName: "Synthetic seller" } });
    expect(store.events(run.id).some(event => event.kind === "detail_incomplete")).toBe(true);
  });
  it("does not retry an unresolved detail forever and preserves partial evidence for explicit resume", async () => {
    const { worker, store, step, request } = fixture();
    const missing = complete(); delete missing.data.sellerType; missing.missingFields = ["sellerType"];
    step.mockResolvedValue(output(missing));
    const run = worker.create(request, "unresolved"); await worker.drain();
    expect(step).toHaveBeenCalledTimes(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "partial", captured: 0, failed: 1, pending: 0 });
    expect(store.observations(run.id).items[0]!.data.description).toBe(complete().data.description);
    step.mockResolvedValueOnce(output(complete()));
    worker.resume(run.id); await worker.drain();
    expect(step).toHaveBeenCalledTimes(3);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", captured: 1, failed: 0 });
  });
  it("revisits legacy captured statuses with gaps when the operator explicitly resumes", async () => {
    const { worker, store, step, request } = fixture();
    const run = store.createRun(request, "legacy", "quality-test-v1", "fixture").run;
    store.db.prepare("UPDATE work SET status='done' WHERE run_id=?").run(run.id);
    const legacy = complete(); delete legacy.data.features; legacy.missingFields = ["features"];
    store.saveObservation({ ...legacy, ...canonicalIdentity("leboncoin", url), source: "leboncoin", runId: run.id, provider: "firecrawl", observedAt: new Date().toISOString() } as CaptureObservation);
    store.updateRun(run.id, { status: "partial", observedEnd: true }); store.refresh(run.id);
    expect(store.getRun(run.id).captured).toBe(1);
    step.mockResolvedValueOnce(output(complete()));
    worker.resume(run.id); await worker.drain();
    expect(step).toHaveBeenCalledTimes(1);
    expect(step.mock.calls[0]![0].work.kind).toBe("details");
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", captured: 1, failed: 0 });
    expect(store.observations(run.id).items[0]!.missingFields).toEqual([]);
  });
  it("retains a complete existing detail when a duplicate discovery is partial", async () => {
    const { worker, store, step, request } = fixture();
    step.mockResolvedValueOnce({ ...output(complete()), exhausted: false, nextPages: [`${searchUrl}&page=2`] });
    const partial = complete(); partial.data.description = "Shorter truncated text…"; partial.missingFields = ["description"];
    step.mockResolvedValueOnce(output(partial));
    const run = worker.create(request, "duplicate"); await worker.drain();
    expect(step).toHaveBeenCalledTimes(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", captured: 1, failed: 0 });
    expect(store.observations(run.id).items[0]!.data.description).toBe(complete().data.description);
  });
  it("does not reapply an older raw disclosure warning after a subsequent full detail repaired the listing", async () => {
    const { worker, store, step, request } = fixture();
    const warnings=scrapeEvidenceWarnings({data:{markdown:"## Description\n\nPartial source text\n\nVoir plus",metadata:{sourceURL:url}}});
    step.mockResolvedValueOnce({...output(complete()),exhausted:false,nextPages:[`${searchUrl}&page=2`],warnings});
    step.mockResolvedValueOnce(output(complete()));
    const partial=complete();partial.missingFields=["description"];partial.data.description="A later partial discovery card.";
    step.mockResolvedValueOnce(output(partial));
    const run=worker.create(request,"repaired-raw-disclosure");await worker.drain();
    expect(step).toHaveBeenCalledTimes(3);
    expect(store.getRun(run.id)).toMatchObject({status:"completed",captured:1,failed:0,warnings:expect.arrayContaining(warnings)});
    expect(store.observations(run.id).items[0]!.data.description).toBe(complete().data.description);
    worker.resume(run.id);await worker.drain();
    expect(step).toHaveBeenCalledTimes(3);
    expect(store.getRun(run.id)).toMatchObject({status:"completed",captured:1,failed:0});
  });
});
