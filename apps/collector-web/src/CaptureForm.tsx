import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Chip, Select } from "@denicheur-breizh/design-system";
import { captureRequestSchema, type CaptureRequest, type CaptureRun, type LabMetadata, type SearchFilters } from "@denicheur-breizh/collector-contracts";
import { ArrowRight, Flame, Globe2, Layers3, Sparkles } from "lucide-react";
import { api } from "./api";
import { draftRequest, useDraft } from "./draft";
import { useCopy, type CopyKey } from "./copy";
import { strategyLabel } from "./strategies";
import { BudgetDisplay, ErrorNotice } from "./components";

const numericFields: Array<[keyof SearchFilters, CopyKey]> = [["priceMin", "minPrice"], ["priceMax", "maxPrice"], ["surfaceMin", "minSurface"], ["surfaceMax", "maxSurface"], ["roomsMin", "rooms"], ["roomsMax", "maxRooms"], ["bedroomsMin", "bedrooms"], ["bedroomsMax", "maxBedrooms"]];

export function CaptureForm({ metadata, onCreated }: { metadata?: LabMetadata; onCreated: (run: CaptureRun) => void }) {
  const t = useCopy();
  const draft = useDraft((state) => state.draft);
  const update = useDraft((state) => state.update);
  const [validation, setValidation] = useState(false);
  const dispatch = useRef<{ serialized: string; key: string } | null>(null);
  const client = useQueryClient();
  const provider = metadata?.providers.find((item) => item.id === draft.provider);
  const budget = metadata?.budgets.find((item) => item.provider === draft.provider);
  const strategies = provider?.strategies ?? (provider ? [{ id: provider.strategy, label: provider.strategy }] : []);
  const selectedStrategy = draft.strategy ?? provider?.strategy;
  const strategyUnavailable = !!selectedStrategy && !strategies.some((strategy) => strategy.id === selectedStrategy);
  const configuredRequest = () => ({ ...draftRequest(draft), strategy: selectedStrategy });
  const mutation = useMutation({
    mutationFn: async () => {
      const request = captureRequestSchema.parse(configuredRequest());
      const serialized = JSON.stringify(request);
      if (dispatch.current?.serialized !== serialized) dispatch.current = { serialized, key: crypto.randomUUID() };
      return api.create(request, dispatch.current.key);
    },
    onSuccess(run) {
      dispatch.current = null;
      void client.invalidateQueries({ queryKey: ["runs"] });
      void client.invalidateQueries({ queryKey: ["metadata"] });
      onCreated(run);
    },
  });
  const changeFilter = (key: keyof SearchFilters, value: unknown) => update({ filters: { ...draft.filters, [key]: value } });
  const unavailable = strategyUnavailable || !provider?.configured || (budget?.unknownCalls ?? 0) > 0 || (budget?.remaining ?? 0) <= 0;

  return <form className="capture-layout" onSubmit={(event) => {
    event.preventDefault();
    if (!captureRequestSchema.safeParse(configuredRequest()).success) { setValidation(true); return; }
    setValidation(false); mutation.mutate();
  }}>
    <div className="capture-main">
      <section className="panel">
        <div className="section-heading"><span className="step">01</span><h2>{t("source")}</h2></div>
        <div className="field"><label htmlFor="capture-source">{t("source")}</label><Select id="capture-source" value={draft.source} onChange={(event) => update({ source: event.target.value })}>
          {(metadata?.sources ?? [{ id: "leboncoin", label: "Leboncoin" }]).map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </Select></div>
        <fieldset className="provider-fieldset"><legend>{t("provider")}</legend><div className="provider-choices">
          {(["xai", "firecrawl"] as const).map((id) => <label className={`provider-choice ${draft.provider === id ? "selected" : ""}`} key={id}>
            <input type="radio" name="provider" value={id} checked={draft.provider === id} onChange={() => update({ provider: id, strategy: undefined })} />
            <span className="provider-icon">{id === "xai" ? <Sparkles size={21} aria-hidden /> : <Flame size={21} aria-hidden />}</span>
            <span><strong>{id === "xai" ? "xAI" : "Firecrawl"}</strong><small>{t(id === "xai" ? "xaiDescription" : "firecrawlDescription")}</small></span>
          </label>)}
        </div></fieldset>
        {(strategies.length > 1 || strategyUnavailable) && <div className="field strategy-field"><label htmlFor="capture-strategy">{t("strategy")}</label><Select id="capture-strategy" value={selectedStrategy ?? ""} onChange={(event) => update({ strategy: event.target.value as CaptureRequest["strategy"] })}>
          {strategyUnavailable && <option value={selectedStrategy} disabled>{selectedStrategy}</option>}
          {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategyLabel(strategy.id, t, strategy.label)}</option>)}
        </Select><small>{t("strategyHelp")}</small></div>}
        {strategyUnavailable && <p className="workflow-notice">{t("strategyUnavailable")}</p>}
        {selectedStrategy === "firecrawl-detail-repair-v4" && <p className="muted">{t("strategyRepairHelp")}</p>}
      </section>
      <section className="panel">
        <div className="section-heading"><span className="step">02</span><h2>{t("capture")}</h2></div>
        <div className="mode-tabs" role="group" aria-label={t("capture")}>
          <Button aria-pressed={draft.mode === "search"} variant={draft.mode === "search" ? "primary" : "ghost"} onClick={() => update({ mode: "search" })}><Globe2 size={16} aria-hidden />{t("search")}</Button>
          <Button aria-pressed={draft.mode === "urls"} variant={draft.mode === "urls" ? "primary" : "ghost"} onClick={() => update({ mode: "urls" })}><Layers3 size={16} aria-hidden />{t("urls")}</Button>
        </div>
        <p className="muted">{t(draft.mode === "search" ? "searchHelp" : "urlHelp")}</p>
        <div className="field"><label htmlFor="capture-name">{t("name")}</label><input id="capture-name" value={draft.name} maxLength={200} required placeholder={t("namePlaceholder")} onChange={(event) => update({ name: event.target.value })} /></div>
        {draft.mode === "urls" ? <div className="field"><label htmlFor="capture-urls">{t("urls")}</label><textarea id="capture-urls" required rows={7} value={draft.urlsText} placeholder="https://www.leboncoin.fr/ad/ventes_immobilieres/…" onChange={(event) => update({ urlsText: event.target.value })} /></div> : <>
          <div className="field"><label htmlFor="capture-search-url">{t("nativeUrl")}</label><input id="capture-search-url" type="url" value={draft.searchUrl ?? ""} placeholder="https://www.leboncoin.fr/recherche?…" onChange={(event) => update({ searchUrl: event.target.value })} /><small>{t("nativeUrlHelp")}</small></div>
          <div className="fields-grid">
            <div className="field"><label htmlFor="capture-location">{t("location")}</label><input id="capture-location" value={draft.filters.location} placeholder="Quimper, Bretagne" onChange={(event) => changeFilter("location", event.target.value)} /></div>
            <div className="field"><label htmlFor="capture-query">{t("query")}</label><input id="capture-query" value={draft.filters.text} onChange={(event) => changeFilter("text", event.target.value)} /></div>
            <div className="field"><label htmlFor="capture-category">{t("category")}</label><Select id="capture-category" value={draft.filters.category} onChange={(event) => changeFilter("category", event.target.value)}>{(["sale", "rent", "shared", "commercial", "new"] as const).map((value) => <option value={value} key={value}>{t(value)}</option>)}</Select></div>
            <div className="field"><label htmlFor="capture-seller">{t("seller")}</label><Select id="capture-seller" value={draft.filters.seller} onChange={(event) => changeFilter("seller", event.target.value)}><option value="all">{t("any")}</option><option value="private">{t("privateSeller")}</option><option value="professional">{t("professional")}</option></Select></div>
          </div>
          <fieldset className="property-types"><legend>{t("propertyType")}</legend><div className="inline-options">{(["house", "apartment", "land", "parking", "other"] as const).map((value) => <label key={value}><input type="checkbox" checked={draft.filters.propertyTypes.includes(value)} onChange={(event) => changeFilter("propertyTypes", event.target.checked ? [...draft.filters.propertyTypes, value] : draft.filters.propertyTypes.filter((item) => item !== value))} />{t(value)}</label>)}</div></fieldset>
          <div className="fields-grid">{numericFields.map(([key, label]) => <div className="field" key={key}><label htmlFor={`filter-${key}`}>{t(label)}</label><input id={`filter-${key}`} type="number" min="0" step={key.includes("rooms") || key.includes("Rooms") ? "1" : "any"} value={draft.filters[key] as number | undefined ?? ""} onChange={(event) => changeFilter(key, event.target.value === "" ? undefined : Number(event.target.value))} /></div>)}</div>
          <div className="field"><label htmlFor="capture-sort">{t("order")}</label><Select id="capture-sort" value={draft.filters.sort} onChange={(event) => changeFilter("sort", event.target.value)}><option value="recent">{t("newest")}</option><option value="relevance">{t("relevance")}</option></Select></div>
        </>}
      </section>
    </div>
    <aside className="capture-aside">
      <div className="panel summary-panel"><span className="eyebrow">{draft.provider === "xai" ? "xAI" : "FIRECRAWL"}</span><h2>{t("search")}</h2><p>{t("independentHelp")}</p><div className="summary-rule"><strong>100%</strong><span>{t("coverageTarget")}</span></div><p className="muted">{t("coverageHelp")}</p>
        {budget && <BudgetDisplay budget={budget} />}
        {!provider?.configured && metadata && <p className="workflow-notice">{t("configurationNeeded")}</p>}
        {(budget?.unknownCalls ?? 0) > 0 && <p className="workflow-notice">{t("unknownConsumption")}</p>}
        {validation && <ErrorNotice error={new Error(t("validation"))} />}
        {mutation.error && <ErrorNotice error={mutation.error} />}
        <Button className="full-width" variant="primary" type="submit" disabled={mutation.isPending || unavailable}>{t(mutation.isPending ? "starting" : "start")}<ArrowRight size={17} aria-hidden /></Button>
        {metadata?.live === false && <Chip tone="sunset">{t("simulation")}</Chip>}
      </div>
    </aside>
  </form>;
}
