import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Select, SettingsDialog } from "@denicheur-breizh/design-system";
import { dataFields, referenceImportSchema, type Discrepancy, type EvaluationReport, type EvaluationReview, type ReferenceImport, type RunEvaluation } from "@denicheur-breizh/collector-contracts";
import { Check, Download, FileJson, GitCompareArrows, Upload } from "lucide-react";
import { api, reportExportUrl } from "./api";
import { useCopy, type CopyKey } from "./copy";
import { date, ErrorNotice, money, Pagination, StatusChip } from "./components";
import { usePreferences } from "./preferences";

export function referenceRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["records", "items", "observations"]) if (Array.isArray(object[key])) return object[key];
  }
  throw new Error("No reference records found in this JSON file.");
}

export function Evaluation() {
  const t = useCopy(); const locale = usePreferences((state) => state.locale); const client = useQueryClient();
  const [importOpen, setImportOpen] = useState(false); const [referenceId, setReferenceId] = useState("");
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]); const [runOffset, setRunOffset] = useState(0);
  const references = useQuery({ queryKey: ["references"], queryFn: api.references });
  const runs = useQuery({ queryKey: ["runs", runOffset], queryFn: () => api.runs(runOffset) });
  const [reportOffset, setReportOffset] = useState(0);
  const [selectedReportId, setSelectedReportId] = useState(() => new URLSearchParams(window.location.search).get("report") ?? "");
  const reports = useQuery({ queryKey: ["evaluations", reportOffset], queryFn: () => api.reports(reportOffset) });
  const savedReport = useQuery({ queryKey: ["evaluation", selectedReportId], queryFn: () => api.report(selectedReportId), enabled: !!selectedReportId });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedReportId) url.searchParams.set("report", selectedReportId); else url.searchParams.delete("report");
    window.history.replaceState(null, "", url);
  }, [selectedReportId]);
  const evaluation = useMutation({ mutationFn: api.evaluate, onSuccess: async (report) => {
    client.setQueryData(["evaluation", report.id], report);
    setSelectedReportId(report.id);
    setReportOffset(0);
    await client.invalidateQueries({ queryKey: ["evaluations"] });
  } });
  return <>
    <div className="comparison-intro panel"><GitCompareArrows size={28} aria-hidden /><div><h2>{t("compare")}</h2><p>{t("comparisonHelp")}</p></div><Button onClick={() => setImportOpen(true)}><Upload size={16} aria-hidden />{t("importReference")}</Button></div>
    <section className="panel saved-reports" aria-label={t("reportHistory")}>
      <div className="section-toolbar"><div><h2>{t("reportHistory")}</h2><p className="muted">{t("reportHistoryHelp")}</p></div></div>
      <ErrorNotice error={reports.error} />
      {reports.isPending && <p role="status">{t("loading")}</p>}
      {reports.data?.total === 0 && <p className="muted">{t("noReports")}</p>}
      <div className="saved-report-list">{reports.data?.items.map((report) => <button type="button" className={`saved-report-choice ${selectedReportId === report.id ? "selected" : ""}`} aria-pressed={selectedReportId === report.id} key={report.id} onClick={() => setSelectedReportId(report.id)}>
        <strong>{report.referenceName}</strong><time>{date(report.createdAt, locale)}</time>
        <div className="saved-report-providers">{report.results.map((result) => <span key={result.runId}>{result.provider === "xai" ? "xAI" : "Firecrawl"}<StatusChip status={result.verdict} /></span>)}</div>
        <span className="saved-report-open">{t("openReport")}</span>
      </button>)}</div>
      {reports.data && <Pagination {...reports.data} onChange={setReportOffset} />}
    </section>
    <ErrorNotice error={references.error ?? runs.error} />
    <form className="panel evaluation-form" onSubmit={(event) => { event.preventDefault(); evaluation.mutate({ referenceId, runIds: selectedRuns }); }}>
      <div className="field"><label htmlFor="evaluation-reference">{t("reference")}</label><Select id="evaluation-reference" required value={referenceId} onChange={(event) => setReferenceId(event.target.value)}><option value="">{t("noReference")}</option>{references.data?.items.map((reference) => <option value={reference.id} key={reference.id}>{reference.name} · {reference.records.length} · {date(reference.capturedAt, locale)}</option>)}</Select></div>
      <fieldset className="run-selections"><legend>{t("history")}</legend>{runs.data?.items.map((run) => <label key={run.id}><input type="checkbox" checked={selectedRuns.includes(run.id)} onChange={(event) => setSelectedRuns((current) => event.target.checked ? [...current, run.id] : current.filter((id) => id !== run.id))} /><span><strong>{run.request.name}</strong><small>{run.request.provider === "xai" ? "xAI" : "Firecrawl"} · {run.discovered} · {date(run.createdAt, locale)}</small></span><StatusChip status={run.status} /></label>)}</fieldset>
      {runs.data && <Pagination {...runs.data} onChange={setRunOffset} />}
      <div className="actions"><Button type="submit" variant="primary" disabled={!referenceId || !selectedRuns.length || evaluation.isPending}><GitCompareArrows size={16} aria-hidden />{t(evaluation.isPending ? "loading" : "evaluate")}</Button><ErrorNotice error={evaluation.error} /></div>
    </form>
    <ErrorNotice error={savedReport.error} />
    {selectedReportId && savedReport.isPending && <p role="status">{t("loading")}</p>}
    {savedReport.data && <Report key={savedReport.data.id} report={savedReport.data} onReview={() => evaluation.mutate({ referenceId: savedReport.data.referenceId, runIds: savedReport.data.results.map((result) => result.runId) })} />}
    {!selectedReportId && <EmptyState className="lab-empty"><FileJson size={29} aria-hidden /><h3>{t("comparisonIntro")}</h3><p>{t("coverageHelp")}</p></EmptyState>}
    {importOpen && <ImportReference onClose={() => setImportOpen(false)} onImported={(id) => { setReferenceId(id); setImportOpen(false); }} />}
  </>;
}

