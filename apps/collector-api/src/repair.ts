import { captureRequestSchema, dataFields, type CaptureObservation, type CaptureRequest, type CaptureRun, type DataField, type ObservationInput, type RepairRequest } from "@denicheur-breizh/collector-contracts";
import { ProviderError } from "./adapter.js";
import { detailFieldStates, detailGaps } from "./capture-quality.js";
import { repairObservationFromEvidence } from "./detail-repair-evidence.js";
import { asRecord } from "./providers/http.js";
import { canonicalIdentity } from "./sources.js";
import type { CollectorStore } from "./store.js";

export const REPAIR_STRATEGY = "firecrawl-detail-repair-v4" as const;

/** Only selected fields can change. Older source observations stay available in the lineage artifact. */
export function mergeRepairFields(base: CaptureObservation, candidate: ObservationInput, fields: readonly DataField[], observedAt = base.observedAt): CaptureObservation {
  if (canonicalIdentity(base.source, candidate.url).id !== base.id) throw new ProviderError("repair_identity_mismatch", "Repair evidence must identify the selected listing.");
  const gaps = new Set(detailGaps(candidate));
  const next: CaptureObservation = { ...base, data: { ...base.data }, missingFields: [...base.missingFields], absentFields: [...base.absentFields], fieldStates: { ...base.fieldStates }, evidence: [...base.evidence],
    fieldObservedAt:Object.fromEntries(dataFields.map(field=>[field,base.fieldObservedAt?.[field]??base.fieldStates?.[field]?.observedAt??base.observedAt])) };
  for (const [field, state] of Object.entries(next.fieldStates!)) next.fieldStates![field as DataField] = { ...state, observedAt: state.observedAt ?? base.observedAt };
  const states = detailFieldStates(candidate);
  for (const field of fields) {
    const state = states[field];
    if (gaps.has(field) || !state || state.status === "unresolved") continue;
    if (["absent", "not_applicable"].includes(state.status) && !candidate.fieldStates?.[field]) continue;
    const own = (candidate.fieldStates?.[field]?.evidence ?? candidate.evidence).filter(item => {
      try { return canonicalIdentity(base.source, item.url).id === base.id && item.text.trim().length > 0; } catch { return false; }
    });
    const evidence=[...new Map(own.map(item=>[JSON.stringify(item),item])).values()];
    if (!evidence.length) continue;
    delete next.data[field];
    if (candidate.data[field] !== undefined && candidate.data[field] !== null) Object.assign(next.data, { [field]: candidate.data[field] });
    next.missingFields = next.missingFields.filter(item => item !== field);
    next.absentFields = next.absentFields.filter(item => item !== field);
    if (state.status === "absent") next.absentFields.push(field);
    next.fieldStates![field] = { ...state, evidence, observedAt };
    next.fieldObservedAt![field] = observedAt;
    next.evidence.push(...evidence);
  }
  next.evidence = [...new Map(next.evidence.map(item => [JSON.stringify(item), item])).values()];
  next.missingFields = detailGaps(next);
  next.detailStatus = next.missingFields.length ? "failed" : "captured";
  next.error = next.missingFields.length ? `Unresolved detail fields: ${next.missingFields.join(", ")}.` : undefined;
  return next;
}

function parentGuard(run: CaptureRun): string | undefined {
  if (run.request.provider !== "firecrawl") return "Targeted repair is available for Firecrawl observations only.";
  if (["queued", "running"].includes(run.status) || run.activeWork || run.remoteJobId) return "Stop the source run and reconcile its in-flight work before creating a repair.";
  return undefined;
}

const comparableFieldValue = (value: unknown): unknown => {
  if (typeof value === "string") return value.normalize("NFKC").replace(/\s/gu, " ").replace(/ +/gu, " ").trim().toLowerCase();
  if (Array.isArray(value)) return [...new Set(value.map(item => JSON.stringify(comparableFieldValue(item))))].sort();
  return value ?? null;
};

/** A filled field can still need repair when this run's own source evidence contradicts it. */
function observedContradictions(base: CaptureObservation, candidate: ObservationInput): DataField[] {
  const before = detailFieldStates(base), after = detailFieldStates(candidate);
  return dataFields.filter(field => {
    // The deterministic helper must supply a validated, field-specific observed proof.
    // A provider's model JSON, a missing attribute, or an inherited unresolved claim cannot qualify.
    if (candidate.fieldStates?.[field]?.status !== "observed" || after[field].status !== "observed") return false;
    if (before[field].status === "unresolved") return false;
    return before[field].status !== "observed" || JSON.stringify(comparableFieldValue(base.data[field])) !== JSON.stringify(comparableFieldValue(candidate.data[field]));
  });
}

