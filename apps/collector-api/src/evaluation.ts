import { randomUUID } from "node:crypto";
import {
  dataFields, observationInputSchema, referenceImportSchema, reviewSchema,
  type CaptureObservation, type CaptureRun, type DataField, type Discrepancy,
  type EvaluationReport, type EvaluationReview, type Metric,
  type ObservationInput, type ReferenceImport, type ReferenceRecord, type RunEvaluation,
} from "@denicheur-breizh/collector-contracts";
import { canonicalIdentity, getSource } from "./sources.js";
import { ProviderError } from "./adapter.js";

const requiredDefaults: DataField[] = ["title", "priceEuros", "propertyType", "location", "surfaceM2"];
const metric = (numerator: number, denominator: number): Metric => ({ numerator, denominator, ratio: denominator ? numerator / denominator : null });
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const present = (value: unknown): boolean => value !== undefined && value !== null && (typeof value !== "string" || value.trim().length > 0) && (!Array.isArray(value) || value.length > 0);
const normalized = (value: unknown): unknown => {
  if (typeof value === "string") return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("fr");
  if (Array.isArray(value)) return value.map(normalized);
  return value;
};
function sameValue(field: DataField, expected: unknown, actual: unknown): boolean {
  if (field === "imageUrls") return JSON.stringify(expected) === JSON.stringify(actual);
  if (field === "features" && Array.isArray(expected) && Array.isArray(actual)) {
    return JSON.stringify([...new Set(expected.map(normalized))].sort()) === JSON.stringify([...new Set(actual.map(normalized))].sort());
  }
  return JSON.stringify(normalized(expected)) === JSON.stringify(normalized(actual));
}
function sourceEvidence(item: ObservationInput, source: string): boolean {
  return item.evidence.some((evidence) => {
    if (!evidence.text.trim()) return false;
    try { return canonicalIdentity(source, evidence.url).id === canonicalIdentity(source, item.url).id; }
    catch { return false; }
  });
}
function searchIdentity(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
  url.hash = "";
  url.searchParams.sort();
  url.hostname = url.hostname.replace(/^www\./, "");
  return url.toString();
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stable).sort());
  if (value !== null && typeof value === "object") return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return JSON.stringify(value);
}

/** Accept native laboratory imports and unmodified extension records without truncating text/images.
 * Every source record is retained verbatim inside manual evidence, including unmapped fields.
 * Bare exports never assert that the search was exhaustive or that missing values were absent.
 */
export function importExtensionReference(input: unknown): ReferenceImport {
  assertIndependentReference(input);
  const envelope = Array.isArray(input) ? {} : object(input);
  const rawRecords = Array.isArray(input) ? input : envelope.records;
  if (!Array.isArray(rawRecords) || !rawRecords.length) throw new Error("Reference must contain at least one record.");
  const source = typeof envelope.source === "string" ? envelope.source : "leboncoin";
  const imported: ObservationInput[] = rawRecords.map((raw, index) => {
    const record = object(raw);
    if (record.source !== undefined && record.source !== source) throw new Error(`Reference record ${index + 1} belongs to a different source.`);
    const url = typeof record.url === "string" ? record.url : record.listingUrl;
    if (typeof url !== "string") throw new Error(`Reference record ${index + 1} has no listing URL.`);
    const identity = canonicalIdentity(source, url);
    const originalData = Object.keys(object(record.data)).length || record.data !== undefined ? object(record.data) : record;
    const data: Record<string, unknown> = {};
    for (const field of dataFields) if (originalData[field] !== undefined) data[field] = originalData[field];
    const imageUrls = [
      ...(Array.isArray(originalData.imageUrls) ? originalData.imageUrls : []),
      ...(typeof originalData.imageUrl === "string" ? [originalData.imageUrl] : []),
    ];
    if (imageUrls.length) data.imageUrls = [...new Set(imageUrls)];
    const existingEvidence = Array.isArray(record.evidence) ? record.evidence : [];
    const rawText = typeof record.rawTextSample === "string" ? record.rawTextSample : undefined;
    return observationInputSchema.parse({
      url: identity.url, data,
      detailStatus: record.detailStatus ?? (record.status === "detailed" ? "captured" : record.status === "failed" ? "failed" : "pending"),
      missingFields: record.missingFields ?? [], absentFields: record.absentFields ?? [],
      evidence: [...existingEvidence,
        ...(rawText ? [{ url: identity.url, text: rawText, kind: "page" }] : []),
        { url: identity.url, kind: "manual", text: `Original imported reference record (not an independent page verification):\n${JSON.stringify(raw)}` },
      ],
      ...(record.error !== undefined ? { error: typeof record.error === "string" ? record.error : JSON.stringify(record.error) } : {}),
    });
  });
  // Retain repeated observations for audit. Evaluation deduplicates identities and rejects conflicts.
  return referenceImportSchema.parse({
    name: envelope.name ?? "Extension reference", source,
    searchUrl: envelope.searchUrl, filters: envelope.filters,
    capturedAt: envelope.capturedAt ?? new Date().toISOString(), complete: envelope.complete ?? false,
    pages: envelope.pages ?? [], notes: envelope.notes ?? "",
    requiredFields: envelope.requiredFields ?? requiredDefaults, records: imported,
  });
}

