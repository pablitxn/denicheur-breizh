import { useEffect, useId, useRef, type KeyboardEvent, type RefObject } from "react";
import { ArrowUpRight, Check, CircleHelp, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { useQuery } from "@tanstack/react-query";
import { denicheurApi } from "../../api/denicheurApi";
import { queryKeys } from "../../api/queryKeys";
import { PropertyVisual } from "../../components/PropertyVisual";
import { useAppIntl } from "../../intl/IntlContext";
import type { PropertyListing } from "../../types";
import { formatInteger } from "../../utils/format";
import { enumUrlCodec, useUrlState } from "../../utils/useUrlState";
import { workspaceViewHref } from "../../utils/workspaceNavigation";
import { missingPropertyFacts, summarizeEvaluation } from "./propertyDossierModel";
import { PropertyHistory } from "./PropertyHistory";
import styles from "./PropertyDossier.module.css";

const tabs = ["overview", "evaluation", "history"] as const;
type DossierTab = typeof tabs[number];

interface PropertyDossierProps {
  listing: PropertyListing;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
  detailRef: RefObject<HTMLElement | null>;
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function PropertyDossier({ listing, loading, error, onRetry, onClose, detailRef, expanded, onToggleExpanded }: PropertyDossierProps) {
  const { locale, t } = useAppIntl();
  const [activeTab, setActiveTab] = useUrlState<DossierTab>("ptab", "overview", enumUrlCodec(tabs));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const missing = missingPropertyFacts(listing);
  const evaluation = listing.evaluation;
  const coverage = summarizeEvaluation(evaluation?.criteria ?? []);
  const recipes = useQuery({
    queryKey: queryKeys.recipes.lists(),
    queryFn: ({ signal }) => denicheurApi.listRecipes(signal),
    enabled: activeTab === "evaluation" && Boolean(evaluation),
    staleTime: 60_000,
  });
  const evaluatedRecipe = recipes.data?.find((recipe) => recipe.id === evaluation?.recipeId && recipe.version === evaluation.recipeVersion);
  const number = (value: number | undefined, unit = "") => value === undefined ? t("common.unavailable") : `${unit ? new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(value) : formatInteger(value, locale)}${unit}`;
  const date = (value: string | undefined) => value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value)) : t("common.unavailable");
  useEffect(() => { detailRef.current?.focus({ preventScroll: true }); }, [listing.key, detailRef]);

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
      : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActiveTab(tabs[next]!);
    tabRefs.current[next]?.focus();
  };

  return <aside ref={detailRef} tabIndex={-1} className={[styles.dossier, expanded ? styles.expanded : ""].join(" ")}
    aria-label={t("dossier.title")} aria-busy={loading}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } }}>
    <header className={styles.toolbar}>
      <span>{t("dossier.title")}</span>
      <div>
        <Button variant="ghost" iconOnly className={styles.expandButton} onClick={onToggleExpanded}
          aria-label={t(expanded ? "dossier.collapse" : "dossier.expand")} title={t(expanded ? "dossier.collapse" : "dossier.expand")}>
          {expanded ? <Minimize2 size={17} aria-hidden="true" /> : <Maximize2 size={17} aria-hidden="true" />}
        </Button>
        <Button variant="ghost" iconOnly onClick={onClose} aria-label={t("properties.closeDetail")} title={t("properties.closeDetail")}><X size={19} aria-hidden="true" /></Button>
      </div>
    </header>
    {error && <div className={styles.notice} role="alert"><p>{t("properties.detailError")}</p><Button size="sm" onClick={onRetry} disabled={loading}>{t("common.retry")}</Button></div>}
    <div className={styles.hero}>
      <div className={styles.photo}><PropertyVisual key={listing.key} property={listing} size="lg" navigation /></div>
      <div className={styles.identity}>
        <div className={styles.source}><Chip>{listing.source}</Chip><a href={listing.url} target="_blank" rel="noreferrer noopener">{t("properties.openSource")}<ExternalLink size={13} aria-hidden="true" /></a></div>
        <h2>{listing.title?.trim() || t("common.unavailable")}</h2>
        <p className={styles.location}>{listing.location?.trim() || t("common.unavailable")}</p>
        <div className={styles.price}><span>{t("dossier.askingPrice")}</span><strong>{listing.priceEuros === undefined ? listing.priceText || t("common.unavailable") : new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(listing.priceEuros)}</strong></div>
        <p className={styles.observed}>{t("dossier.updated", { date: date(listing.scrapedAt) })}</p>
      </div>
    </div>
    <div className={styles.tabs} role="tablist" aria-label={t("dossier.tabs")}>
      {tabs.map((tab, index) => <button key={tab} type="button" ref={(element) => { tabRefs.current[index] = element; }}
        role="tab" id={`${id}-${tab}`} aria-controls={`${id}-panel`} aria-selected={activeTab === tab}
        tabIndex={activeTab === tab ? 0 : -1} onClick={() => setActiveTab(tab)} onKeyDown={(event) => moveTab(event, index)}>
        {t(`dossier.${tab}`)}{tab === "evaluation" && coverage.unknown > 0 && <span className={styles.tabCount}>{coverage.unknown}</span>}
      </button>)}
    </div>
    <div key={`${listing.key}-${activeTab}`} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${activeTab}`} tabIndex={0} className={styles.content}>
      {activeTab === "overview" && <>
        <section className={styles.section}>
          <h3>{t("dossier.facts")}</h3>
          <dl className={styles.facts}>
            {([
              ["surface", number(listing.surfaceM2, "\u00a0m²")], ["rooms", number(listing.rooms)],
              ["bedrooms", number(listing.bedrooms)], ["land", number(listing.landSurfaceM2, "\u00a0m²")],
            ] as const).map(([key, value]) => <div key={key}><dt>{t(`dossier.${key}`)}</dt><dd>{value}</dd></div>)}
          </dl>
          <div className={styles.energy}>
            <span>{t("dossier.energy")} <b>{listing.energyClass?.trim() || "—"}</b></span>
            <span>{t("dossier.ges")} <b>{listing.gesClass?.trim() || "—"}</b></span>
          </div>
          <p className={styles.hint}>{t("dossier.energyNote")}</p>
        </section>
        <section className={styles.encaje}>
          <CircleHelp size={20} aria-hidden="true" />
          <div><h3>{evaluation ? t("dossier.evaluation") : t("dossier.noEvaluation")}</h3>
            <p>{evaluation ? evaluation.summary : t("dossier.noEvaluationNote")}</p>
            {evaluation ? <button type="button" onClick={() => { setActiveTab("evaluation"); tabRefs.current[1]?.focus(); }}>{t("dossier.known", { known: coverage.known, total: coverage.total })}<ArrowUpRight size={14} aria-hidden="true" /></button>
              : <a href={workspaceViewHref("scorings")}>{t("dossier.goEvaluate")}<ArrowUpRight size={14} aria-hidden="true" /></a>}
          </div>
        </section>
        {missing.length > 0 && <section className={styles.section}><h3>{t("dossier.pending")}</h3><p className={styles.hint}>{t("dossier.pendingNote")}</p>
          <div className={styles.chips}>{missing.map((field) => <Chip key={field}>{t(`dossier.${field}`)}</Chip>)}</div>
        </section>}
        <section className={styles.section}><h3>{t("properties.description")}</h3>
          <p className={styles.description}>{listing.description || t("common.unavailable")}</p>
          {listing.features.length > 0 && <div className={styles.chips}>{listing.features.map((feature) => <Chip key={feature}>{feature}</Chip>)}</div>}
        </section>
        {(listing.sellerName || listing.sellerType) && <section className={styles.section}><h3>{t("properties.seller")}</h3><p>{listing.sellerName ?? listing.sellerType}</p></section>}
        <details className={styles.provenance}><summary>{t("dossier.originDetails")}</summary><dl>
          <div><dt>{t("properties.externalId")}</dt><dd>{listing.externalId}</dd></div>
          <div><dt>{t("properties.run")}</dt><dd>{listing.latestRun?.id ?? listing.runs[0]?.id ?? t("common.unavailable")}</dd></div>
          {listing.coordinates && <><div><dt>{t("map.positionTitle")}</dt><dd>{t(`map.locationKind.${listing.coordinates.locationKind}`)}</dd></div><div><dt>{t("map.coordinateProvenance")}</dt><dd>{listing.coordinates.provenance}</dd></div></>}
        </dl></details>
      </>}
      {activeTab === "evaluation" && (evaluation ? <>
        <section className={styles.section}><div className={styles.scoreRow}><div><span className={styles.hint}>{t("dossier.score")}</span><strong>{evaluation.score === null ? "—" : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(evaluation.score)} / 100`}</strong></div><Chip active tone={evaluation.decision === "relevant" ? "good" : evaluation.decision === "not-relevant" ? "danger" : "sunset"}>{t(`decision.${evaluation.decision}`)}</Chip></div>
          <p>{evaluation.summary}</p><strong className={styles.coverage}>{t("dossier.known", { known: coverage.known, total: coverage.total })}</strong><p className={styles.hint}>{t("dossier.coverageNote")}</p>
        </section>
        {(["fail", "unknown", "pass"] as const).map((verdict) => {
          const criteria = evaluation.criteria.filter((criterion) => criterion.verdict === verdict);
          return criteria.length > 0 && <section key={verdict} className={styles.section}><h3>{t(`dossier.${verdict}`)} <span className={styles.groupCount}>{criteria.length}</span></h3>
            {criteria.map((criterion) => <article key={criterion.criterionId} className={styles.criterion}>
              <span className={styles[verdict]}>{verdict === "pass" ? <Check size={16} aria-hidden="true" /> : verdict === "fail" ? <X size={16} aria-hidden="true" /> : <CircleHelp size={16} aria-hidden="true" />}</span>
              <div><strong>{evaluatedRecipe?.criteria.find((item) => item.id === criterion.criterionId)?.name ?? criterion.criterionId}</strong><p>{criterion.reason}</p>{criterion.evidence.length > 0 && <details><summary>{t("dossier.evidence")}</summary><ul>{criterion.evidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></details>}</div>
            </article>)}
          </section>;
        })}
        {evaluation.missingData.length > 0 && <section className={styles.section}><h3>{t("properties.missingData")}</h3><ul>{evaluation.missingData.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>}
        <details className={styles.provenance}><summary>{t("dossier.evaluationDetails")}</summary><dl><div><dt>{t("properties.run")}</dt><dd>{evaluation.runId}</dd></div><div><dt>{t("dossier.evaluation")}</dt><dd>{evaluation.recipeId} · v{evaluation.recipeVersion} · {date(evaluation.evaluatedAt)}</dd></div></dl></details>
      </> : <section className={styles.empty}><CircleHelp size={28} aria-hidden="true" /><h3>{t("dossier.noEvaluation")}</h3><p>{t("dossier.noEvaluationNote")}</p><a href={workspaceViewHref("scorings")}>{t("dossier.goEvaluate")} <ArrowUpRight size={15} aria-hidden="true" /></a></section>)}
      {activeTab === "history" && <PropertyHistory key={listing.key} source={listing.source} externalId={listing.externalId} />}
    </div>
  </aside>;
}
