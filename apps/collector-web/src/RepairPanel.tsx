import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@denicheur-breizh/design-system";
import { dataFields, repairRequestSchema, type CaptureRun, type DataField, type RepairRequest } from "@denicheur-breizh/collector-contracts";
import { ArrowRight, RefreshCw } from "lucide-react";
import { api, ApiError, type RepairPlan } from "./api";
import { ErrorNotice } from "./components";
import { useCopy } from "./copy";
import { fieldLabel, FieldStateList } from "./fields";
import { strategyLabel } from "./strategies";

interface RepairIntents { last?: RepairRequest; keys: Record<string, string> }
const intentKey = (id: string) => `denicheur:collector-repair:${id}`;
function readIntents(id: string): RepairIntents {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(intentKey(id)) ?? "null");
    if (!saved || typeof saved !== "object") return { keys: {} };
    const input = saved as { last?: unknown; keys?: unknown };
    const last = repairRequestSchema.safeParse(input.last);
    const keys = input.keys && typeof input.keys === "object" ? Object.fromEntries(Object.entries(input.keys).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    return { keys, last: last.success ? last.data : undefined };
  } catch { return { keys: {} }; }
}

export function RepairPanel({ run, onCreated }: { run: CaptureRun; onCreated: (id: string) => void }) {
  const t = useCopy(); const [open, setOpen] = useState(false);
  const plan = useQuery({ queryKey: ["repair-plan", run.id, run.updatedAt], queryFn: () => api.repairPlan(run.id), enabled: open });
  return <section className="panel repair-panel" aria-label={t("repairTitle")}>
    <div className="section-toolbar"><div><h2>{t("repairTitle")}</h2><p className="muted">{t("repairIntro")}</p></div><Button aria-expanded={open} onClick={() => setOpen(!open)}><RefreshCw size={15} aria-hidden />{t(open ? "repairHide" : "repairInspect")}</Button></div>
    {open && <><p className="workflow-notice">{t("repairScope")}</p><ErrorNotice error={plan.error} />{plan.isPending && <p role="status">{t("loading")}</p>}{plan.isError && <Button onClick={() => void plan.refetch()}>{t("refresh")}</Button>}
      {plan.data && (plan.data.eligible ? <RepairSelection key={run.id} run={run} plan={plan.data} onCreated={onCreated} /> : <p className="muted">{t(plan.data.items.length ? "repairUnavailable" : "repairNoGaps")}</p>)}
    </>}
  </section>;
}

