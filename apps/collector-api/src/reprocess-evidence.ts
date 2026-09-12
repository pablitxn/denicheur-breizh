import { z } from "zod";
import { observationInputSchema, workItemSchema, type CaptureObservation } from "@denicheur-breizh/collector-contracts";
import { detailGaps } from "./capture-quality.js";
import { canonicalIdentity, getSource } from "./sources.js";
import type { CollectorStore } from "./store.js";
import { normalizeScrapeDescription, scrapeDescription, scrapeEvidenceWarnings } from "./providers/scrape-quality.js";
import { mergeRepairFields } from "./repair.js";

/** Rebuild existing snapshots from this execution's immutable responses, without dispatching work. */
export function reprocessStoredEvidence(store: CollectorStore, runId: string) {
  const run = store.getRun(runId), source = getSource(run.request.source);
  const contextSchema = z.object({ runId: z.literal(runId), source: z.literal(source.id), provider: z.literal(run.request.provider), strategy: z.literal(run.strategy), model: z.literal(run.model), work: workItemSchema });
  const envelopeSchema = z.object({ runId: z.literal(runId), kind: z.literal("step_result"), at: z.string().datetime({ offset: true }), payload: z.object({
    observations: z.array(z.unknown()), warnings: z.array(z.string()), context: contextSchema.optional(), observedAt: z.string().datetime({ offset: true }).optional(),
    runId: z.literal(runId).optional(), source: z.literal(source.id).optional(), provider: z.literal(run.request.provider).optional(),
  }) });
  const provenanceSchema = z.object({ runId: z.literal(runId).optional(), source: z.literal(source.id).optional(), provider: z.literal(run.request.provider).optional() });
  const latest = new Map<string, { observation: CaptureObservation; artifactId: string }>();
  const incomplete = new Map<string, { observation: CaptureObservation; artifactId: string; supportingArtifactId: string }>();
  const descriptions = new Map<string, { observation: CaptureObservation; artifactId: string; supportingArtifactId: string }>();
  const scrapeWindow = new Map<string, { artifactId: string; warnings: string[]; payload: unknown }>();
  const skipped: Array<{ artifactId: string; listingId?: string; reason: string }> = [];
  let consideredArtifacts = 0;
  for (const event of store.events(runId)) {
    if (event.kind === "evidence" && event.message === "step_error") scrapeWindow.clear();
    if (run.request.provider === "firecrawl" && event.kind === "evidence" && event.message === "firecrawl_scrape" && event.artifactId) {
      try {
        const raw = z.object({ runId: z.literal(runId), kind: z.literal("firecrawl_scrape"), payload: z.object({ data: z.object({ metadata: z.object({ sourceURL: z.string() }) }).passthrough() }).passthrough() }).parse(store.readArtifact(runId, event.artifactId));
        const identity = canonicalIdentity(source.id, raw.payload.data.metadata.sourceURL);
        scrapeWindow.set(identity.id, { artifactId: event.artifactId, warnings: scrapeEvidenceWarnings(raw.payload), payload: raw.payload });
      } catch { /* A raw page with no unambiguous same-source identity cannot reclassify a listing. */ }
    }
    if (event.kind !== "evidence" || event.message !== "step_result" || !event.artifactId) continue;
    const rawScrapes = new Map(scrapeWindow); scrapeWindow.clear();
    const artifactId = event.artifactId; consideredArtifacts++;
    let raw: unknown;
    try { raw = store.readArtifact(runId, artifactId); } catch { skipped.push({ artifactId, reason: "Artifact cannot be read." }); continue; }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) { skipped.push({ artifactId, reason: "Invalid step-result envelope or execution provenance." }); continue; }
    const { payload, at } = parsed.data;
    const observedAt = payload.observedAt ?? at;
    if (Date.parse(observedAt) > Date.parse(at)) { skipped.push({ artifactId, reason: "Observation timestamp is later than the recorded response." }); continue; }
    for (const item of payload.observations) {
      const parsedItem = observationInputSchema.safeParse(item);
      if (!provenanceSchema.safeParse(item).success || !parsedItem.success) { skipped.push({ artifactId, reason: "Invalid observation or foreign execution/provider provenance." }); continue; }
      let identity;
      try { identity = canonicalIdentity(source.id, parsedItem.data.url); } catch { skipped.push({ artifactId, reason: "Observation URL does not identify a listing of this source." }); continue; }
      const reject = (reason: string) => skipped.push({ artifactId, listingId: identity.id, reason });
      const previous = store.observation(runId, identity.id);
      if (!previous || previous.provider !== run.request.provider || previous.source !== source.id || previous.runId !== runId) { reject("Replay only repairs existing observations belonging to this execution."); continue; }
      const work = payload.context?.work;
      if (work?.kind === "details" && !work.urls.some(url => { try { return canonicalIdentity(source.id, url).id === identity.id; } catch { return false; } })) { reject("Observation was not requested by the recorded detail work item."); continue; }
      if (run.request.mode === "urls" && !run.request.urls.some(url => canonicalIdentity(source.id, url).id === identity.id)) { reject("Observation was not included in this execution's immutable URL request."); continue; }
      let observation: CaptureObservation = { ...parsedItem.data, ...identity, source: source.id, provider: run.request.provider, runId, observedAt };
      const rawScrape = rawScrapes.get(identity.id);
      if (rawScrape) {
        observation = normalizeScrapeDescription(observation, rawScrape.payload);
        const description = scrapeDescription(rawScrape.payload);
        if (["expanded", "bounded"].includes(description.state) && observation.data.description) {
          descriptions.set(identity.id, { observation, artifactId, supportingArtifactId: rawScrape.artifactId });
        }
      }
      if (observation.detailStatus !== "captured") { reject("Response did not declare a complete detail; eligible source description is reviewed separately."); continue; }
      const gaps = detailGaps(observation, source.detailFields, [...payload.warnings, ...(rawScrape?.warnings ?? [])]);
      if (gaps.length) {
        reject(`Incomplete detail: ${gaps.join(", ")}.`);
        if (rawScrape?.warnings.some(warning => warning.startsWith("source_description_collapsed:"))) {
          incomplete.set(identity.id, { artifactId, supportingArtifactId: rawScrape.artifactId, observation: { ...observation, detailStatus: "failed", missingFields: gaps, error: `Stored source-page evidence shows incomplete detail: ${gaps.join(", ")}. No provider was called during this review.` } });
        }
        continue;
      }
      if (!observation.evidence.some(evidence => { try { return canonicalIdentity(source.id, evidence.url).id === identity.id && evidence.text.trim().length > 0; } catch { return false; } })) { reject("No evidence identifying this listing's detail page."); continue; }
      latest.set(identity.id, { observation, artifactId });
    }
  }
  // A newer partial request must not discard an earlier demonstrably complete snapshot.
  // Where no such snapshot exists, raw source evidence may disprove an old captured label.
  for (const [id, candidate] of incomplete) if (!latest.has(id)) latest.set(id, candidate);
  for (const [id, description] of descriptions) {
    const selected = latest.get(id);
    if (selected?.observation.detailStatus === "captured") continue;
    const base = selected?.observation ?? store.observation(runId, id)!;
    // Recover the source text even if unrelated fields remain missing. No other model
    // values from this partial response are promoted into the current snapshot.
    const observation: CaptureObservation = { ...base, data: { ...base.data, description: description.observation.data.description }, missingFields: base.missingFields.filter(field => field !== "description"), absentFields: base.absentFields.filter(field => field !== "description"), observedAt: description.observation.observedAt,
      evidence: [...base.evidence, { url: description.observation.url, kind: "page", text: `Description from the stored source page, observed at ${description.observation.observedAt}:\n${description.observation.data.description}` }] };
    const gaps = detailGaps(observation, source.detailFields);
    observation.missingFields = gaps;
    if (gaps.length) { observation.detailStatus = "failed"; observation.error = `Source description recovered from stored evidence; other detail remains incomplete: ${gaps.join(", ")}.`; }
    else if (observation.detailStatus !== "captured") observation.error = "Source description recovered from stored evidence; the original incomplete detail status is retained.";
    latest.set(id, { observation, artifactId: description.artifactId });
  }
  const applied: Array<{ listingId: string; artifactId: string; observedAt: string }> = [];
  let downgraded = 0, repairedDescriptions = 0;
  store.transaction(() => {
    const snapshots = [...latest.values()].map(({ observation }) => store.observation(runId, observation.id)!);
    if (snapshots.length) store.artifact(runId, "snapshots_before_evidence_reprocess", { observations: snapshots });
    for (const candidate of latest.values()) {
      let { observation } = candidate; const { artifactId } = candidate;
      const previous = store.observation(runId, observation.id)!;
      if(run.request.repair){
        const fields=run.request.repair.targets.find(target=>target.listingId===observation.id)?.fields??[];
        observation=mergeRepairFields(previous,observation,fields,observation.observedAt);
      }
      const before = JSON.stringify(previous);
      store.saveObservation(observation, { replaceDetailStatus: true, replaceSnapshot: true });
      if (JSON.stringify(store.observation(runId, observation.id)) !== before) {
        applied.push({ listingId: observation.id, artifactId, observedAt: observation.observedAt });
        if (previous.detailStatus === "captured" && observation.detailStatus !== "captured") downgraded++;
        if (descriptions.has(observation.id) && (previous.data.description !== observation.data.description || (previous.missingFields.includes("description") && !observation.missingFields.includes("description")))) repairedDescriptions++;
      }
    }
    if ([...latest.values()].some(({ observation }) => observation.detailStatus !== "captured")) store.updateRun(runId, { coverage: "incomplete" });
    else if (applied.length && run.coverage === "verified_complete") store.updateRun(runId, { coverage: "unknown" });
    store.artifact(runId, "evidence_reprocess", { version: "authoritative-snapshot-v2", provider: run.request.provider, consideredArtifacts, applied, downgraded, repairedDescriptions, sourceDescriptions: [...descriptions.values()].map(({ observation, artifactId, supportingArtifactId }) => ({ listingId: observation.id, artifactId, supportingArtifactId, observedAt: observation.observedAt })), sourceIncomplete: [...incomplete.values()].map(({ observation, artifactId, supportingArtifactId }) => ({ listingId: observation.id, artifactId, supportingArtifactId, missingFields: observation.missingFields })), skipped, timestampBasis: "Original response observation time when recorded; otherwise immutable artifact receipt time. No new source consultation." });
    store.event(runId, "reprocessed", `${applied.length} existing listing snapshots repaired from this run's recorded responses; no provider dispatch or coverage certification.`);
  });
  return { run: store.refresh(runId), consideredArtifacts, replayed: applied.length, downgraded, repairedDescriptions, applied, skipped };
}
