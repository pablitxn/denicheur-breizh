import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, SettingsDialog, SettingsRow } from "@denicheur-breizh/design-system";
import type { CaptureObservation, CaptureRun, DataField } from "@denicheur-breizh/collector-contracts";
import { ArrowUpRight, Download, Grid2X2, ImageOff, List, LoaderCircle, MapPin, Play, Plus, Square } from "lucide-react";
import { api, runExportUrl } from "./api";
import { useCopy, type CopyKey } from "./copy";
import { date, ErrorNotice, money, Pagination, StatusChip } from "./components";
import { strategyLabel } from "./strategies";
import { usePreferences } from "./preferences";

const fieldLabels: Partial<Record<DataField, CopyKey>> = { title: "title", priceEuros: "price", propertyType: "propertyType", location: "location", surfaceM2: "surface", rooms: "roomsCount", bedrooms: "bedroomsCount", description: "description", imageUrls: "images", sellerType: "seller" };
const isActive = (run: CaptureRun) => run.status === "queued" || run.status === "running";

export function Captures({ selectedId, onSelect, onNew }: { selectedId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const t = useCopy(); const locale = usePreferences((state) => state.locale);
  const [offset, setOffset] = useState(0);
  const runs = useQuery({ queryKey: ["runs", offset], queryFn: () => api.runs(offset), refetchInterval: 3000 });
  const current = selectedId ?? runs.data?.items[0]?.id;
  return <>
    <div className="section-toolbar"><h2>{t("recent")}</h2><Button variant="primary" onClick={onNew}><Plus size={16} aria-hidden />{t("capture")}</Button></div>
    <ErrorNotice error={runs.error} />
    {runs.isPending ? <p role="status">{t("loading")}</p> : runs.data?.items.length === 0 ? <EmptyState className="lab-empty"><div className="empty-orbit"><Plus size={32} aria-hidden /></div><h2>{t("noRuns")}</h2><p>{t("noRunsHelp")}</p><Button onClick={onNew}>{t("capture")}</Button></EmptyState> : <>
      <div className="run-picker">{runs.data?.items.map((run) => <button type="button" key={run.id} className={`run-choice ${current === run.id ? "selected" : ""}`} aria-pressed={current === run.id} onClick={() => onSelect(run.id)}><div className="run-choice-top"><span className="eyebrow">{run.request.provider === "xai" ? "xAI" : "Firecrawl"}</span><StatusChip status={run.status} /></div><strong>{run.request.name}</strong><small>{date(run.createdAt, locale)} · {run.discovered} {t("results").toLowerCase()}</small></button>)}</div>
      {runs.data && <Pagination {...runs.data} onChange={setOffset} />}
      {current && <RunDetail key={current} id={current} />}
    </>}
  </>;
}

function RunDetail({ id }: { id: string }) {
  const t = useCopy(); const locale = usePreferences((state) => state.locale);
  const client = useQueryClient(); const [offset, setOffset] = useState(0); const [layout, setLayout] = useState<"cards" | "table">("cards"); const [selected, setSelected] = useState<CaptureObservation | null>(null);
  const runQuery = useQuery({ queryKey: ["run", id], queryFn: () => api.run(id), refetchInterval: (query) => query.state.data && isActive(query.state.data) ? 2000 : false });
  const run = runQuery.data;
  useEffect(() => {
    if (run?.updatedAt) { void client.invalidateQueries({ queryKey: ["observations", id] }); void client.invalidateQueries({ queryKey: ["events", id] }); }
  }, [client, id, run?.updatedAt]);
  const observations = useQuery({ queryKey: ["observations", id, offset], queryFn: () => api.observations(id, offset), refetchInterval: run && isActive(run) ? 2000 : false });
  const events = useQuery({ queryKey: ["events", id], queryFn: () => api.events(id), refetchInterval: run && isActive(run) ? 3000 : false });
  const action = useMutation({ mutationFn: (type: "cancel" | "resume") => api[type](id), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["run", id] }), client.invalidateQueries({ queryKey: ["runs"] }), client.invalidateQueries({ queryKey: ["observations", id] })]); } });
  if (!run) return <><ErrorNotice error={runQuery.error} />{runQuery.isPending && <p role="status">{t("loading")}</p>}</>;
  const cost = run.unit === "usd" ? money(run.cost, locale, "USD") : `${run.cost.toLocaleString(locale)} ${t("credits")}`;
  return <section className="run-detail">
    <div className="panel run-summary"><div className="section-toolbar"><div><span className="eyebrow">{run.request.source} / {run.request.provider === "xai" ? "xAI" : "Firecrawl"}</span><h2>{run.request.name}</h2></div><div className="actions"><StatusChip status={run.status} />{isActive(run) ? <Button disabled={action.isPending} onClick={() => action.mutate("cancel")}><Square size={14} aria-hidden />{t("stop")}</Button> : !run.costUnknown && ["interrupted", "cancelled", "partial", "blocked"].includes(run.status) ? <Button disabled={action.isPending} onClick={() => action.mutate("resume")}><Play size={14} aria-hidden />{t("resume")}</Button> : null}<a className="btn" href={runExportUrl(id)} download><Download size={15} aria-hidden />{t("export")}</a></div></div>
      <p className="run-strategy"><span>{t("strategy")}: {strategyLabel(run.strategy, t)}</span><code>{run.strategy}</code></p>
      <div className="stats-grid">{[[t("pages"), run.pagesVisited], [t("discovered"), run.discovered], [t("details"), run.captured], [t("pending"), run.pending]].map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="coverage-strip"><div><span>{t("coverage")}</span><StatusChip coverage status={run.coverage} /></div><span>{cost} {t("confirmedCost").toLowerCase()}{(run.costEstimated ?? 0) > 0 ? ` · ${t("estimatedCost")}: ${run.unit === "usd" ? money(run.costEstimated, locale, "USD") : `${run.costEstimated} ${t("credits")}`}` : ""}{run.costUnknown ? ` · ${t("unknownConsumption")}` : ""}</span></div>
      <p className="muted">{t("coverageHelp")}</p>
      {isActive(run) && <p className="phase" role="status"><LoaderCircle className="spin" size={16} aria-hidden />{t(run.activeWork?.kind === "discover" ? "discovery" : run.activeWork?.kind === "details" ? "detail" : "preparation")}</p>}
      {run.error && <ErrorNotice error={new Error(run.error)} />}{[...new Set(run.warnings)].map(warning => <p className="workflow-notice" key={warning}>{warning}</p>)}<ErrorNotice error={action.error} />
    </div>
    <div className="section-toolbar"><h2>{t("results")} <span className="count">{observations.data?.total ?? run.discovered}</span></h2><div className="actions"><Button iconOnly aria-label={t("cards")} aria-pressed={layout === "cards"} variant={layout === "cards" ? "primary" : "ghost"} onClick={() => setLayout("cards")}><Grid2X2 size={17} aria-hidden /></Button><Button iconOnly aria-label={t("table")} aria-pressed={layout === "table"} variant={layout === "table" ? "primary" : "ghost"} onClick={() => setLayout("table")}><List size={17} aria-hidden /></Button></div></div>
    <ErrorNotice error={observations.error} />
    {observations.isPending && <p role="status">{t("loading")}</p>}
    {observations.data?.items.length === 0 && <EmptyState className="lab-empty"><ImageOff size={26} aria-hidden /><h3>{t("noResults")}</h3><p>{t("noResultsHelp")}</p></EmptyState>}
    {layout === "cards" ? <div className="listing-grid">{observations.data?.items.map((item) => <article className="listing-card" key={item.id}><button type="button" className="listing-open" onClick={() => setSelected(item)}><div className="listing-image">{item.data.imageUrls?.[0] ? <img src={item.data.imageUrls[0]} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ImageOff size={28} aria-hidden />}<span className="listing-photo-count">{item.data.imageUrls?.length ?? 0} {t("images").toLowerCase()}</span></div><div className="listing-body"><div className="listing-top"><strong className="listing-price">{money(item.data.priceEuros, locale)}</strong><ArrowUpRight size={17} aria-hidden /></div><h3>{item.data.title ?? item.externalId}</h3><p><MapPin size={13} aria-hidden />{item.data.location ?? t("unknown")}</p><div className="listing-footer"><span>{item.data.surfaceM2 != null ? `${item.data.surfaceM2} m²` : "—"}</span><StatusChip status={item.detailStatus} /></div></div></button></article>)}</div> : <div className="table-wrap"><table><thead><tr><th>{t("title")}</th><th>{t("price")}</th><th>{t("location")}</th><th>{t("surface")}</th><th>{t("status")}</th></tr></thead><tbody>{observations.data?.items.map((item) => <tr key={item.id}><td><button type="button" className="text-button" onClick={() => setSelected(item)}>{item.data.title ?? item.externalId}</button></td><td>{money(item.data.priceEuros, locale)}</td><td>{item.data.location ?? "—"}</td><td>{item.data.surfaceM2 != null ? `${item.data.surfaceM2} m²` : "—"}</td><td><StatusChip status={item.detailStatus} /></td></tr>)}</tbody></table></div>}
    {observations.data && <Pagination {...observations.data} onChange={setOffset} />}
    <details className="panel activity"><summary>{t("activity")}</summary><ErrorNotice error={events.error} /><ol>{events.data?.items.map((event) => <li key={event.id}><time>{date(event.at, locale)}</time><span>{event.message}</span></li>)}</ol></details>
    {selected && <ObservationDetail observation={selected} onClose={() => setSelected(null)} />}
  </section>;
}