/** Read-only inspection. It never mutates snapshots, enqueues work, or calls a provider. */
export function prepareRepair(store: CollectorStore, runId: string) {
  const run = store.getRun(runId);
  type EvidenceReference = { parentRunId: string; artifactId: string };
  const latest = new Map<string, { payload: unknown; reference: EvidenceReference; at: string }>();
  const readScrape = (reference: EvidenceReference, allowedIds?: Set<string>) => {
    try {
      const owner = store.getRun(reference.parentRunId);
      if (owner.request.provider !== "firecrawl" || owner.request.source !== run.request.source) return;
      const envelope = asRecord(store.readArtifact(reference.parentRunId, reference.artifactId));
      if (envelope?.runId !== reference.parentRunId || envelope.kind !== "firecrawl_scrape" || typeof envelope.at !== "string") return;
      const payload = envelope.payload, url = asRecord(asRecord(asRecord(payload)?.data)?.metadata)?.sourceURL;
      if (typeof url !== "string" || asRecord(payload)?.success !== true || !Number.isFinite(Date.parse(envelope.at))) return;
      const identity = canonicalIdentity(run.request.source, url);
      if (allowedIds && !allowedIds.has(identity.id)) return;
      if (!store.observation(owner.id, identity.id)) return;
      const previous = latest.get(identity.id);
      if (!previous || Date.parse(envelope.at) >= Date.parse(previous.at)) latest.set(identity.id, { payload, reference, at: envelope.at });
    } catch { /* Missing or ambiguous evidence remains unresolved, never an absence assertion. */ }
  };
  if (run.request.provider === "firecrawl") for (const event of store.events(runId)) {
    if (event.kind !== "evidence" || !event.artifactId) continue;
    if (event.message === "firecrawl_scrape") readScrape({ parentRunId: runId, artifactId: event.artifactId });
    if (event.message !== "repair_lineage" || !run.request.repair) continue;
    try {
      const envelope = asRecord(store.readArtifact(runId, event.artifactId)), lineage = asRecord(envelope?.payload);
      if (envelope?.runId !== runId || envelope.kind !== "repair_lineage" || lineage?.provider !== run.request.provider || lineage.source !== run.request.source || lineage.parentRunId !== run.request.repair.parentRunId || JSON.stringify(lineage.targets) !== JSON.stringify(run.request.repair.targets)) continue;
      const allowedIds = new Set(run.request.repair.targets.map(target => target.listingId));
      // Follow only explicit raw-artifact pointers already retained in this repair's lineage.
      // There is no recursive traversal, so malformed cyclic ancestry cannot expand the lookup.
      for (const item of Array.isArray(lineage.supportingArtifacts) ? lineage.supportingArtifacts : []) {
        const reference = asRecord(item);
        if (typeof reference?.parentRunId === "string" && typeof reference.artifactId === "string") readScrape({ parentRunId: reference.parentRunId, artifactId: reference.artifactId }, allowedIds);
      }
    } catch { /* Invalid lineage is not evidence and must not trigger network recovery. */ }
  }
  const candidates = new Map<string, { observation: CaptureObservation; supportingArtifacts: EvidenceReference[] }>();
  const items = store.observations(runId).items.flatMap(observation => {
    if (observation.runId !== runId || observation.provider !== run.request.provider || observation.source !== run.request.source) return [];
    let fields = detailGaps(observation);
    const fieldStates = detailFieldStates(observation);
    let repaired = observation;
    const raw = latest.get(observation.id), supportingArtifacts: EvidenceReference[] = [];
    if (raw) {
      const candidate = repairObservationFromEvidence(observation, raw.payload, observation.url);
      const contradictions = observedContradictions(observation, candidate);
      fields = [...new Set([...fields, ...contradictions])];
      for (const field of contradictions) fieldStates[field] = { status: "unresolved",
        reason: `This run's saved source evidence contradicts the retained ${field} value or state; the proposed local repair preserves the original snapshot.`,
        evidence: candidate.fieldStates![field]!.evidence, observedAt: raw.at };
      repaired = mergeRepairFields(observation, candidate, fields,raw.at);
      repaired.observedAt=Date.parse(raw.at)>Date.parse(observation.observedAt)?raw.at:observation.observedAt;
      supportingArtifacts.push(raw.reference);
    }
    if (!fields.length) return [];
    candidates.set(observation.id, { observation: repaired, supportingArtifacts });
    const remaining = new Set(detailGaps(repaired));
    return [{ listingId: observation.id, url: observation.url, title: observation.data.title ?? observation.externalId,
      fields, fieldStates, locallyResolved: fields.filter(field => !remaining.has(field)) }];
  });
  const reason = parentGuard(run) ?? (!items.length ? "No unresolved detail fields remain in this run." : undefined);
  return { run, candidates, plan: { runId, provider: run.request.provider, strategy: REPAIR_STRATEGY, eligible: !reason,
    ...(reason ? { reason } : {}), items, total: items.length, requiresCapture: items.filter(item => item.fields.some(field => !item.locallyResolved.includes(field))).length } };
}