function RepairSelection({ run, plan, onCreated }: { run: CaptureRun; plan: RepairPlan; onCreated: (id: string) => void }) {
  const t = useCopy(); const client = useQueryClient();
  const [saved] = useState(() => readIntents(run.id)); const intents = useRef(saved);
  const [listingIds, setListingIds] = useState<string[]>(() => saved.last?.listingIds ?? plan.items.map(item => item.listingId));
  const availableFields = dataFields.filter(field => plan.items.some(item => item.fields.includes(field)));
  const [fields, setFields] = useState<DataField[]>(() => saved.last?.fields ?? availableFields);
  const metadata = useQuery({ queryKey: ["metadata"], queryFn: api.metadata });
  const selected = plan.items.filter(item => listingIds.includes(item.listingId)).map(item => ({ ...item, fields: item.fields.filter(field => fields.includes(field)) })).filter(item => item.fields.length);
  const localCount = selected.reduce((sum, item) => sum + item.fields.filter(field => item.locallyResolved.includes(field)).length, 0);
  const paidCount = selected.reduce((sum, item) => sum + item.fields.filter(field => !item.locallyResolved.includes(field)).length, 0);
  const paidListings = selected.filter(item => item.fields.some(field => !item.locallyResolved.includes(field))).length;
  const provider = metadata.data?.providers.find(item => item.id === "firecrawl");
  const budget = metadata.data?.budgets.find(item => item.provider === "firecrawl");
  const paidBlocked = paidCount > 0 && (!provider?.configured || !budget || budget.unknownCalls > 0 || budget.remaining <= 0);
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      // Canonical selection + persisted key makes a lost response safe to retry, including after reload.
      const body = repairRequestSchema.parse({ listingIds: selected.map(item => item.listingId).sort(), fields: dataFields.filter(field => selected.some(item => item.fields.includes(field))) });
      const signature = JSON.stringify(body);
      const key = intents.current.keys[signature] ?? crypto.randomUUID();
      intents.current = { last: body, keys: { ...intents.current.keys, [signature]: key } };
      try { sessionStorage.setItem(intentKey(run.id), JSON.stringify(intents.current)); } catch { /* In-memory retry identity remains available if storage is disabled. */ }
      return api.repair(run.id, body, key);
    },
    onSuccess(child) {
      client.setQueryData(["run", child.id], child);
      void client.invalidateQueries({ queryKey: ["runs"] });
      void client.invalidateQueries({ queryKey: ["metadata"] });
      onCreated(child.id);
    },
  });
  const toggleListing = (id: string, checked: boolean) => setListingIds(current => checked ? [...current, id] : current.filter(item => item !== id));
  return <form onSubmit={event => { event.preventDefault(); if (selected.length && !paidBlocked && !mutation.isPending) mutation.mutate(); }}>
    <p className="run-strategy"><span>{t("strategy")}: {strategyLabel(plan.strategy, t)}</span><code>{plan.strategy}</code></p>
    {plan.strategy === "firecrawl-native-inventory-v5" && <p className="muted">{t("strategyInventoryHelp")}</p>}
    {plan.strategy === "firecrawl-gallery-audit-v6" && <p className="muted">{t("strategyGalleryAuditHelp")}</p>}
    {plan.strategy === "firecrawl-gallery-walk-v7" && <p className="muted">{t("strategyGalleryWalkHelp")}</p>}
    <fieldset disabled={mutation.isPending}><legend>{t("repairFields")}</legend><div className="inline-options repair-field-options">{availableFields.map(field => <label key={field}><input type="checkbox" checked={fields.includes(field)} onChange={event => setFields(current => event.target.checked ? [...current, field] : current.filter(item => item !== field))} />{fieldLabel(field, t)}</label>)}</div></fieldset>
    <fieldset className="repair-listings" disabled={mutation.isPending}><legend>{t("repairListings")} ({plan.total})</legend><label className="checkbox-line"><input type="checkbox" checked={plan.items.every(item => listingIds.includes(item.listingId))} onChange={event => setListingIds(event.target.checked ? plan.items.map(item => item.listingId) : [])} />{t("repairSelectAll")}</label>
      {plan.items.map(item => {
        const included = item.fields.filter(field => fields.includes(field));
        const local = included.filter(field => item.locallyResolved.includes(field));
        const pending = included.filter(field => !item.locallyResolved.includes(field));
        return <article className="repair-listing" key={item.listingId}><label className="repair-listing-choice"><input type="checkbox" checked={listingIds.includes(item.listingId)} onChange={event => toggleListing(item.listingId, event.target.checked)} /><strong>{item.title}</strong><code>{item.listingId}</code></label><div className="repair-listing-info"><a href={item.url} target="_blank" rel="noreferrer">{t("openListing")}</a>{local.length > 0 && <p><span>{t("repairLocal")}:</span> {local.map(field => fieldLabel(field, t)).join(", ")}</p>}{pending.length > 0 && <p><span>{t("repairPaidFields")}:</span> {pending.map(field => fieldLabel(field, t)).join(", ")}</p>}{!included.length && <p className="muted">{t("repairNoSelectedFields")}</p>}<details><summary>{t("fieldStates")}</summary><FieldStateList states={item.fieldStates} fields={item.fields} /></details></div></article>;
      })}
    </fieldset>
    <div className="repair-summary" role="status"><span><strong>{selected.length}</strong> {t("repairSelectedListings")}</span><span><strong>{localCount}</strong> {t("repairLocalCount")}</span><span><strong>{paidCount}</strong> {t("repairPaidCount")} · <strong>{paidListings}</strong> {t("repairCaptureCount")}</span></div>
    {!selected.length && <p className="muted">{t("repairSelectionEmpty")}</p>}
    {paidCount === 0 && selected.length > 0 && <p className="muted">{t("repairLocalOnly")}</p>}
    {paidBlocked && <p className="workflow-notice">{t(!provider?.configured ? "configurationNeeded" : (budget?.unknownCalls ?? 0) > 0 ? "unknownConsumption" : "repairBudgetBlocked")}</p>}
    <ErrorNotice error={metadata.error} /><ErrorNotice error={mutation.error} />
    {mutation.isError && <p className="muted">{t(mutation.error instanceof ApiError && mutation.error.status === 409 ? "repairConflictHelp" : "repairRetryHelp")}</p>}
    <Button type="submit" variant="primary" disabled={!selected.length || paidBlocked || mutation.isPending}>{t(mutation.isPending ? "loading" : "repairStart")}<ArrowRight size={16} aria-hidden /></Button>
  </form>;
}