function ImportReference({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  const t = useCopy(); const client = useQueryClient();
  const [name, setName] = useState(""); const [records, setRecords] = useState<unknown[]>([]); const [standard, setStandard] = useState(false);
  const [complete, setComplete] = useState(false); const [notes, setNotes] = useState(""); const [pages, setPages] = useState(""); const [searchUrl, setSearchUrl] = useState("");
  const [capturedAt, setCapturedAt] = useState(""); const [parseError, setParseError] = useState<Error | null>(null);
  const [metadata, setMetadata] = useState<Partial<ReferenceImport>>({});
  const [requiredFields, setRequiredFields] = useState<ReferenceImport["requiredFields"]>(["title", "priceEuros", "propertyType", "location", "surfaceM2"]);
  const imported = useMutation({ mutationFn: () => {
    const reference = { ...metadata, name, source: metadata.source ?? "leboncoin", capturedAt: new Date(capturedAt).toISOString(), complete,
      pages: pages.split(/\s+/).filter(Boolean), searchUrl: searchUrl.trim() || undefined, notes,
      requiredFields, records,
    };
    return standard ? api.importReference(referenceImportSchema.parse(reference)) : api.importExtension(reference);
  }, onSuccess: async (reference) => { await client.invalidateQueries({ queryKey: ["references"] }); onImported(reference.id); } });
  return <SettingsDialog title={t("importReference")} closeLabel={t("close")} onClose={onClose} sections={[{ id: "import", label: t("reference"), description: t("referenceHelp"), content: <form onSubmit={(event) => { event.preventDefault(); imported.mutate(); }}>
    <div className="field"><label htmlFor="reference-file">JSON</label><input id="reference-file" type="file" accept="application/json,.json" required onChange={async (event) => {
      const file = event.target.files?.[0]; if (!file) return;
      setParseError(null); setRecords([]);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const parsedRecords = referenceRecords(parsed); setRecords(parsedRecords);
        const valid = referenceImportSchema.safeParse(parsed);
        const envelope = referenceImportSchema.omit({ records: true }).safeParse(parsed);
        setStandard(valid.success || parsedRecords.every((record) => record && typeof record === "object" && "data" in record && "url" in record));
        if (envelope.success) {
          setMetadata(envelope.data); setRequiredFields(envelope.data.requiredFields); setName(envelope.data.name); setComplete(envelope.data.complete); setNotes(envelope.data.notes); setPages(envelope.data.pages.join("\n")); setSearchUrl(envelope.data.searchUrl ?? "");
          const observed = new Date(envelope.data.capturedAt); setCapturedAt(new Date(observed.getTime() - observed.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
        } else { setMetadata({}); setName(file.name.replace(/\.json$/i, "")); setComplete(false); }
      } catch { setParseError(new Error(t("invalidJson"))); }
    }} /><small>{records.length} {t("results").toLowerCase()}</small></div>
    <div className="field"><label htmlFor="reference-name">{t("referenceName")}</label><input id="reference-name" value={name} required onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label htmlFor="reference-date">{t("capturedAt")}</label><input id="reference-date" type="datetime-local" value={capturedAt} required onChange={(event) => setCapturedAt(event.target.value)} /></div>
    <div className="field"><label htmlFor="reference-search">{t("nativeUrl")}</label><input id="reference-search" type="url" value={searchUrl} onChange={(event) => setSearchUrl(event.target.value)} /></div>
    <div className="field"><label htmlFor="reference-pages">{t("searchPages")}</label><textarea id="reference-pages" rows={4} value={pages} onChange={(event) => setPages(event.target.value)} /></div>
    <fieldset className="property-types"><legend>{t("requiredFields")}</legend><div className="inline-options">{dataFields.map((field) => <label key={field}><input type="checkbox" checked={requiredFields.includes(field)} onChange={(event) => setRequiredFields((current) => event.target.checked ? [...current, field] : current.filter((item) => item !== field))} />{fieldLabel(field, t)}</label>)}</div></fieldset>
    <label className="checkbox-line"><input type="checkbox" checked={complete} onChange={(event) => setComplete(event.target.checked)} />{t("referenceComplete")}</label>
    <div className="field"><label htmlFor="reference-notes">{t("notes")}</label><textarea id="reference-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></div>
    <ErrorNotice error={parseError ?? imported.error} /><Button type="submit" variant="primary" disabled={!records.length || imported.isPending}><Upload size={16} aria-hidden />{t(imported.isPending ? "loading" : "import")}</Button>
  </form> }]} />;
}

function fieldLabel(field: string, t: (key: CopyKey) => string) {
  const names: Record<string, CopyKey> = { title: "title", priceEuros: "price", propertyType: "propertyType", location: "location", surfaceM2: "surface", landSurfaceM2: "landSurface", rooms: "roomsCount", bedrooms: "bedroomsCount", description: "description", sellerName: "sellerName", sellerType: "seller", postedAt: "postedAt", features: "features", imageUrls: "images" };
  return field === "energyClass" ? "DPE" : field === "gesClass" ? "GES" : names[field] ? t(names[field]) : field;
}

function Report({ report, onReview }: { report: EvaluationReport; onReview: () => void }) {
  const t = useCopy();
  return <section className="report" aria-label={t("report")}><div className="section-toolbar"><h2>{t("report")}</h2><div className="actions"><a className="btn" download href={reportExportUrl(report.id, "json")}><Download size={15} aria-hidden />JSON</a><a className="btn" download href={reportExportUrl(report.id, "markdown")}><Download size={15} aria-hidden />Markdown</a></div></div><div className="evaluation-results">{report.results.map((result) => <ProviderEvaluation result={result} referenceId={report.referenceId} key={result.runId} onReview={onReview} />)}</div></section>;
}

function ProviderEvaluation({ result, referenceId, onReview }: { result: RunEvaluation; referenceId: string; onReview: () => void }) {
  const t = useCopy(); const locale = usePreferences((state) => state.locale);
  const [review, setReview] = useState<Discrepancy | null>(null); const [offset, setOffset] = useState(0);
  return <article className="panel provider-evaluation"><div className="section-toolbar"><h2>{result.provider === "xai" ? "xAI" : "Firecrawl"}</h2><StatusChip status={result.verdict} /></div>
    <div className="evaluation-metrics">{(["recall", "detailCoverage", "fieldCompleteness", "fieldAccuracy", "imageCoverage"] as const).map((key) => <div key={key}><span>{t(key)}</span><strong>{result[key].ratio === null ? "—" : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result[key].ratio * 100)}%`}</strong><small>{result[key].numerator} / {result[key].denominator}</small></div>)}</div>
    <p className="muted">{result.unit === "usd" ? money(result.cost, locale, "USD") : `${result.cost} ${t("credits")}`} {t("confirmedCost").toLowerCase()}{(result.costEstimated ?? 0) > 0 ? ` · ${t("estimatedCost")}: ${result.unit === "usd" ? money(result.costEstimated, locale, "USD") : `${result.costEstimated} ${t("credits")}`}` : ""} · {result.durationMs == null ? "—" : `${Math.round(result.durationMs / 1000)} s`}</p>
    {result.reasons.length > 0 && <ul className="evaluation-reasons">{result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <h3>{t("differences")} <span className="count">{result.discrepancies.length}</span></h3>
    {result.discrepancies.length === 0 ? <p className="muted">{t("noDifferences")}</p> : <div className="table-wrap"><table><thead><tr><th>{t("title")}</th><th>{t("details")}</th><th>{t("inspection")}</th></tr></thead><tbody>{result.discrepancies.slice(offset, offset + 20).map((item, index) => <tr key={`${item.listingId}-${item.field}-${index}`}><td><code>{item.listingId}</code></td><td><span>{t(item.kind)}</span><small className="block-muted">{fieldLabel(item.field, t)}</small></td><td><Button size="sm" onClick={() => setReview(item)}>{item.resolution ? <Check size={14} aria-hidden /> : null}{t("inspection")}</Button></td></tr>)}</tbody></table></div>}
    <Pagination offset={offset} total={result.discrepancies.length} limit={20} onChange={setOffset} />
    {review && <ReviewModal discrepancy={review} referenceId={referenceId} runId={result.runId} onClose={() => setReview(null)} onSaved={() => { setReview(null); onReview(); }} />}
  </article>;
}

function ReviewModal({ discrepancy, referenceId, runId, onClose, onSaved }: { discrepancy: Discrepancy; referenceId: string; runId: string; onClose: () => void; onSaved: () => void }) {
  const t = useCopy(); const [resolution, setResolution] = useState<EvaluationReview["resolution"]>(discrepancy.resolution ?? "confirmed_error"); const [note, setNote] = useState(""); const [evidenceUrl, setEvidenceUrl] = useState("");
  const save = useMutation({ mutationFn: () => api.review({ referenceId, runId, listingId: discrepancy.listingId, field: discrepancy.field, resolution, note, evidenceUrl, reviewedAt: new Date().toISOString() }), onSuccess: onSaved });
  return <SettingsDialog title={t("inspection")} closeLabel={t("close")} onClose={onClose} sections={[{ id: "review", label: discrepancy.listingId, description: t("reviewHelp"), content: <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
    <h3>{t(discrepancy.kind)} · {fieldLabel(discrepancy.field, t)}</h3><p className="muted">{t("expectedValue")}</p><pre className="value-preview">{JSON.stringify(discrepancy.expected, null, 2) ?? "—"}</pre><p className="muted">{t("actualValue")}</p><pre className="value-preview">{JSON.stringify(discrepancy.actual, null, 2) ?? "—"}</pre>
    <div className="field"><label htmlFor="review-resolution">{t("resolution")}</label><Select id="review-resolution" value={resolution} onChange={(event) => setResolution(event.target.value as EvaluationReview["resolution"])}>{(["confirmed_match", "confirmed_error", "source_changed", "source_absent"] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}</Select></div>
    <div className="field"><label htmlFor="review-evidence">{t("evidenceUrl")}</label><input id="review-evidence" type="url" required value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></div>
    <div className="field"><label htmlFor="review-notes">{t("notes")}</label><textarea id="review-notes" rows={4} required value={note} onChange={(event) => setNote(event.target.value)} /></div>
    <ErrorNotice error={save.error} /><Button type="submit" variant="primary" disabled={save.isPending}>{t("saveReview")}</Button>
  </form> }]} />;
}
