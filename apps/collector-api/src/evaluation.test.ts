import { describe, expect, it } from "vitest";
import { captureRequestSchema, type CaptureObservation, type CaptureRun, type EvaluationReview, type ReferenceRecord } from "@denicheur-breizh/collector-contracts";
import { evaluateRuns, importExtensionReference, reportMarkdown } from "./evaluation.js";

const url = (id: number) => `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`;
const at = "2026-09-12T12:00:00.000Z";
const searchUrl = "https://www.leboncoin.fr/recherche?category=9&locations=Quimper";
function fixture(count = 2): { reference: ReferenceRecord; run: CaptureRun; observations: CaptureObservation[] } {
  const records = Array.from({ length: count }, (_, i) => ({
    url: url(i + 1), data: { title: `Maison ${i + 1}`, priceEuros: 250_000, propertyType: "maison", location: "Quimper", surfaceM2: 100, imageUrls: [`https://img.leboncoin.fr/${i + 1}.jpg`] },
    detailStatus: "captured" as const, absentFields: [], missingFields: [], evidence: [{ url: url(i + 1), kind: "page" as const, text: `Maison ${i + 1} 250000 EUR 100m2 Quimper` }],
  }));
  const reference: ReferenceRecord = { id: "reference", importedAt: at, name: "Quimper", source: "leboncoin", searchUrl, capturedAt: at, complete: true, pages: [searchUrl], notes: "Every native search page reviewed and exhausted.", requiredFields: ["title", "priceEuros", "propertyType", "location", "surfaceM2"], records };
  const run: CaptureRun = { id: "run", request: captureRequestSchema.parse({ provider: "xai", mode: "search", name: "Quimper", searchUrl }), status: "completed", createdAt: at, updatedAt: at, startedAt: at, endedAt: "2026-09-12T12:01:00.000Z", strategy: "xai-v1", model: "fixture", coverage: "unknown", discovered: count, captured: count, failed: 0, duplicates: 0, pagesVisited: 2, pending: 0, observedEnd: true, warnings: [], cost: 2, costUnknown: false, unit: "usd" };
  const observations = records.map((record, i): CaptureObservation => ({ ...structuredClone(record), id: `leboncoin:${i + 1}`, externalId: String(i + 1), source: "leboncoin", provider: "xai", runId: run.id, observedAt: at }));
  return { reference, run, observations };
}
function result(value = fixture(), reviews: EvaluationReview[] = []) {
  return evaluateRuns(value.reference, [value], reviews).results[0]!;
}
const review = (patch: Partial<EvaluationReview> = {}): EvaluationReview => ({ referenceId: "reference", runId: "run", listingId: "leboncoin:1", field: "identity", resolution: "source_changed", note: "Listing was removed between reference and provider runs; page now reports unavailable.", evidenceUrl: url(1), reviewedAt: at, ...patch });

