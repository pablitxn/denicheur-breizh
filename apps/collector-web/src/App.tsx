import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApplicationSettings, Button } from "@denicheur-breizh/design-system";
import { LOCALE_METADATA, SETTINGS_LABELS, SUPPORTED_LOCALES } from "@denicheur-breizh/i18n";
import { ArrowUpRight, FlaskConical, GitCompareArrows, History, Plus } from "lucide-react";
import { api } from "./api";
import { useApplyPreferences, usePreferences } from "./preferences";
import { useCopy } from "./copy";
import { CaptureForm } from "./CaptureForm";
import { ErrorNotice } from "./components";
import { Development } from "./Development";
import { Captures } from "./Captures";
import { Evaluation } from "./Evaluation";

const locales = SUPPORTED_LOCALES.map((value) => ({ value, label: LOCALE_METADATA[value].nativeName }));
export function App() {
  useApplyPreferences(); const t = useCopy();
  const [view, setView] = useState<"capture" | "history" | "compare">(() => {
    const candidate = new URLSearchParams(window.location.search).get("view");
    return candidate === "history" || candidate === "compare" ? candidate : "capture";
  });
  const [selectedRun, setSelectedRun] = useState<string | null>(() => new URLSearchParams(window.location.search).get("run"));
  useEffect(() => {
    const url = new URL(window.location.href); url.searchParams.set("view", view);
    if (selectedRun) url.searchParams.set("run", selectedRun); else url.searchParams.delete("run");
    window.history.replaceState(null, "", url);
  }, [view, selectedRun]);
  const meta = useQuery({ queryKey: ["metadata"], queryFn: api.metadata, refetchInterval: 10000 });
  const locale = usePreferences((state) => state.locale);
  const theme = usePreferences((state) => state.theme);
  const setLocale = usePreferences((state) => state.setLocale);
  const setTheme = usePreferences((state) => state.setTheme);
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t("app")}</a>
    <header className="app-header"><div className="brand"><span className="brand-symbol"><FlaskConical size={22} aria-hidden /></span><span>Dénicheur <em>Breizh</em><small>CAPTURE LAB</small></span></div><ApplicationSettings labels={SETTINGS_LABELS[locale]} locale={locale} locales={locales} onLocaleChange={setLocale} theme={theme} onThemeChange={setTheme} development={<Development />} /></header>
    <div className="workspace"><nav className="side-nav" aria-label={t("app")}><span className="eyebrow">{t("lab")}</span>{(["capture", "history", "compare"] as const).map((id) => <button type="button" key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>{id === "capture" ? <Plus size={18} aria-hidden /> : id === "history" ? <History size={18} aria-hidden /> : <GitCompareArrows size={18} aria-hidden />}<span>{t(id)}</span>{view === id && <ArrowUpRight size={14} aria-hidden />}</button>)}<div className="nav-footer"><span className="orbit" aria-hidden /><strong>{t("independent")}</strong><p>{t("coverageHelp")}</p></div></nav>
      <main id="main-content" className="main-content"><div className="page-heading"><span className="eyebrow">DÉNICHEUR BREIZH / CAPTURE LAB</span><h1>{view === "capture" ? t("subtitle") : t(view)}</h1><p>{view === "capture" ? t("intro") : view === "compare" ? t("comparisonIntro") : t("searchHelp")}</p></div>
        {meta.data?.live === false && <div className="simulation-banner" role="status">{t("simulation")}</div>}
        {meta.error && <div className="panel"><ErrorNotice error={meta.error} /><Button onClick={() => void meta.refetch()}>{t("refresh")}</Button></div>}
        {view === "capture" && <CaptureForm metadata={meta.data} onCreated={(run) => { setSelectedRun(run.id); setView("history"); }} />}
        {view === "history" && <Captures selectedId={selectedRun} onSelect={setSelectedRun} onNew={() => setView("capture")} />}
        {view === "compare" && <Evaluation />}
      </main>
    </div>
  </div>;
}