export function createRepair(store: CollectorStore, runId: string, input: RepairRequest, key: string, model: string): CaptureRun {
  const prepared = prepareRepair(store, runId), { run: parent, plan, candidates } = prepared;
  if (!plan.eligible) throw new ProviderError("repair_unavailable", plan.reason!);
  const requestedIds = input.listingIds ? new Set(input.listingIds) : new Set(plan.items.map(item => item.listingId));
  for (const id of requestedIds) if (!plan.items.some(item => item.listingId === id)) throw new ProviderError("repair_target_invalid", "Select incomplete listings belonging to this run.");
  const selected = plan.items.filter(item => requestedIds.has(item.listingId)).map(item => ({ ...item, fields: item.fields.filter(field => !input.fields || input.fields.includes(field)) })).filter(item => item.fields.length);
  if (!selected.length) throw new ProviderError("repair_targets_empty", "No unresolved fields match the selection.");
  const request: CaptureRequest = captureRequestSchema.parse({
    provider: "firecrawl", source: parent.request.source, strategy: REPAIR_STRATEGY, mode: "urls", name: input.name ?? `Repair: ${parent.request.name}`.slice(0, 200),
    urls: selected.map(item => item.url), filters: parent.request.filters,
    repair: { parentRunId: runId, targets: selected.map(item => ({ listingId: item.listingId, fields: item.fields })) },
  });
  return store.createRun(request, key, REPAIR_STRATEGY, model, child => {
    const snapshots = selected.map(item => store.observation(runId, item.listingId)!);
    const lineage = store.artifact(child.id, "repair_lineage", { version: "targeted-fields-v1", parentRunId: runId, provider: parent.request.provider,
      source: parent.request.source, strategy: parent.strategy, targets: request.repair!.targets, observations: snapshots,
      supportingArtifacts: selected.flatMap(item => candidates.get(item.listingId)!.supportingArtifacts),
      note: "Unchanged fields retain their original observation time. This selected URL subset does not certify the parent search or refresh its other fields." });
    for (const item of selected) {
      const original = store.observation(runId, item.listingId)!;
      const candidate = candidates.get(item.listingId)!.observation;
      const observation = { ...mergeRepairFields(original, candidate, item.fields,candidate.observedAt), runId: child.id,observedAt:candidate.observedAt };
      for(const field of item.locallyResolved.filter(field=>item.fields.includes(field))){
        const timestamp=candidate.fieldObservedAt?.[field]??candidate.observedAt;
        observation.fieldObservedAt![field]=timestamp;
        if(observation.fieldStates?.[field])observation.fieldStates[field]!.observedAt=timestamp;
      }
      store.saveObservation(observation);
      const row = store.db.prepare("SELECT data FROM work WHERE run_id=? AND work_key=?").get(child.id, `details:${item.url}`) as { data: string };
      const work = JSON.parse(row.data);
      const gaps = detailGaps(observation);
      const remaining = item.fields.filter(field => gaps.includes(field));
      work.repairFields = remaining.length ? remaining : undefined;
      store.updateWork(work);
      if (!remaining.length) store.setWorkStatus(work.id, "done");
      store.event(child.id, "repair_prepared", `${item.listingId}: ${item.fields.length - remaining.length} fields resolved locally; ${remaining.length} fields queued.`, lineage);
    }
    const progress=store.refresh(child.id);
    if(!progress.pending){
      store.updateRun(child.id,{status:progress.failed?"partial":"completed",coverage:progress.failed?"incomplete":"unknown",endedAt:new Date().toISOString()});
      store.event(child.id,"finished","Selected fields processed from stored evidence. No provider request or new source consultation.");
    }
  }).run;
}