describe("complete coverage evaluation", () => {
  it("accepts matching explicitly evidenced inapplicability without requiring a fabricated A-G rating",()=>{
    const value=fixture(1),state={status:"not_applicable" as const,reason:"The listing explicitly states the DPE exemption",evidence:[{url:url(1),kind:"page" as const,text:"Bien non soumis au DPE."}]};
    value.reference.requiredFields.push("energyClass");value.reference.records[0]!.fieldStates={energyClass:state};value.observations[0]!.fieldStates={energyClass:structuredClone(state)};
    const evaluated=result(value);expect(evaluated.verdict).toBe("verified_complete");expect(evaluated.discrepancies).toEqual([]);
    value.observations[0]!.data.energyClass="A";expect(result(value).verdict).toBe("incomplete");expect(result(value).discrepancies).toContainEqual(expect.objectContaining({field:"energyClass",expected:null,actual:"A"}));
  });
  it("requires a matching evidenced field status for explicit source absence or inapplicability",()=>{
    const value=fixture(1);
    value.reference.records[0]!.fieldStates={energyClass:{status:"not_applicable",reason:"Explicit exemption",evidence:[{url:url(1),kind:"page",text:"DPE non soumis"}]}};
    expect(result(value).verdict).toBe("incomplete");
    value.observations[0]!.fieldStates={energyClass:{status:"absent",reason:"Explicit nonpublication",evidence:[{url:url(1),kind:"page",text:"DPE non renseigné"}]}};
    const evaluated=result(value);expect(evaluated.verdict).toBe("incomplete");expect(evaluated.discrepancies).toContainEqual(expect.objectContaining({field:"fieldState.energyClass",expected:"not_applicable",actual:"absent"}));
  });
  it("does not hide an unresolved field state behind captured status and an empty missingFields list",()=>{
    const value=fixture(1);value.observations[0]!.fieldStates={title:{status:"unresolved",reason:"Title not confirmed",evidence:[]}};
    const evaluated=result(value);expect(evaluated.verdict).toBe("incomplete");expect(evaluated.fieldCompleteness.numerator).toBe(5);expect(evaluated.fieldCompleteness.denominator).toBe(6);expect(evaluated.costPerUsefulListing).toBeNull();
    expect(evaluated.discrepancies).toContainEqual(expect.objectContaining({field:"missingFields",actual:["title"]}));
    const referenceUnknown=fixture(1);referenceUnknown.reference.records[0]!.fieldStates={title:{status:"unresolved",reason:"Unconfirmed reference title",evidence:[]}};
    expect(result(referenceUnknown).verdict).toBe("inconclusive");
  });
  it("requires same-listing evidence for declared observed values and does not count unsupported values as recovered",()=>{
    const value=fixture(1);value.reference.records[0]!.data.gesClass="C";value.observations[0]!.data.gesClass="C";
    value.observations[0]!.fieldStates={gesClass:{status:"observed",reason:"Claimed GES",evidence:[{url:url(999),kind:"page",text:"GES: C"}]}};
    const evaluated=result(value);expect(evaluated.verdict).toBe("incomplete");expect(evaluated.fieldCompleteness.numerator).toBe(6);expect(evaluated.fieldCompleteness.denominator).toBe(7);
    value.observations[0]!.fieldStates!.gesClass!.evidence[0]!.url=url(1);expect(result(value).verdict).toBe("verified_complete");
  });
  it("clears stale missing flags only when a field's new value and evidence prove its resolution",()=>{
    const value=fixture(1),state={status:"observed" as const,reason:"Observed exact title",evidence:[{url:url(1),kind:"page" as const,text:"Titre: Maison 1"}]};
    value.observations[0]!.missingFields=["title"];value.observations[0]!.fieldStates={title:state};
    value.reference.records[0]!.missingFields=["title"];value.reference.records[0]!.fieldStates={title:structuredClone(state)};
    expect(result(value).verdict).toBe("verified_complete");
    value.observations[0]!.fieldStates!.title!.evidence=[];expect(result(value).verdict).toBe("incomplete");
  });
  it("does not reconcile conflicting source status assertions merely because both have no numeric value",()=>{
    const value=fixture(1);value.reference.records[0]!.fieldStates={energyClass:{status:"not_applicable",reason:"Explicit exemption",evidence:[{url:url(1),kind:"page",text:"DPE non soumis"}]}};
    const duplicate=structuredClone(value.reference.records[0]!);duplicate.fieldStates={energyClass:{status:"absent",reason:"Explicit missing label",evidence:[{url:url(1),kind:"page",text:"DPE non renseigné"}]}};value.reference.records.push(duplicate);
    expect(result(value).verdict).toBe("inconclusive");
  });
  it("verifies every identity beyond the extension 100-result limit", () => {
    const evaluated = result(fixture(151));
    expect(evaluated.verdict).toBe("verified_complete");
    expect(evaluated.recall).toEqual({ numerator: 151, denominator: 151, ratio: 1 });
    expect(evaluated.detailCoverage.ratio).toBe(1);
    expect(evaluated.fieldCompleteness.ratio).toBe(1);
    expect(evaluated.fieldAccuracy.ratio).toBe(1);
    expect(evaluated.durationMs).toBe(60_000);
  });
  it("99 of 100 is incomplete even when the run claims verified coverage", () => {
    const value = fixture(100);
    value.observations.pop(); value.run.coverage = "verified_complete";
    const evaluated = result(value);
    expect(evaluated.verdict).toBe("incomplete");
    expect(evaluated.recall).toEqual({ numerator: 99, denominator: 100, ratio: 0.99 });
    expect(evaluated.discrepancies).toContainEqual(expect.objectContaining({ listingId: "leboncoin:100", kind: "missing_listing" }));
  });
  it("does not average providers or substitute another provider's observations", () => {
    const full = fixture(3);
    const partial = fixture(3); partial.run.id = "firecrawl"; partial.run.request.provider = "firecrawl"; partial.run.unit = "credits";
    partial.observations = partial.observations.slice(0, 1).map((item) => ({ ...item, runId: "firecrawl", provider: "firecrawl" }));
    const report = evaluateRuns(full.reference, [full, partial]);
    expect(report.results.map((item) => item.verdict)).toEqual(["verified_complete", "incomplete"]);
    expect(report.results[1]!.recall.numerator).toBe(1);
    full.observations[0]!.provider = "firecrawl";
    expect(result(full).verdict).toBe("inconclusive");
  });
  it("reports complete IDs but incomplete details and unknown accuracy separately", () => {
    const value = fixture(1);
    value.observations[0]!.detailStatus = "pending";
    value.observations[0]!.data = {};
    const evaluated = result(value);
    expect(evaluated.verdict).toBe("incomplete");
    expect(evaluated.recall.ratio).toBe(1);
    expect(evaluated.detailCoverage.ratio).toBe(0);
    expect(evaluated.fieldCompleteness.ratio).toBe(0);
    expect(evaluated.fieldAccuracy).toEqual({ numerator: 0, denominator: 0, ratio: null });
    expect(evaluated.costPerUsefulListing).toBeNull();
  });
  it("does not tolerate a single invented or numerically incorrect essential value", () => {
    const value = fixture(1);
    value.observations[0]!.data.priceEuros = 250_000.01;
    expect(result(value).verdict).toBe("incomplete");
    expect(result(value).discrepancies).toContainEqual(expect.objectContaining({ field: "priceEuros", kind: "different_value", actual: 250_000.01 }));
    delete value.reference.records[0]!.data.priceEuros;
    value.reference.records[0]!.absentFields.push("priceEuros");
    expect(result(value).discrepancies).toContainEqual(expect.objectContaining({ field: "priceEuros", expected: null }));
  });
  it("normalizes whitespace and case without hiding data omissions", () => {
    const value = fixture(1);
    value.observations[0]!.data.title = "  MAISON\n\t1 ";
    expect(result(value).verdict).toBe("verified_complete");
    delete value.observations[0]!.data.surfaceM2;
    expect(result(value).verdict).toBe("incomplete");
  });
  it("does not claim a complete search without attested reference pages and notes", () => {
    const value = fixture();
    value.reference.complete = false;
    expect(result(value).verdict).toBe("inconclusive");
    value.reference.complete = true; value.reference.pages = [];
    expect(result(value).verdict).toBe("inconclusive");
    value.reference.pages = [searchUrl]; value.reference.notes = " ";
    expect(result(value).verdict).toBe("inconclusive");
    value.reference.notes = "Review"; value.reference.pages = ["https://example.com/unrelated"];
    expect(result(value).verdict).toBe("inconclusive");
  });
  it("treats unknown reference fields as unknown, not as source absence", () => {
    const value = fixture(1);
    delete value.reference.records[0]!.data.priceEuros;
    expect(result(value).verdict).toBe("inconclusive");
    value.reference.records[0]!.absentFields.push("priceEuros");
    delete value.observations[0]!.data.priceEuros;
    expect(result(value).verdict).toBe("verified_complete");
  });
  it("requires source-attributable evidence and actual exhaustion", () => {
    const value = fixture(1);
    value.observations[0]!.evidence = [];
    expect(result(value).verdict).toBe("incomplete");
    value.observations[0]!.evidence = [{ url: url(999), text: "A different listing", kind: "citation" }];
    expect(result(value).verdict).toBe("incomplete");
    value.observations[0]!.evidence = value.reference.records[0]!.evidence;
    value.run.observedEnd = false;
    expect(result(value).verdict).toBe("incomplete");
  });
  it("does not verify a legacy captured record that still declares unretrieved fields", () => {
    const value = fixture(1); value.observations[0]!.missingFields = ["sellerName"];
    expect(result(value).verdict).toBe("incomplete");
    expect(result(value).discrepancies).toContainEqual(expect.objectContaining({ field: "missingFields", kind: "pending_detail", actual: ["sellerName"] }));
  });
  it("makes different searches or filters inconclusive", () => {
    const value = fixture(); value.run.request.searchUrl = `${searchUrl}&price=max-100000`;
    expect(result(value).verdict).toBe("inconclusive");
    value.run.request.searchUrl = `${searchUrl}&utm_source=test`;
    expect(result(value).verdict).toBe("verified_complete");
    value.reference.filters = { ...value.run.request.filters, priceMax: 100_000 };
    expect(result(value).verdict).toBe("inconclusive");
  });
  it("does not pass a known-URL shortlist against a complete search", () => {
    const value = fixture(3); value.run.request.mode = "urls"; value.run.request.urls = [url(1)];
    expect(result(value).verdict).toBe("inconclusive");
    value.run.request.urls = [url(1), url(2), url(3)];
    expect(result(value).verdict).toBe("verified_complete");
  });
  it("does not verify a partial database snapshot or a run with pending work", () => {
    const value = fixture(2); value.run.discovered = 3;
    expect(result(value).verdict).toBe("incomplete");
    value.run.discovered = 2; value.run.pending = 1;
    expect(result(value).verdict).toBe("incomplete");
    value.run.pending = 0; value.run.activeWork = { id: "pending", kind: "details", urls: [url(3)] };
    expect(result(value).verdict).toBe("incomplete");
  });
  it("separates technical blocks and budget exhaustion", () => {
    const value = fixture(); value.run.status = "blocked";
    expect(result(value).verdict).toBe("technical_limitation");
    value.run.status = "budget_exhausted";
    expect(result(value).verdict).toBe("inconclusive");
    value.run.status = "completed"; value.run.costUnknown = true;
    expect(result(value).verdict).toBe("inconclusive");
    expect(result(value).costPerUsefulListing).toBeNull();
  });
  it("keeps estimated consumption separate and labels an estimated cost per useful listing", () => {
    const value = fixture(2); value.run.cost = 0; value.run.costEstimated = 10; value.run.unit = "credits";
    const evaluated = result(value);
    expect(evaluated.cost).toBe(0);
    expect(evaluated.costEstimated).toBe(10);
    expect(evaluated.costPerUsefulListing).toBe(5);
    const markdown = reportMarkdown(evaluateRuns(value.reference, [value]), value.reference);
    expect(markdown).toContain("Provider-reported consumption | 0 credits");
    expect(markdown).toContain("Estimated consumption (account balance delta) | 10 credits");
    expect(markdown).toContain("Cost per useful listing (includes estimate) | 5.000000 credits");
    value.run.costUnknown = true;
    expect(result(value).costPerUsefulListing).toBeNull();
  });
  it("deduplicates identities without hiding conflicting observations", () => {
    const value = fixture(1);
    value.reference.records.push(structuredClone(value.reference.records[0]!));
    value.observations.push(structuredClone(value.observations[0]!));
    expect(result(value).recall.denominator).toBe(1);
    expect(result(value).verdict).toBe("verified_complete");
    value.observations[1]!.data.priceEuros = 999;
    expect(result(value).verdict).toBe("inconclusive");
  });
  it("retains all 500 image URLs in metrics and detects a single missing image", () => {
    const value = fixture(1);
    value.reference.records[0]!.data.imageUrls = Array.from({ length: 500 }, (_, i) => `https://img.leboncoin.fr/${i}.jpg`);
    value.observations[0]!.data.imageUrls = [...value.reference.records[0]!.data.imageUrls];
    expect(result(value).imageCoverage).toEqual({ numerator: 500, denominator: 500, ratio: 1 });
    value.observations[0]!.data.imageUrls.pop();
    expect(result(value).imageCoverage).toEqual({ numerator: 499, denominator: 500, ratio: 0.998 });
    expect(result(value).verdict).toBe("incomplete");
  });
});

