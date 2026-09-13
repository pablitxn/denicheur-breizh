import { useEffect, useId, useRef, useState } from "react";
import { Filter, Plus, Search, X } from "lucide-react";
import { Button, Chip, Select } from "@denicheur-breizh/design-system";
import { useAppIntl } from "../../intl/IntlContext";
import type { ListingFilters } from "../../types";
import { formatInteger } from "../../utils/format";
import styles from "./PropertiesControls.module.css";

const filterKeys = ["priceMin", "priceMax", "surfaceMin", "decision", "energyClassMax"] as const;
type FilterKey = typeof filterKeys[number];
export type ExtraFilters = Partial<Pick<ListingFilters, FilterKey>>;
export const emptyExtraFilters: ExtraFilters = {};
export const extraFiltersCodec = {
  parse(value: string | null): ExtraFilters | undefined {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return undefined;
      const candidate = parsed as Record<string, unknown>;
      const result: ExtraFilters = {};
      for (const key of ["priceMin", "priceMax", "surfaceMin"] as const) {
        if (typeof candidate[key] === "number" && Number.isFinite(candidate[key]) && candidate[key] >= 0) result[key] = candidate[key];
      }
      if (["relevant", "not-relevant", "review"].includes(String(candidate.decision))) result.decision = candidate.decision as ExtraFilters["decision"];
      if (/^[A-G]$/u.test(String(candidate.energyClassMax))) result.energyClassMax = String(candidate.energyClassMax);
      return result;
    } catch { return undefined; }
  },
  serialize: (value: ExtraFilters) => Object.keys(value).length ? JSON.stringify(value) : null,
};

interface PropertiesControlsProps {
  total: number;
  sources: Array<{ source: string; count: number }>;
  activeSources: string[];
  filters: ExtraFilters;
  search: string;
  onFilters: (sources: string[], filters: ExtraFilters) => void;
  onSearch: (search: string) => void;
}

export function PropertiesControls({ total, sources, activeSources, filters, search, onFilters, onSearch }: PropertiesControlsProps) {
  const { t, locale } = useAppIntl();
  const [panel, setPanel] = useState<"filters" | "search" | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const count = activeSources.length + Object.keys(filters).length;
  const close = () => { setPanel(null); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!panel) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setPanel(null);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setPanel(null); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", keyboard); };
  }, [panel]);

  return <div ref={rootRef} className={styles.controls}>
    <Button size="sm" variant={count ? "default" : "ghost"} aria-expanded={panel === "filters"} aria-controls={panelId} onClick={(event) => {
      triggerRef.current = event.currentTarget; setPanel(panel === "filters" ? null : "filters");
    }}><Filter size={16} aria-hidden="true" />{t("properties.filterButton")}{count > 0 && <span className={styles.badge}>{formatInteger(count, locale)}</span>}</Button>
    <Button size="sm" variant={search ? "default" : "ghost"} iconOnly aria-label={t("properties.search")} title={t("properties.search")} aria-expanded={panel === "search"} aria-controls={panelId} onClick={(event) => {
      triggerRef.current = event.currentTarget; setPanel(panel === "search" ? null : "search");
    }}><Search size={16} aria-hidden="true" /></Button>
    {search && <button className={styles.searchChip} onClick={() => onSearch("")} aria-label={t("properties.clearSearch", { search })}>{search}<X size={13} aria-hidden="true" /></button>}
    {panel && <div id={panelId} className={styles.panel} role="dialog" aria-label={t(panel === "filters" ? "properties.filterButton" : "properties.search")}>
      <div className={styles.panelHeader}>
        <div><h2>{t(panel === "filters" ? "properties.title" : "properties.search")}</h2><span>{t("properties.count", { count: total })}</span></div>
        <Button size="sm" variant="ghost" iconOnly aria-label={t("properties.closeControls")} onClick={close}><X size={16} aria-hidden="true" /></Button>
      </div>
      {panel === "search" ? <form onSubmit={(event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget); onSearch(String(form.get("search") ?? "").trim()); close();
      }} className={styles.searchForm}>
        <label>{t("properties.searchPlaceholder")}<input autoFocus name="search" type="search" maxLength={200} defaultValue={search} placeholder={t("properties.searchPlaceholder")} /></label>
        <Button type="submit" variant="primary">{t("properties.search")}</Button>
      </form> : <FilterForm sources={sources} activeSources={activeSources} filters={filters} onApply={(nextSources, nextFilters) => { onFilters(nextSources, nextFilters); close(); }} />}
    </div>}
  </div>;
}