/** Reject accidental reuse of a provider's own observations before Zod strips their provenance. */
export function assertIndependentReference(input: unknown): void {
  const envelope=object(input);
  const records=Array.isArray(input)?input:[envelope.records,envelope.observations,envelope.items].find(Array.isArray)??[];
  if (object(envelope.run).request || records.some((value:unknown)=>{
    const record=object(value);
    return record.provider === "xai" || record.provider === "firecrawl" || typeof record.runId === "string";
  })) throw new ProviderError("reference_not_independent", "Use an independent extension or manually verified reference, not collector provider observations.");
}

export function evaluateRuns(
  reference: ReferenceRecord,
  runs: Array<{ run: CaptureRun; observations: CaptureObservation[] }>,
  reviews: EvaluationReview[] = [],
): EvaluationReport {
  const expected = new Map<string, ObservationInput>();
  const referenceIssues: string[] = [];
  if (!reference.complete) referenceIssues.push("Reference search exhaustion is not attested.");
  if (!reference.pages.length || !reference.notes.trim()) referenceIssues.push("Reference completeness requires page URLs and a review note.");
  if (reference.pages.some((page) => !getSource(reference.source).accepts(page))) referenceIssues.push("Reference pages must belong to the selected source.");
  if (!reference.requiredFields.length) referenceIssues.push("Reference has no defined required fields.");
  for (const record of reference.records) {
    const id = canonicalIdentity(reference.source, record.url).id;
    const previous = expected.get(id);
    if (previous && stable(previous.data) !== stable(record.data)) referenceIssues.push(`Conflicting reference observations for ${id}; import a reconciled snapshot.`);
    if (!previous || record.detailStatus === "captured") expected.set(id, record);
    if (!sourceEvidence(record, reference.source)) referenceIssues.push(`Reference ${id} has no attributable evidence.`);
    for (const field of reference.requiredFields) if (!present(record.data[field]) && !record.absentFields.includes(field)) referenceIssues.push(`Reference ${id} does not establish whether ${field} is present or absent.`);
    for (const field of record.absentFields) if (present(record.data[field])) referenceIssues.push(`Reference ${id} simultaneously contains ${field} and marks it absent.`);
  }
  if (!expected.size) referenceIssues.push("Reference has no identities to evaluate.");
  const results = runs.map(({ run, observations }): RunEvaluation => {
    const reasons = [...referenceIssues];
    let incompatible = false;
    if (run.request.source !== reference.source) { reasons.push("Run source differs from the reference source."); incompatible = true; }
    if (run.request.mode === "search") {
      if (reference.searchUrl && run.request.searchUrl) {
        if (searchIdentity(reference.searchUrl) !== searchIdentity(run.request.searchUrl)) { reasons.push("Run native search URL differs from the reference search URL."); incompatible = true; }
      } else if (!reference.filters || stable(reference.filters) !== stable(run.request.filters)) {
        reasons.push("The reference and run do not establish identical search criteria."); incompatible = true;
      }
      if (reference.filters && stable(reference.filters) !== stable(run.request.filters)) { reasons.push("Run filters differ from the reference filters."); incompatible = true; }
    } else {
      const requested = new Set(run.request.urls.map((url) => canonicalIdentity(run.request.source, url).id));
      if (requested.size !== expected.size || [...expected.keys()].some((id) => !requested.has(id))) { reasons.push("Known-URL extraction did not request the complete reference identity set."); incompatible = true; }
    }
    const actual = new Map<string, CaptureObservation>();
    for (const observation of observations) {
      const identity = canonicalIdentity(observation.source, observation.url);
      if (observation.source !== run.request.source || observation.provider !== run.request.provider || observation.runId !== run.id || identity.id !== observation.id || identity.externalId !== observation.externalId) {
        reasons.push(`Observation ${observation.id} has inconsistent source, identity, run or provider provenance.`); incompatible = true; continue;
      }
      const previous = actual.get(identity.id);
      if (previous && stable(previous.data) !== stable(observation.data)) { reasons.push(`Conflicting provider observations for ${identity.id}.`); incompatible = true; }
      if (!previous || observation.detailStatus === "captured") actual.set(identity.id, observation);
    }
    const discrepancies: Discrepancy[] = [];
    let presentIds = 0, captured = 0, fieldsTotal = 0, fieldsPresent = 0, fieldsExact = 0, fieldsReturned = 0, imagesTotal = 0, imagesPresent = 0, useful = 0;
    for (const [id, baseline] of expected) {
      const candidate = actual.get(id);
      const before = discrepancies.length;
      if (!candidate) discrepancies.push({ listingId: id, field: "identity", kind: "missing_listing", expected: baseline.url });
      else {
        presentIds++;
        if (candidate.detailStatus !== "captured") discrepancies.push({ listingId: id, field: "detailStatus", kind: "pending_detail", expected: "captured", actual: candidate.detailStatus });
        if (candidate.missingFields.length) discrepancies.push({ listingId: id, field: "missingFields", kind: "pending_detail", expected: [], actual: candidate.missingFields });
        if (!sourceEvidence(candidate, reference.source)) discrepancies.push({ listingId: id, field: "evidence", kind: "missing_evidence", expected: "Attributable listing evidence", actual: candidate.evidence });
      }
      for (const field of dataFields) {
        const expectedValue = baseline.data[field];
        const actualValue = candidate?.data[field];
        if (present(expectedValue)) {
          fieldsTotal++;
          if (present(actualValue)) {
            fieldsPresent++; fieldsReturned++;
            if (sameValue(field, expectedValue, actualValue)) fieldsExact++;
            else discrepancies.push({ listingId: id, field, kind: "different_value", expected: expectedValue, actual: actualValue });
          } else discrepancies.push({ listingId: id, field, kind: "missing_field", expected: expectedValue });
        } else if (baseline.absentFields.includes(field) && present(actualValue)) {
          fieldsReturned++;
          discrepancies.push({ listingId: id, field, kind: "different_value", expected: null, actual: actualValue });
        }
        if (candidate?.absentFields.includes(field) && present(actualValue)) discrepancies.push({ listingId: id, field, kind: "different_value", expected: "Field marked absent must not contain a value", actual: actualValue });
      }
      const expectedImages = new Set(baseline.data.imageUrls ?? []);
      const actualImages = new Set(candidate?.data.imageUrls ?? []);
      imagesTotal += expectedImages.size;
      imagesPresent += [...expectedImages].filter((url) => actualImages.has(url)).length;
      if (candidate && candidate.detailStatus === "captured" && sourceEvidence(candidate, reference.source) && before === discrepancies.length) useful++;
    }
    // Detail completion is measured for every discovered identity, not only expected ones.
    for (const [id, candidate] of actual) {
      if (candidate.detailStatus === "captured") captured++;
      if (!expected.has(id)) {
        discrepancies.push({ listingId: id, field: "identity", kind: "extra_listing", actual: candidate.url });
        if (candidate.detailStatus !== "captured") discrepancies.push({ listingId: id, field: "detailStatus", kind: "pending_detail", expected: "captured", actual: candidate.detailStatus });
      }
    }
    const validReviews = reviews.flatMap((review) => {
      const parsed = reviewSchema.safeParse(review);
      if (!parsed.success || review.referenceId !== reference.id || review.runId !== run.id) return [];
      try {
        const url = new URL(review.evidenceUrl);
        const sourceUrl = new URL(reference.records[0]!.url);
        if (url.hostname.replace(/^www\./, "") !== sourceUrl.hostname.replace(/^www\./, "")) return [];
        if (review.resolution === "confirmed_match" && canonicalIdentity(reference.source, review.evidenceUrl).id !== review.listingId) return [];
      } catch { return []; }
      return [parsed.data];
    }).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
    let sourceChanges = false;
    for (const discrepancy of discrepancies) {
      const review = [...validReviews].reverse().find((item) => item.listingId === discrepancy.listingId && item.field === discrepancy.field);
      if (!review) continue;
      discrepancy.resolution = review.resolution;
      if (review.resolution === "source_changed" || review.resolution === "source_absent") sourceChanges = true;
    }
    // A review may establish equivalent text, but cannot supply missing records, data or evidence.
    const blocking = discrepancies.filter((item) => item.kind !== "different_value" || item.expected === null || item.resolution !== "confirmed_match");
    if (sourceChanges) reasons.push("Reviewed source changes are retained in raw metrics; import a reconciled reference before verifying completeness.");
    if (!run.observedEnd && run.request.mode === "search") reasons.push("Search exhaustion was not observed.");
    if (run.pending > 0 || run.activeWork) reasons.push("Run still has pending work.");
    if (run.failed > 0) reasons.push("Run contains failed detail retrievals.");
    const snapshotIncomplete = run.discovered !== actual.size || run.captured !== captured;
    if (snapshotIncomplete) reasons.push("The evaluated observation snapshot does not match the run's discovered/detail counters.");
    if (run.costUnknown) reasons.push("Provider consumption is unknown and requires reconciliation.");
    if ((run.costEstimated ?? 0) > 0) reasons.push("Estimated consumption is derived from the account balance and is kept separate from provider-reported charges. Cost per useful listing includes this estimate.");
    if (blocking.length) reasons.push(`${blocking.length} unresolved discrepancies; raw denominators are unchanged by reviews.`);
    const rawRecall = metric(presentIds, expected.size);
    const operationallyUnfinished = ["queued", "running", "budget_exhausted", "cancelled", "interrupted"].includes(run.status);
    let verdict: RunEvaluation["verdict"];
    if (incompatible || referenceIssues.length || sourceChanges || operationallyUnfinished || run.costUnknown) verdict = "inconclusive";
    else if (run.status === "blocked") verdict = "technical_limitation";
    else if (blocking.length || rawRecall.ratio !== 1 || captured !== actual.size || snapshotIncomplete || run.status !== "completed" || run.pending > 0 || run.activeWork || run.failed > 0 || (!run.observedEnd && run.request.mode === "search")) verdict = "incomplete";
    else verdict = "verified_complete";
    if (operationallyUnfinished) reasons.push(`Run is ${run.status}; it is not a completed benchmark.`);
    if (run.status === "blocked") reasons.push(run.error ?? "Provider encountered a technical block.");
    if (verdict === "verified_complete") reasons.push("All reference identities and required observations match an attested reference; this does not independently certify source-wide exhaustion.");
    const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const end = run.endedAt ? Date.parse(run.endedAt) : NaN;
    return {
      runId: run.id, provider: run.request.provider, verdict, reasons: [...new Set(reasons)],
      recall: rawRecall, detailCoverage: metric(captured, actual.size),
      fieldCompleteness: metric(fieldsPresent, fieldsTotal), fieldAccuracy: metric(fieldsExact, fieldsReturned), imageCoverage: metric(imagesPresent, imagesTotal),
      discrepancies, cost: run.cost, costEstimated: run.costEstimated ?? 0, unit: run.unit, costPerUsefulListing: useful && !run.costUnknown ? (run.cost + (run.costEstimated ?? 0)) / useful : null,
      durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
    };
  });
  return { id: randomUUID(), referenceId: reference.id, createdAt: new Date().toISOString(), referenceComplete: reference.complete && !referenceIssues.length, results };
}