describe("audited discrepancy reviews", () => {
  it("retains missing IDs and the original denominator after a documented site change", () => {
    const value = fixture(2); value.observations.shift();
    const evaluated = result(value, [review()]);
    expect(evaluated.verdict).toBe("inconclusive");
    expect(evaluated.recall).toEqual({ numerator: 1, denominator: 2, ratio: 0.5 });
    expect(evaluated.discrepancies).toContainEqual(expect.objectContaining({ kind: "missing_listing", resolution: "source_changed" }));
  });
  it("ignores reviews missing source evidence, a note or matching run", () => {
    const value = fixture(2); value.observations.shift();
    for (const invalid of [review({ note: " " }), review({ evidenceUrl: "https://example.com/claim" }), review({ runId: "another-run" })]) {
      const evaluated = result(value, [invalid]);
      expect(evaluated.verdict).toBe("incomplete");
      expect(evaluated.discrepancies.every((item) => !item.resolution)).toBe(true);
    }
  });
  it("cannot review a missing field or evidence into existence", () => {
    const value = fixture(1); delete value.observations[0]!.data.surfaceM2;
    expect(result(value, [review({ field: "surfaceM2", resolution: "confirmed_match" })]).verdict).toBe("incomplete");
    const fresh = fixture(1); fresh.observations[0]!.evidence = [];
    expect(result(fresh, [review({ field: "evidence", resolution: "confirmed_match" })]).verdict).toBe("incomplete");
  });
  it("cannot waive fabrication with a match review or waive data using unrelated listing evidence", () => {
    const value = fixture(1); delete value.reference.records[0]!.data.surfaceM2;
    value.reference.records[0]!.absentFields.push("surfaceM2");
    expect(result(value, [review({ field: "surfaceM2", resolution: "confirmed_match" })]).verdict).toBe("incomplete");
    const other = fixture(1); other.observations[0]!.data.title = "Different property";
    const evaluated = result(other, [review({ field: "title", resolution: "confirmed_match", evidenceUrl: url(999) })]);
    expect(evaluated.verdict).toBe("incomplete");
    expect(evaluated.discrepancies[0]!.resolution).toBeUndefined();
  });
  it("reports extra listings and requires a new reconciled reference for site changes", () => {
    const value = fixture(2); value.reference.records.pop();
    expect(result(value).verdict).toBe("incomplete");
    const evaluated = result(value, [review({ listingId: "leboncoin:2", evidenceUrl: url(2), note: "New listing published after the baseline." })]);
    expect(evaluated.verdict).toBe("inconclusive");
    expect(evaluated.detailCoverage.denominator).toBe(2);
  });
});

