import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Chip, SettingsRow } from "@denicheur-breizh/design-system";
import { RefreshCw } from "lucide-react";
import { api } from "./api";
import { BudgetDisplay, date, ErrorNotice } from "./components";
import { useCopy } from "./copy";
import { usePreferences } from "./preferences";

export function Development() {
  const t = useCopy(); const locale = usePreferences((state) => state.locale); const client = useQueryClient();
  const metadata = useQuery({ queryKey: ["metadata"], queryFn: api.metadata });
  const unknown = useQuery({ queryKey: ["unknownUsage"], queryFn: api.unknownUsage });
  const refresh = useMutation({ mutationFn: api.refreshBalances, onSuccess: () => client.invalidateQueries({ queryKey: ["metadata"] }) });
  return <>
    <p className="muted">{t("diagnosticHelp")}</p><SettingsRow label={t("api")} description="collector-api · /api/v1"><Chip tone={metadata.isError ? "danger" : metadata.data ? "good" : "default"}>{t(metadata.isError ? "offline" : metadata.data ? "online" : "loading")}</Chip></SettingsRow>
    {metadata.data?.providers.map((provider) => <SettingsRow key={provider.id} label={provider.label} description={`${provider.model} · ${provider.strategy}`}><span>{t(provider.configured ? "configured" : "unconfigured")}</span></SettingsRow>)}
    {metadata.data?.budgets.map((budget) => <section key={budget.provider} className="development-budget"><h3>{budget.provider === "xai" ? "xAI" : "Firecrawl"}</h3><BudgetDisplay budget={budget} /><SettingsRow label={t("availableBalance")}><span>{budget.balance === null ? t("unknown") : `${budget.balance.toLocaleString(locale)} ${budget.unit === "usd" ? "USD" : t("credits")}`}</span></SettingsRow><SettingsRow label={t("expires")}><span>{budget.expiresAt === null ? t("unknown") : date(budget.expiresAt, locale)}</span></SettingsRow>{budget.note && <p className="muted">{budget.note}</p>}</section>)}
    <ErrorNotice error={metadata.error ?? refresh.error} /><Button disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw size={16} aria-hidden />{t("balances")}</Button>
    <ErrorNotice error={unknown.error} />{unknown.data?.items.map((operation) => <UsageReconciliation key={operation.id} operation={operation} />)}
  </>;
}
function UsageReconciliation({ operation }: { operation: { id: string; run_id: string; provider: "xai" | "firecrawl" } }) {
  const t = useCopy(); const client = useQueryClient(); const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [evidenceUrl, setEvidenceUrl] = useState("");
  const save = useMutation({ mutationFn: () => api.reconcileUsage(operation.id, { amount: Number(amount), note, evidenceUrl }), onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["metadata"] }), client.invalidateQueries({ queryKey: ["unknownUsage"] }), client.invalidateQueries({ queryKey: ["runs"] }), client.invalidateQueries({ queryKey: ["run", operation.run_id] })]) });
  return <form className="reconciliation-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}><h3>{t("reconcile")} · {operation.provider === "xai" ? "xAI" : "Firecrawl"}</h3><p className="muted">{t("reconcileHelp")}</p><code>{operation.id}</code><div className="field"><label htmlFor={`usage-${operation.id}`}>{t("amount")} ({operation.provider === "xai" ? "USD" : t("credits")})</label><input id={`usage-${operation.id}`} type="number" min="0" step="any" required value={amount} onChange={(event) => setAmount(event.target.value)} /></div><div className="field"><label htmlFor={`usage-evidence-${operation.id}`}>{t("evidenceUrl")}</label><input id={`usage-evidence-${operation.id}`} type="url" required value={evidenceUrl} placeholder={operation.provider === "xai" ? "https://console.x.ai/…" : "https://www.firecrawl.dev/…"} onChange={(event) => setEvidenceUrl(event.target.value)} /></div><div className="field"><label htmlFor={`usage-notes-${operation.id}`}>{t("notes")}</label><textarea id={`usage-notes-${operation.id}`} minLength={10} required value={note} onChange={(event) => setNote(event.target.value)} /></div><ErrorNotice error={save.error} /><Button type="submit" disabled={save.isPending}>{t("reconcile")}</Button></form>;
}
