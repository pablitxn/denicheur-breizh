import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRequestSchema, dataFields, type CaptureObservation, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import type { CaptureProvider } from "./adapter.js";
import { readConfig } from "./config.js";
import { canonicalIdentity } from "./sources.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";

const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
const originalAt = "2026-09-12T08:00:00.000Z";
const laterAt = "2026-09-12T09:00:00.000Z";
const directories: string[] = [];
const stores: CollectorStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function complete(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return { url, data: { title: "House", description: "Every original paragraph of the property description.", priceEuros: 210000, imageUrls: ["https://img.leboncoin.fr/current.jpg"], features: ["garden"] }, detailStatus: "captured", missingFields: [], absentFields: dataFields.filter(field => !["title", "description", "priceEuros", "imageUrls", "features"].includes(field)), evidence: [{ url, kind: "page", text: "Observed property detail, complete gallery and explicit field absence." }], ...overrides };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "collector-reprocess-")); directories.push(directory);
  const store = new CollectorStore(join(directory, "test.sqlite"), join(directory, "artifacts")); stores.push(store);
  const config = readConfig({ COLLECTOR_TEST_MODE: "1", COLLECTOR_DATA_DIR: directory });
  const step = vi.fn<CaptureProvider["step"]>(), balance = vi.fn<NonNullable<CaptureProvider["balance"]>>(), cancel = vi.fn<NonNullable<CaptureProvider["cancel"]>>();
  const provider: CaptureProvider = { id: "firecrawl", model: "fixture", strategy: "firecrawl-agent-scrape-v1", configured: true, step, balance, cancel };
  const worker = new CaptureWorker(store, new Map([["firecrawl", provider]]), config);
  const request = captureRequestSchema.parse({ name: "Snapshot repair fixture", source: "leboncoin", provider: "firecrawl", mode: "urls", urls: [url] });
  const run = store.createRun(request, "snapshot-fixture", provider.strategy, provider.model).run;
  store.db.prepare("UPDATE work SET status='done' WHERE run_id=?").run(run.id);
  store.updateRun(run.id, { status: "partial", coverage: "incomplete" });
  const observation = (input: ObservationInput, observedAt = originalAt): CaptureObservation => ({ ...input, ...canonicalIdentity("leboncoin", input.url), runId: run.id, source: "leboncoin", provider: "firecrawl", observedAt });
  function artifact(observations: unknown[], at = originalAt, extra: Record<string, unknown> = {}, otherRunId = run.id) {
    const id = store.artifact(otherRunId, "step_result", { observations, nextPages: [], exhausted: false, warnings: [], usage: { amount: 1, unit: "credits" }, ...extra });
    const path = join(directory, "artifacts", `${id}.json`);
    const payload = JSON.parse(readFileSync(path, "utf8")); payload.at = at;
    writeFileSync(path, JSON.stringify(payload));
    return id;
  }
  return { directory, store, worker, run, observation, artifact, step, balance, cancel };
}