function FilterForm({ sources, activeSources, filters, onApply }: Pick<PropertiesControlsProps, "sources" | "activeSources" | "filters"> & { onApply: PropertiesControlsProps["onFilters"] }) {
  const { t, locale } = useAppIntl();
  const [draftSources, setDraftSources] = useState(activeSources);
  const [keys, setKeys] = useState<FilterKey[]>(filterKeys.filter((key) => filters[key] !== undefined));
  const [values, setValues] = useState<Partial<Record<FilterKey, string>>>(() => Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)])));
  const remaining = filterKeys.filter((key) => !keys.includes(key));
  return <form className={styles.filterForm} onSubmit={(event) => {
    event.preventDefault();
    const candidate = Object.fromEntries(keys.filter((key) => values[key]?.trim()).map((key) => [key, ["priceMin", "priceMax", "surfaceMin"].includes(key) ? Number(values[key]) : values[key]]));
    onApply(draftSources, extraFiltersCodec.parse(JSON.stringify(candidate)) ?? {});
  }}>
    <fieldset><legend>{t("properties.filters")}</legend><div className={styles.sources}>
      <Chip active={draftSources.length === 0} onClick={() => setDraftSources([])}>{t("catalog.allSources")}</Chip>
      {sources.map(({ source, count }) => <Chip key={source} active={draftSources.includes(source)} onClick={() => setDraftSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source])}>{source} {formatInteger(count, locale)}</Chip>)}
    </div></fieldset>
    {keys.map((key) => <div key={key} className={styles.filterRow}>
      <label>{t(`properties.filter.${key}`)}
        {key === "decision" || key === "energyClassMax" ? <Select value={values[key] ?? ""} onChange={(event) => setValues({ ...values, [key]: event.target.value })}>
          <option value="">{t("properties.anyValue")}</option>
          {key === "decision" ? (["relevant", "not-relevant", "review"] as const).map((value) => <option key={value} value={value}>{t(`decision.${value}`)}</option>) : ["A", "B", "C", "D", "E", "F", "G"].map((value) => <option key={value}>{value}</option>)}
        </Select> : <input type="number" min={key === "priceMax" ? values.priceMin || 0 : 0} max={key === "priceMin" ? values.priceMax || undefined : undefined} step="any" value={values[key] ?? ""} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />}
      </label>
      <Button variant="ghost" size="sm" iconOnly aria-label={t("properties.removeFilter", { filter: t(`properties.filter.${key}`) })} onClick={() => { setKeys(keys.filter((item) => item !== key)); setValues({ ...values, [key]: "" }); }}><X size={15} aria-hidden="true" /></Button>
    </div>)}
    {remaining.length > 0 && <label className={styles.addFilter}><Plus size={15} aria-hidden="true" /><Select aria-label={t("properties.addFilter")} value="" onChange={(event) => setKeys([...keys, event.target.value as FilterKey])}>
      <option value="" disabled>{t("properties.addFilter")}</option>
      {remaining.map((key) => <option key={key} value={key}>{t(`properties.filter.${key}`)}</option>)}
    </Select></label>}
    <div className={styles.actions}><Button variant="ghost" onClick={() => { setDraftSources([]); setKeys([]); setValues({}); }}>{t("properties.clearFilters")}</Button><Button variant="primary" type="submit">{t("properties.applyFilters")}</Button></div>
  </form>;
}