function ObservationDetail({ observation: item, onClose }: { observation: CaptureObservation; onClose: () => void }) {
  const t = useCopy(); const locale = usePreferences((state) => state.locale);
  const fieldName = (field: DataField) => fieldLabels[field] ? t(fieldLabels[field]!) : ({ energyClass: "DPE", gesClass: "GES", landSurfaceM2: t("landSurface"), postedAt: t("postedAt"), features: t("features"), sellerName: t("sellerName") } as Record<string, string>)[field] ?? field;
  return <SettingsDialog title={item.data.title ?? item.externalId} closeLabel={t("close")} onClose={onClose} sections={[
    { id: "detail", label: t("details"), content: <><a className="btn" href={item.url} target="_blank" rel="noreferrer">{t("openListing")}<ArrowUpRight size={15} aria-hidden /></a><p className="muted">{t("observed")} {date(item.observedAt, locale)}</p>{Object.entries(item.data).filter(([key]) => key !== "description" && key !== "imageUrls").map(([field, value]) => <SettingsRow key={field} label={fieldName(field as DataField)}><span className="detail-value">{Array.isArray(value) ? value.join(" · ") : value ?? "—"}</span></SettingsRow>)}<h3>{t("description")}</h3><p className="description-text">{item.data.description ?? t("unknown")}</p>{item.missingFields.length > 0 && <p className="workflow-notice">{t("missing")}: {item.missingFields.map(fieldName).join(", ")}</p>}{item.absentFields.length > 0 && <p className="muted">{t("absent")}: {item.absentFields.map(fieldName).join(", ")}</p>}</> },
    { id: "images", label: `${t("images")} (${item.data.imageUrls?.length ?? 0})`, content: <div className="gallery">{item.data.imageUrls?.map((url, index) => <a href={url} key={url} target="_blank" rel="noreferrer"><img src={url} alt={`${t("images")} ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /></a>)}</div> },
    { id: "evidence", label: t("evidence"), content: <div className="evidence-list">{item.evidence.map((evidence, index) => <blockquote key={index}><a href={evidence.url} target="_blank" rel="noreferrer">{evidence.url}</a><p>{evidence.text}</p></blockquote>)}{item.evidence.length === 0 && <p>{t("missing_evidence")}</p>}</div> },
  ]} />;
}