describe("authoritative listing snapshots", () => {
  it("replaces old gallery and features with complete detail while preserving all 500 photos and full text", () => {
    const { store, run, observation, artifact } = fixture();
    const partial = complete({ detailStatus: "pending", data: { title: "Card", energyClass: "En savoir plus", imageUrls: ["https://img.leboncoin.fr/recommendation.jpg"], features: ["old-card"] }, absentFields: [], missingFields: ["description"] });
    const oldArtifact = artifact([partial]); store.saveObservation(observation(partial));
    const detail = complete(); detail.data.imageUrls = Array.from({ length: 500 }, (_, i) => `https://img.leboncoin.fr/real-${i}.jpg`); detail.data.description = "Complete description. ".repeat(1200);
    store.saveObservation(observation(detail, laterAt));
    const saved = store.observation(run.id, "leboncoin:123456")!;
    expect(saved.data).toEqual(detail.data); expect(saved.data.imageUrls).toHaveLength(500); expect(saved.data.energyClass).toBeUndefined(); expect(saved.absentFields).toContain("energyClass");
    expect(store.readArtifact(run.id, oldArtifact)).toMatchObject({ payload: { observations: [partial] } });
  });
  it("replaces a previously captured snapshot including known absence and changed numeric data", () => {
    const { store, run, observation } = fixture();
    const old = complete(); old.data.energyClass = "D"; old.absentFields = old.absentFields.filter(field => field !== "energyClass"); store.saveObservation(observation(old));
    const updated = complete(); updated.data.priceEuros = 195000; updated.data.imageUrls = []; updated.data.features = []; updated.absentFields.push("imageUrls", "features");
    store.saveObservation(observation(updated, laterAt));
    expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ data: updated.data, absentFields: updated.absentFields, observedAt: laterAt });
    expect(store.observation(run.id, "leboncoin:123456")!.data.energyClass).toBeUndefined();
  });
  it.each(["pending", "failed"] as const)("a %s duplicate preserves the complete snapshot timestamp and every field, adding only evidence", detailStatus => {
    const { store, run, observation } = fixture();
    const old = observation(complete()); store.saveObservation(old);
    const partial = observation(complete({ detailStatus, data: { title: "Card title", description: "Cut short…", priceEuros: 1, imageUrls: ["https://img.leboncoin.fr/wrong.jpg"] }, missingFields: ["description"], absentFields: ["sellerName"], error: "Detail failed", evidence: [{ url, kind: "trace", text: "Later incomplete card." }] }), laterAt);
    store.saveObservation(partial); store.saveObservation(partial);
    const saved = store.observation(run.id, old.id)!;
    expect(saved).toEqual({ ...old, evidence: [...old.evidence, ...partial.evidence] });
  });
  it("explicit absence clears stale partial fields and explicit quality override may downgrade legacy captured status", () => {
    const { store, run, observation } = fixture();
    store.saveObservation(observation(complete({ detailStatus: "pending", data: { title: "Card", energyClass: "En savoir plus" }, absentFields: [] })));
    store.saveObservation(observation(complete({ detailStatus: "pending", data: { description: "Recovered partial description" }, absentFields: ["energyClass"] }), laterAt));
    expect(store.observation(run.id, "leboncoin:123456")!.data).toMatchObject({ title: "Card", description: "Recovered partial description" });
    expect(store.observation(run.id, "leboncoin:123456")!.data.energyClass).toBeUndefined();
    const full = observation(complete()); store.saveObservation(full);
    store.saveObservation({ ...full, detailStatus: "pending", missingFields: ["description"] }, { replaceDetailStatus: true });
    expect(store.observation(run.id, full.id)).toMatchObject({ detailStatus: "pending", missingFields: ["description"] });
  });
  it("rejects changing observation provider provenance", () => {
    const { store, observation } = fixture(); const old = observation(complete()); store.saveObservation(old);
    expect(() => store.saveObservation({ ...old, provider: "xai" })).toThrow("OBSERVATION_PROVENANCE_CONFLICT");
  });
});