describe("extension reference import", () => {
  it("preserves per-field states, exact evidence and observation times instead of silently stripping them",()=>{
    const value=fixture(1);
    const fieldStates={energyClass:{status:"not_applicable" as const,reason:"Explicit DPE exemption",observedAt:at,evidence:[{url:url(1),kind:"page" as const,text:"DPE non soumis"}]}};
    value.reference.records[0]!.fieldStates=fieldStates;
    const imported=importExtensionReference(value.reference);
    expect(imported.records[0]!.fieldStates).toEqual(fieldStates);
    expect(imported.records[0]!.evidence.some(item=>item.text.includes('"status":"not_applicable"'))).toBe(true);
    expect(()=>importExtensionReference({...value.reference,records:[{...value.reference.records[0],fieldStates:{energyClass:{status:"absent",reason:"",evidence:[]}}}]})).toThrow();
  });
  it("imports uncapped extension records and preserves original text, photos and unknown fields", () => {
    const description = "Texte de description. ".repeat(2000);
    const images = Array.from({ length: 500 }, (_, i) => `https://img.leboncoin.fr/${i}.jpg`);
    const imported = importExtensionReference(Array.from({ length: 151 }, (_, i) => ({ id: `legacy-${i}`, source: "leboncoin", listingUrl: `${url(i + 1)}?tracking=yes#photo`, title: `Maison ${i}`, priceEuros: 99_999, status: "detailed", description, imageUrls: images, imageUrl: images[0], features: ["jardin"], rawTextSample: "Observed content", coordinates: { lat: 1, provenance: "source" }, scrapedAt: at })));
    expect(imported.complete).toBe(false);
    expect(imported.records).toHaveLength(151);
    expect(imported.records[0]!.url).toBe(url(1));
    expect(imported.records[0]!.data.imageUrls).toHaveLength(500);
    expect(imported.records[0]!.data.description).toBe(description);
    expect(imported.records[0]!.detailStatus).toBe("captured");
    expect(imported.records[0]!.absentFields).toEqual([]);
    expect(imported.records[0]!.evidence.some((item) => item.text.includes('"coordinates":{"lat":1,"provenance":"source"}'))).toBe(true);
  });
  it("accepts the explicit reference envelope and native observation inputs", () => {
    const value = fixture(1);
    const imported = importExtensionReference(value.reference);
    expect(imported.searchUrl).toBe(searchUrl);
    expect(imported.capturedAt).toBe(at);
    expect(imported.complete).toBe(true);
    expect(imported.records[0]!.data).toEqual(value.reference.records[0]!.data);
    expect(imported.records[0]!.evidence).toContainEqual(value.reference.records[0]!.evidence[0]);
    const unreviewed = importExtensionReference({ ...value.reference, notes: undefined });
    expect(result({ ...value, reference: { ...unreviewed, id: "reference", importedAt: at } }).verdict).toBe("inconclusive");
  });
  it("keeps list-only and failed details separate and rejects a foreign source", () => {
    const imported = importExtensionReference([{ listingUrl: url(1), status: "listing" }, { listingUrl: url(2), status: "failed", error: { id: "blocked" } }]);
    expect(imported.records.map((record) => record.detailStatus)).toEqual(["pending", "failed"]);
    expect(imported.records[1]!.error).toBe('{"id":"blocked"}');
    expect(() => importExtensionReference([{ listingUrl: url(1), source: "other" }])).toThrow(/different source/);
    expect(() => importExtensionReference([])).toThrow(/at least one/);
    expect(() => importExtensionReference(fixture(1).observations)).toThrow(/independent/);
  });
  it("exports raw counts, discrepancies and limitations in self-contained Markdown", () => {
    const value = fixture(100); value.observations.pop();
    const report = evaluateRuns(value.reference, [value]);
    const markdown = reportMarkdown(report, value.reference);
    expect(markdown).toContain("99/100 (99.00%)");
    expect(markdown).toContain("leboncoin:100");
    expect(markdown).toContain("**incomplete**");
    expect(markdown).toContain("not independently certified");
  });
});