const markdownText = (value: unknown): string => String(typeof value === "string" ? value : JSON.stringify(value) ?? "—").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const displayMetric = (value: Metric): string => `${value.numerator}/${value.denominator} (${value.ratio === null ? "not assessable" : `${(value.ratio * 100).toFixed(2)}%`})`;
export function reportMarkdown(report: EvaluationReport, reference?: ReferenceRecord): string {
  const lines = ["# Collector evaluation", "", `Reference: ${markdownText(reference?.name ?? report.referenceId)}`, `Generated: ${report.createdAt}`, "", `Reference completeness: ${report.referenceComplete ? "attested; source-wide exhaustion is not independently certified" : "unproven"}.`, "", "Each provider is evaluated independently. Counts and denominators remain raw after reviews. 99% is incomplete.", ""];
  if (reference) lines.push(`Source: ${markdownText(reference.source)} · Captured: ${reference.capturedAt}`, `Notes: ${markdownText(reference.notes)}`, "");
  for (const result of report.results) {
    lines.push(`## ${result.provider} · ${markdownText(result.runId)}`, "", `**${result.verdict}**`, "", "| Measure | Result |", "|---|---|",
      `| Identity coverage | ${displayMetric(result.recall)} |`, `| Detail processing | ${displayMetric(result.detailCoverage)} |`,
      `| Field completeness | ${displayMetric(result.fieldCompleteness)} |`, `| Returned field accuracy | ${displayMetric(result.fieldAccuracy)} |`,
      `| Image URLs recovered | ${displayMetric(result.imageCoverage)} |`, `| Provider-reported consumption | ${result.cost} ${result.unit} |`,
      `| Estimated consumption (account balance delta) | ${result.costEstimated ?? 0} ${result.unit} |`,
      `| Cost per useful listing${(result.costEstimated ?? 0) > 0 ? " (includes estimate)" : ""} | ${result.costPerUsefulListing === null ? "unknown / no useful listings" : `${result.costPerUsefulListing.toFixed(6)} ${result.unit}`} |`,
      `| Duration | ${result.durationMs === null ? "unknown" : `${(result.durationMs / 1000).toFixed(1)} s`} |`, "",
      ...result.reasons.map((reason) => `- ${markdownText(reason)}`), "");
    if (result.discrepancies.length) lines.push("| Listing | Field | Difference | Expected | Observed | Review |", "|---|---|---|---|---|---|", ...result.discrepancies.map((item) => `| ${markdownText(item.listingId)} | ${markdownText(item.field)} | ${item.kind} | ${markdownText(item.expected)} | ${markdownText(item.actual)} | ${item.resolution ?? "unresolved"} |`), "");
  }
  lines.push("Coverage is established only for the supplied reference and observation window. Simulated runs verify software behavior, not live website access.", "");
  return lines.join("\n");
}