describe("offline evidence replay", () => {
  it("repairs from the latest valid same-run response, retains history, timestamps and budget, and is idempotent", () => {
    const { store, worker, run, observation, artifact, step, balance, cancel } = fixture();
    const old = complete(); old.data.imageUrls = ["https://img.leboncoin.fr/wrong.jpg"]; old.data.energyClass = "En savoir plus"; old.absentFields = old.absentFields.filter(field => field !== "energyClass");
    store.saveObservation(observation(old)); const oldArtifact = artifact([old]);
    const first = complete(); first.data.title = "First valid response"; artifact([first], originalAt);
    const corrected = complete(); corrected.data.imageUrls = Array.from({ length: 500 }, (_, i) => `https://img.leboncoin.fr/listing-${i}.jpg`);
    const lastValid = artifact([corrected], laterAt);
    artifact([complete({ detailStatus: "failed", data: {}, missingFields: ["title"] })], "2026-09-12T10:00:00.000Z");
    store.refresh(run.id); const budgetBefore = worker.budget("firecrawl"); const eventsBefore = store.events(run.id).length;
    const result = worker.reprocessEvidence(run.id);
    expect(result.replayed).toBe(1); expect(result.applied).toEqual([{ listingId: "leboncoin:123456", artifactId: lastValid, observedAt: laterAt }]);
    expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ data: corrected.data, observedAt: laterAt, detailStatus: "captured" });
    expect(store.observation(run.id, "leboncoin:123456")!.data.energyClass).toBeUndefined();
    expect(result.run).toMatchObject({ status: "partial", coverage: "incomplete", captured: 1, pending: 0 });
    expect(store.readArtifact(run.id, oldArtifact)).toMatchObject({ payload: { observations: [old] } });
    expect(store.events(run.id).length).toBeGreaterThan(eventsBefore);
    const snapshotEvent = store.events(run.id).find(event => event.message === "snapshots_before_evidence_reprocess")!;
    expect(store.readArtifact(run.id, snapshotEvent.artifactId!)).toMatchObject({ payload: { observations: [{ data: old.data }] } });
    expect(worker.budget("firecrawl")).toEqual(budgetBefore);
    expect(worker.reprocessEvidence(run.id).replayed).toBe(0);
    expect(step).not.toHaveBeenCalled(); expect(balance).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it("rejects fabricated provenance, omitted fields, foreign IDs, invalid evidence and malformed artifacts", () => {
    const { directory, store, worker, run, observation, artifact } = fixture(); const old = observation(complete()); store.saveObservation(old);
    artifact([{ ...complete(), provider: "xai" }]); artifact([{ ...complete(), runId: "other-run" }]); artifact([{ ...complete(), source: "another-site" }]);
    artifact([complete({ missingFields: ["description"] })]); artifact([complete({ evidence: [] })]);
    artifact([complete({ url: "https://www.leboncoin.fr/ad/ventes_immobilieres/999999" })]);
    artifact([complete({ url: "https://example.org/ad/123456" })]);
    artifact([complete()], laterAt, { context: { runId: run.id, source: "leboncoin", provider: "firecrawl", strategy: run.strategy, model: run.model, work: { id: "wrong-url", kind: "details", urls: ["https://www.leboncoin.fr/ad/ventes_immobilieres/999999"] } } });
    artifact([complete()], laterAt, { observedAt: "2026-09-13T00:00:00.000Z" });
    const malformed = artifact([complete()]); writeFileSync(join(directory, "artifacts", `${malformed}.json`), "{");
    const foreignEnvelope = artifact([complete()]); const path = join(directory, "artifacts", `${foreignEnvelope}.json`); const raw = JSON.parse(readFileSync(path, "utf8")); raw.runId = "other-run"; writeFileSync(path, JSON.stringify(raw));
    const otherRun = store.createRun({ ...run.request, provider: "xai" }, "foreign-run", "xai-web-search-v1", "fixture").run;
    const foreignArtifact = artifact([complete()], laterAt, {}, otherRun.id); store.event(run.id, "evidence", "step_result", foreignArtifact);
    const result = worker.reprocessEvidence(run.id);
    expect(result.replayed).toBe(0); expect(result.skipped).toHaveLength(12); expect(store.observation(run.id, old.id)).toEqual(old);
  });
  it("keeps the captured observation time recorded by new responses and invalidates stale verification", () => {
    const { store, worker, run, observation, artifact } = fixture(); store.saveObservation(observation(complete()));
    const updated = complete(); updated.data.priceEuros = 190000;
    artifact([updated], laterAt, { observedAt: "2026-09-12T08:59:59.999Z", context: { runId: run.id, source: "leboncoin", provider: "firecrawl", strategy: run.strategy, model: run.model, work: { id: "detail", kind: "details", urls: [url] } } });
    store.updateRun(run.id, { coverage: "verified_complete" });
    expect(worker.reprocessEvidence(run.id).run.coverage).toBe("unknown");
    expect(store.observation(run.id, "leboncoin:123456")!.observedAt).toBe("2026-09-12T08:59:59.999Z");
  });
  it("downgrades claimed completion when the associated raw page proves the source description was collapsed, even without JSON ellipsis", () => {
    const { store, worker, run, observation, artifact, step } = fixture();
    const current = complete(); current.data.imageUrls = ["https://img.leboncoin.fr/recommendation.jpg"]; store.saveObservation(observation(current));
    const rawId = store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: "## Description\n\nActual property description cut at Consommation énergie primair…\n\nVoir plus\n\n## Caractéristiques\nMaison" } });
    const response = complete(); response.data.description = "A model shortened the source into a sentence without any ellipsis.";
    artifact([response], laterAt); store.updateRun(run.id, { coverage: "verified_complete" });
    const result = worker.reprocessEvidence(run.id);
    expect(result).toMatchObject({ replayed: 1, downgraded: 1, run: { captured: 0, failed: 1, coverage: "incomplete" } });
    expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ detailStatus: "failed", missingFields: ["description"], observedAt: laterAt, data: response.data });
    expect(store.events(run.id).some(event => event.artifactId === rawId)).toBe(true); expect(step).not.toHaveBeenCalled();
  });
  it("retains an earlier complete response when a later source consultation was demonstrably partial", () => {
    const { store, worker, run, observation, artifact } = fixture();
    const good = complete(); good.data.description = "Earlier fully expanded description with every paragraph.";
    store.saveObservation(observation(good)); artifact([good], originalAt);
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: "## Description\n\nLater collapsed description…\n\nVoir plus\n\n## Caractéristiques\nMaison" } });
    artifact([complete()], laterAt);
    const result = worker.reprocessEvidence(run.id);
    expect(result.downgraded).toBe(0); expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ data: good.data, observedAt: originalAt, detailStatus: "captured" });
  });
  it("never borrows another listing's raw page or a previous step's collapsed-description warning", () => {
    const { store, worker, run, observation, artifact } = fixture(); store.saveObservation(observation(complete()));
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: "https://www.leboncoin.fr/ad/ventes_immobilieres/999999" }, markdown: "## Description\n\nForeign collapsed description…\n\nVoir plus\n\n## Caractéristiques\nMaison" } });
    artifact([complete()], originalAt);
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: "## Description\n\nCollapsed description…\n\nVoir plus\n\n## Caractéristiques\nMaison" } });
    artifact([complete()], originalAt);
    const latest = complete(); latest.data.description = "Later independent full source consultation."; artifact([latest], laterAt);
    const result = worker.reprocessEvidence(run.id);
    expect(result.downgraded).toBe(0); expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ data: latest.data, detailStatus: "captured", observedAt: laterAt });
  });
  it.each(["captured", "pending", "failed"] as const)("restores the complete raw description for a %s result while preserving unrelated missing fields and data", detailStatus => {
    const { store, worker, run, observation, artifact, step } = fixture();
    const short = complete({ detailStatus, missingFields: ["description", "sellerName"], absentFields: dataFields.filter(field => !["title", "description", "priceEuros", "imageUrls", "features", "sellerName"].includes(field)) });
    short.data.description = "A model summary."; store.saveObservation(observation(short));
    const full = "First original paragraph with every detail.\n\n### Les pièces\n\n" + "Source sentence with measurements and conditions. ".repeat(100) + "\n\nFinal source paragraph.";
    const rawArtifact = store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: `## Description\n\n${full}\n\nVoir moins\n\n## Localisation\nText outside the description.` } });
    const resultInput = { ...short, data: { ...short.data, priceEuros: 1 } }; artifact([resultInput], laterAt);
    const result = worker.reprocessEvidence(run.id);
    const saved = store.observation(run.id, "leboncoin:123456")!;
    expect(saved).toMatchObject({ detailStatus: "failed", missingFields: ["sellerName"], observedAt: laterAt, data: { description: full, priceEuros: short.data.priceEuros } });
    expect(saved.data.description).not.toContain("Text outside the description"); expect(saved.absentFields).not.toContain("description");
    expect(result).toMatchObject({ repairedDescriptions: 1, replayed: 1, run: { captured: 0, failed: 1, coverage: "incomplete" } });
    expect(saved.evidence.some(item => item.text.includes(full))).toBe(true);
    const audit = store.events(run.id).filter(event => event.message === "evidence_reprocess").at(-1)!;
    expect(store.readArtifact(run.id, audit.artifactId!)).toMatchObject({ payload: { sourceDescriptions: [{ supportingArtifactId: rawArtifact }] } });
    expect(worker.reprocessEvidence(run.id)).toMatchObject({ replayed: 0, repairedDescriptions: 0 }); expect(step).not.toHaveBeenCalled();
  });
  it("normalizes a complete response from expanded source text before accepting the captured snapshot", () => {
    const { store, worker, run, observation, artifact } = fixture(); const short = complete(); short.data.description = "Short summary"; store.saveObservation(observation(short));
    const full = "The complete source description.\n\nThe final paragraph includes seller conditions.";
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: `## Description\n\n${full}\n\nVoir moins\n\n## Localisation\nLannion` } });
    artifact([short], laterAt);
    const result = worker.reprocessEvidence(run.id);
    expect(result).toMatchObject({ repairedDescriptions: 1, downgraded: 0, run: { captured: 1, failed: 0 } });
    expect(store.observation(run.id, "leboncoin:123456")).toMatchObject({ detailStatus: "captured", data: { description: full } });
  });
  it("does not substitute expanded descriptions from another listing or an unrelated preceding response", () => {
    const { store, worker, run, observation, artifact } = fixture();
    const failed = complete({ detailStatus: "failed", missingFields: ["description", "sellerName"] }); store.saveObservation(observation(failed));
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: "https://www.leboncoin.fr/ad/ventes_immobilieres/999999" }, markdown: "## Description\n\nOther listing full text.\n\nVoir moins" } }); artifact([failed], originalAt);
    store.artifact(run.id, "firecrawl_scrape", { success: true, data: { metadata: { sourceURL: url }, markdown: "## Description\n\nA different response's full text.\n\nVoir moins" } }); artifact([], originalAt);
    artifact([failed], laterAt);
    const result = worker.reprocessEvidence(run.id);
    expect(result).toMatchObject({ repairedDescriptions: 0, replayed: 0 }); expect(store.observation(run.id, "leboncoin:123456")!.data.description).toBe(failed.data.description);
  });
  it.each(["queued", "running", "remote", "activeWork"] as const)("refuses replay while %s work can still change the execution", state => {
    const { store, worker, run, artifact } = fixture(); artifact([complete()]);
    store.updateRun(run.id, state === "remote" ? { remoteJobId: "provider-job" } : state === "activeWork" ? { activeWork: { id: "work", kind: "details", urls: [url] } } : { status: state });
    const events = store.events(run.id);
    expect(() => worker.reprocessEvidence(run.id)).toThrow("Stop the execution"); expect(store.events(run.id)).toEqual(events);
  });
});
