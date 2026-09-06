import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePenLine,
  History,
  Plus,
  Save,
  Star,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button, Chip, EmptyState, SectionLabel } from "@denicheur-breizh/design-system";
import {
  useDefaultEvaluationPlan,
  useEvaluationPlans,
  useRecipes,
  useSaveEvaluationPlan,
  useSaveRecipe,
  useSetDefaultEvaluationPlan,
} from "../../api/hooks";
import { useAppIntl } from "../../intl/IntlContext";
import type {
  EvaluationPlan,
  EvaluationPlanDraft,
  IntelligenceCriterion,
  IntelligenceRecipe,
  RecipeDraft,
} from "../../types";
import { enumUrlCodec, stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import {
  MAX_PLAN_RECIPES,
  blankCriterion,
  blankPlanDraft,
  blankRecipeDraft,
  duplicatePlanDraft,
  duplicateRecipeDraft,
  groupVersions,
  isPlanWorkingDraft,
  isRecipeWorkingDraft,
  latestRecipeVersion,
  moveItem,
  nextAvailableRecipe,
  parseRecipeRef,
  planDraftStorageKey,
  planVersionKey,
  recipeDraftStorageKey,
  recipeRefKey,
  recipeVersionKey,
  toPlanDraft,
  toRecipeDraft,
  validatePlanDraft,
  validateRecipeDraft,
  workingDraftKey,
  type PlanWorkingDraft,
  type RecipeWorkingDraft,
  type VersionFamily,
} from "./builderModel";
import { createWorkingDraftStore, type WorkingDraftSnapshot, type WorkingDraftStore } from "./workingDraftStore";
import styles from "./BuilderView.module.css";

type BuilderTab = "recipes" | "plans";
const builderTabCodec = enumUrlCodec<BuilderTab>(["recipes", "plans"]);

export function createBuilderDraftStores() {
  return {
    recipes: createWorkingDraftStore<RecipeWorkingDraft>(recipeDraftStorageKey, undefined, isRecipeWorkingDraft),
    plans: createWorkingDraftStore<PlanWorkingDraft>(planDraftStorageKey, undefined, isPlanWorkingDraft),
  };
}

const defaultDraftStores = createBuilderDraftStores();

export function BuilderView({ draftStores = defaultDraftStores }: { draftStores?: ReturnType<typeof createBuilderDraftStores> } = {}) {
  const { t } = useAppIntl();
  const recipesQuery = useRecipes();
  const plansQuery = useEvaluationPlans();
  const defaultPlanQuery = useDefaultEvaluationPlan();
  const saveRecipe = useSaveRecipe();
  const savePlan = useSaveEvaluationPlan();
  const setDefaultPlan = useSetDefaultEvaluationPlan();
  const recipes = recipesQuery.data ?? [];
  const plans = plansQuery.data ?? [];
  const recipeFamilies = useMemo(() => groupVersions(recipes), [recipes]);
  const planFamilies = useMemo(() => groupVersions(plans), [plans]);
  const [tab, setTab] = useUrlState<BuilderTab>("btab", "recipes", builderTabCodec);
  const [requestedRecipe, setRequestedRecipe] = useUrlState("brid", "", stringUrlCodec);
  const [requestedPlan, setRequestedPlan] = useUrlState("bpid", "", stringUrlCodec);
  const selectedRecipe = recipes.find((recipe) => recipeVersionKey(recipe) === requestedRecipe)
    ?? recipes.find((recipe) => recipe.active)
    ?? recipeFamilies[0]?.latest;
  const selectedPlan = plans.find((plan) => planVersionKey(plan) === requestedPlan)
    ?? plans.find((plan) => plan.isDefault)
    ?? planFamilies[0]?.latest;
  const recipeState = useSyncExternalStore(draftStores.recipes.subscribe, draftStores.recipes.getSnapshot);
  const planState = useSyncExternalStore(draftStores.plans.subscribe, draftStores.plans.getSnapshot);
  const { drafts: recipeDrafts, activeKey: activeRecipeDraftKey } = recipeState;
  const { drafts: planDrafts, activeKey: activePlanDraftKey } = planState;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const recipeDraft = activeRecipeDraftKey ? recipeDrafts[activeRecipeDraftKey] : undefined;
  const planDraft = activePlanDraftKey ? planDrafts[activePlanDraftKey] : undefined;

  useEffect(() => {
    if (tab === "recipes" && !requestedRecipe && selectedRecipe) setRequestedRecipe(recipeVersionKey(selectedRecipe));
    if (tab === "plans" && !requestedPlan && selectedPlan) setRequestedPlan(planVersionKey(selectedPlan));
  }, [requestedPlan, requestedRecipe, selectedPlan, selectedRecipe, setRequestedPlan, setRequestedRecipe, tab]);

  const loading = recipesQuery.isLoading || plansQuery.isLoading;
  const error = recipesQuery.error || plansQuery.error || defaultPlanQuery.error;
  const hasDrafts = Object.keys(recipeDrafts).length > 0 || Object.keys(planDrafts).length > 0;
  if (loading && !hasDrafts) return <BuilderState copy={t("builder.loading")} />;
  if (error && !hasDrafts && !recipesQuery.data && !plansQuery.data) {
    return <BuilderState
      copy={t("builder.error")}
      retry={() => void Promise.all([recipesQuery.refetch(), plansQuery.refetch(), defaultPlanQuery.refetch()])}
    />;
  }

  const selectRecipe = (recipe: IntelligenceRecipe) => {
    draftStores.recipes.select();
    setRequestedRecipe(recipeVersionKey(recipe));
  };

  const selectPlan = (plan: EvaluationPlan) => {
    draftStores.plans.select();
    setRequestedPlan(planVersionKey(plan));
  };

  const updateRecipeDraft = (key: string, update: (current: RecipeDraft) => RecipeDraft) => {
    const working = draftStores.recipes.getSnapshot().drafts[key];
    if (working) draftStores.recipes.put(key, { ...working, value: update(working.value) });
  };

  const updatePlanDraft = (key: string, update: (current: EvaluationPlanDraft) => EvaluationPlanDraft) => {
    const working = draftStores.plans.getSnapshot().drafts[key];
    if (working) draftStores.plans.put(key, { ...working, value: update(working.value) });
  };

  const startRecipeDraft = (working: RecipeWorkingDraft, baseVersion?: number) => {
    const key = workingDraftKey(working.mode, working.value.id, baseVersion);
    draftStores.recipes.open(key, working);
  };

  const startPlanDraft = (working: PlanWorkingDraft, baseVersion?: number) => {
    const key = workingDraftKey(working.mode, working.value.id, baseVersion);
    draftStores.plans.open(key, working);
  };

  const discardRecipeDraft = (key: string) => {
    if (!window.confirm(t("builder.discardDraftConfirm"))) return;
    draftStores.recipes.remove(key);
  };

  const discardPlanDraft = (key: string) => {
    if (!window.confirm(t("builder.discardDraftConfirm"))) return;
    draftStores.plans.remove(key);
  };

  const publishRecipe = async (key: string, draft: RecipeDraft) => {
    const submitted = draftStores.recipes.getSnapshot().drafts[key];
    try {
      const saved = await saveRecipe.mutateAsync(draft);
      const wasActive = draftStores.recipes.getSnapshot().activeKey === key;
      const removed = draftStores.recipes.remove(key, submitted);
      if (mounted.current && wasActive && removed) setRequestedRecipe(recipeVersionKey(saved));
    } catch { /* The mutation state displays the error and retains the draft. */ }
  };

  const publishPlan = async (key: string, draft: EvaluationPlanDraft) => {
    const submitted = draftStores.plans.getSnapshot().drafts[key];
    try {
      const saved = await savePlan.mutateAsync(draft);
      const wasActive = draftStores.plans.getSnapshot().activeKey === key;
      const removed = draftStores.plans.remove(key, submitted);
      if (mounted.current && wasActive && removed) setRequestedPlan(planVersionKey(saved));
    } catch { /* The mutation state displays the error and retains the draft. */ }
  };

  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "recipes" : event.key === "End" ? "plans" : tab === "recipes" ? "plans" : "recipes";
    setTab(next);
    document.getElementById(`builder-tab-${next}`)?.focus();
  };

  return (
    <section className={styles.view} aria-labelledby="builder-view-title">
      <aside className={styles.library}>
        <div className={styles.libraryHeader}>
          <SectionLabel>{t("builder.library")}</SectionLabel>
          <h1 id="builder-view-title">{t("builder.title")}</h1>
          <div className={styles.workspaceTabs} role="tablist" aria-label={t("builder.workspaceTabs")}>
            <button id="builder-tab-recipes" type="button" role="tab" aria-controls="builder-panel" tabIndex={tab === "recipes" ? 0 : -1} aria-selected={tab === "recipes"} className={tab === "recipes" ? styles.tabActive : ""} onKeyDown={navigateTabs} onClick={() => setTab("recipes")}>{t("builder.tab.recipes")}</button>
            <button id="builder-tab-plans" type="button" role="tab" aria-controls="builder-panel" tabIndex={tab === "plans" ? 0 : -1} aria-selected={tab === "plans"} className={tab === "plans" ? styles.tabActive : ""} onKeyDown={navigateTabs} onClick={() => setTab("plans")}>{t("builder.tab.plans")}</button>
          </div>
          {tab === "recipes" ? (
            <Button size="sm" onClick={() => startRecipeDraft({ mode: "new", value: blankRecipeDraft() })}>
              <Plus size={14} aria-hidden="true" />{t("builder.newRecipe")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => startPlanDraft({ mode: "new", value: blankPlanDraft(recipes) })} disabled={recipes.length === 0}>
              <Plus size={14} aria-hidden="true" />{t("builder.newPlan")}
            </Button>
          )}
        </div>

        {tab === "recipes" ? (
          <VersionLibrary
            families={recipeFamilies}
            selectedKey={recipeVersionKey(selectedRecipe)}
            drafts={recipeDrafts}
            activeDraftKey={activeRecipeDraftKey}
            versionKey={recipeVersionKey}
            onSelect={selectRecipe}
            onSelectDraft={draftStores.recipes.select}
          />
        ) : (
          <VersionLibrary
            families={planFamilies}
            selectedKey={planVersionKey(selectedPlan)}
            drafts={planDrafts}
            activeDraftKey={activePlanDraftKey}
            versionKey={planVersionKey}
            onSelect={selectPlan}
            onSelectDraft={draftStores.plans.select}
          />
        )}
      </aside>

      <div id="builder-panel" role="tabpanel" aria-labelledby={`builder-tab-${tab}`} className={styles.editor}>
        {error && <div className={styles.notice} role="alert"><p>{t("builder.refreshError")}</p><Button size="sm" onClick={() => void Promise.all([recipesQuery.refetch(), plansQuery.refetch(), defaultPlanQuery.refetch()])}>{t("common.retry")}</Button></div>}
        {tab === "recipes" ? <DraftStorageNotice state={recipeState} store={draftStores.recipes} /> : <DraftStorageNotice state={planState} store={draftStores.plans} />}
        {tab === "recipes" ? (
          recipeDraft && activeRecipeDraftKey ? (
            <RecipeDraftEditor
              key={`${activeRecipeDraftKey}:${recipeState.revision}`}
              working={recipeDraft}
              error={validateRecipeDraft(recipeDraft.value)}
              saving={saveRecipe.isPending}
              blocked={Boolean(recipeState.conflicts[activeRecipeDraftKey])}
              saveError={saveRecipe.isError}
              onChange={(update) => updateRecipeDraft(activeRecipeDraftKey, update)}
              onDiscard={() => discardRecipeDraft(activeRecipeDraftKey)}
              onPublish={() => void publishRecipe(activeRecipeDraftKey, recipeDraft.value)}
            />
          ) : selectedRecipe ? (
            <PublishedRecipe
              recipe={selectedRecipe}
              onNewVersion={() => startRecipeDraft({ mode: "version", sourceKey: recipeVersionKey(selectedRecipe), value: toRecipeDraft(selectedRecipe) }, selectedRecipe.version)}
              onDuplicate={() => startRecipeDraft({ mode: "duplicate", sourceKey: recipeVersionKey(selectedRecipe), value: duplicateRecipeDraft(selectedRecipe) })}
            />
          ) : <EmptyState>{t("builder.empty")}</EmptyState>
        ) : (
          planDraft && activePlanDraftKey ? (
            <PlanDraftEditor
              working={planDraft}
              recipes={recipes}
              error={validatePlanDraft(planDraft.value, recipes)}
              saving={savePlan.isPending}
              blocked={Boolean(planState.conflicts[activePlanDraftKey])}
              saveError={savePlan.isError}
              onChange={(update) => updatePlanDraft(activePlanDraftKey, update)}
              onDiscard={() => discardPlanDraft(activePlanDraftKey)}
              onPublish={() => void publishPlan(activePlanDraftKey, planDraft.value)}
            />
          ) : selectedPlan ? (
            <PublishedPlan
              plan={selectedPlan}
              recipes={recipes}
              settingDefault={setDefaultPlan.isPending}
              settingDefaultError={setDefaultPlan.isError && setDefaultPlan.variables?.id === selectedPlan.id && setDefaultPlan.variables?.version === selectedPlan.version}
              onNewVersion={() => startPlanDraft({ mode: "version", sourceKey: planVersionKey(selectedPlan), value: toPlanDraft(selectedPlan) }, selectedPlan.version)}
              onDuplicate={() => startPlanDraft({ mode: "duplicate", sourceKey: planVersionKey(selectedPlan), value: duplicatePlanDraft(selectedPlan) })}
              onSetDefault={() => setDefaultPlan.mutate({ id: selectedPlan.id, version: selectedPlan.version })}
            />
          ) : <EmptyState>{recipes.length === 0 ? t("builder.noRecipesForPlan") : t("builder.noPlans")}</EmptyState>
        )}
      </div>

      <aside className={styles.inspector}>
        {tab === "recipes" ? (
          <RecipeInspector family={selectedRecipe ? recipeFamilies.find((family) => family.id === selectedRecipe.id) : undefined} selected={selectedRecipe} />
        ) : (
          <PlanInspector family={selectedPlan ? planFamilies.find((family) => family.id === selectedPlan.id) : undefined} selected={selectedPlan} defaultPlan={defaultPlanQuery.data} />
        )}
      </aside>
    </section>
  );
}

function DraftStorageNotice<T extends { value: { id: string; name: string } }>({ state, store }: { state: WorkingDraftSnapshot<T>; store: WorkingDraftStore<T> }) {
  const { t } = useAppIntl();
  return <>
    {state.sessionOnly && <div className={styles.notice} role="alert"><p>{t("builder.draftSessionOnly")}</p><Button size="sm" onClick={store.retry}>{t("builder.retryDraftStorage")}</Button></div>}
    {Object.entries(state.conflicts).map(([key, conflict]) => {
      const local = state.drafts[key];
      const name = local?.value.name || conflict.incoming?.value.name || local?.value.id || key;
      return <div className={styles.notice} role="alert" key={key}>
        <p>{t(conflict.incoming ? "builder.draftConflict" : "builder.draftRemovedElsewhere", { name })}</p>
        <div className={styles.noticeActions}>
          <Button size="sm" onClick={() => store.resolve(key, "local")}>{t(!local ? "builder.keepDeletion" : conflict.incoming ? "builder.keepLocalDraft" : "builder.recoverDraftCopy")}</Button>
          <Button size="sm" onClick={() => store.resolve(key, "incoming")}>{t(conflict.incoming ? "builder.useIncomingDraft" : "builder.acceptDraftRemoval")}</Button>
        </div>
      </div>;
    })}
  </>;
}

interface VersionLibraryProps<T extends { id: string; version: number; name: string }, D extends { value: { name: string; id: string } }> {
  families: VersionFamily<T>[];
  selectedKey: string;
  drafts: Record<string, D>;
  activeDraftKey?: string;
  versionKey: (version: T) => string;
  onSelect: (version: T) => void;
  onSelectDraft: (key: string) => void;
}

function VersionLibrary<T extends { id: string; version: number; name: string }, D extends { value: { name: string; id: string } }>({
  families,
  selectedKey,
  drafts,
  activeDraftKey,
  versionKey,
  onSelect,
  onSelectDraft,
}: VersionLibraryProps<T, D>) {
  const { t } = useAppIntl();
  return <div className={styles.libraryBody}>
    {Object.keys(drafts).length > 0 && <section className={styles.draftShelf}>
      <SectionLabel>{t("builder.drafts")}</SectionLabel>
      {Object.entries(drafts).map(([key, draft]) => (
        <button type="button" key={key} className={activeDraftKey === key ? styles.selectedItem : ""} onClick={() => onSelectDraft(key)}>
          <FilePenLine size={14} aria-hidden="true" /><span><strong>{draft.value.name || draft.value.id}</strong><small>{t("common.draft")}</small></span>
        </button>
      ))}
    </section>}
    {families.map((family) => <section key={family.id} className={styles.family}>
      <div className={styles.familyHeader}><span><strong>{family.latest.name}</strong><small>{family.id}</small></span><Chip>{family.versions.length}</Chip></div>
      <div className={styles.versionList}>
        {family.versions.map((version) => (
          <button type="button" key={versionKey(version)} className={!activeDraftKey && selectedKey === versionKey(version) ? styles.selectedItem : ""} onClick={() => onSelect(version)}>
            <History size={13} aria-hidden="true" /><span>v{version.version}</span>{version.version === family.latest.version && <small>{t("builder.latest")}</small>}
          </button>
        ))}
      </div>
    </section>)}
  </div>;
}

function PublishedRecipe({ recipe, onNewVersion, onDuplicate }: { recipe: IntelligenceRecipe; onNewVersion: () => void; onDuplicate: () => void }) {
  const { locale, t } = useAppIntl();
  return <div className={styles.editorScroll}>
    <EditorHeader title={recipe.name} version={recipe.version} readOnly actions={<>
      <Button onClick={onDuplicate}><Copy size={14} aria-hidden="true" />{t("builder.duplicate")}</Button>
      <Button variant="primary" onClick={onNewVersion}><FilePenLine size={14} aria-hidden="true" />{t("builder.newVersion")}</Button>
    </>} />
    <section className={styles.editorContent}>
      <div className={styles.factGrid}>
        <Fact label={t("builder.recipeId")} value={recipe.id} />
        <Fact label={t("builder.threshold")} value={`${recipe.threshold} / 100`} />
        <Fact label={t("builder.createdAt")} value={formatDate(recipe.createdAt, locale)} />
      </div>
      <SectionHeading title={t("builder.criteriaEditor")} meta={t("builder.criteria", { count: recipe.criteria.length })} />
      <CriteriaReadOnly criteria={recipe.criteria} />
    </section>
  </div>;
}

interface RecipeDraftEditorProps {
  working: RecipeWorkingDraft;
  error?: string;
  saving: boolean;
  blocked?: boolean;
  saveError: boolean;
  onChange: (update: (current: RecipeDraft) => RecipeDraft) => void;
  onDiscard: () => void;
  onPublish: () => void;
}

function RecipeDraftEditor({ working, error, saving, blocked, saveError, onChange, onDiscard, onPublish }: RecipeDraftEditorProps) {
  const { t } = useAppIntl();
  const draft = working.value;
  const [criterionKeys, setCriterionKeys] = useState(() => draft.criteria.map((_, index) => index));
  const nextCriterionKey = useRef(draft.criteria.length);
  const totalWeight = draft.criteria.reduce((total, criterion) => total + criterion.weight, 0);
  const addCriterion = () => {
    const key = nextCriterionKey.current++;
    setCriterionKeys((current) => [...current, key]);
    onChange((current) => ({ ...current, criteria: [...current.criteria, blankCriterion(nextCriterionId(current.criteria))] }));
  };
  const deleteCriterion = (index: number) => {
    setCriterionKeys((current) => current.filter((_, candidate) => candidate !== index));
    onChange((current) => ({ ...current, criteria: current.criteria.filter((_, candidate) => candidate !== index) }));
  };
  const updateCriterion = (index: number, update: Partial<IntelligenceCriterion>) => onChange((current) => ({
    ...current,
    criteria: current.criteria.map((criterion, candidate) => candidate === index ? { ...criterion, ...update } : criterion),
  }));
  return <div className={styles.editorScroll}>
    <EditorHeader title={draft.name || t("builder.untitledRecipe")} draft actions={<>
      <Button onClick={onDiscard} disabled={saving || blocked}><Trash2 size={14} aria-hidden="true" />{t("builder.discardDraft")}</Button>
      <Button variant="primary" onClick={onPublish} disabled={Boolean(error) || saving || blocked}><Save size={14} aria-hidden="true" />{saving ? t("builder.saving") : t("builder.publishVersion")}</Button>
    </>} />
    <fieldset className={styles.draftFields} disabled={saving || blocked} aria-busy={saving}>
    <section className={styles.editorContent}>
      {(error || saveError) && <p className={styles.error} role="alert">{saveError ? t("builder.saveError") : `${t("builder.invalidRecipe")}: ${error}`}</p>}
      <div className={styles.formGrid}>
        <label><SectionLabel>{t("builder.recipeId")}</SectionLabel><input value={draft.id} readOnly={working.mode === "version"} onChange={(event) => onChange((current) => ({ ...current, id: event.target.value }))} /></label>
        <label><SectionLabel>{t("builder.recipeName")}</SectionLabel><input value={draft.name} onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))} /></label>
        <label><SectionLabel>{t("builder.threshold")}</SectionLabel><input type="number" min={0} max={100} value={draft.threshold} onChange={(event) => onChange((current) => ({ ...current, threshold: Number(event.target.value) }))} /></label>
      </div>
      <SectionHeading title={t("builder.criteriaEditor")} meta={t("builder.weightTotal", { value: totalWeight })} action={<Button size="sm" onClick={addCriterion} disabled={draft.criteria.length >= 12}><Plus size={14} aria-hidden="true" />{t("builder.addCriterion")}</Button>} />
      <div className={styles.cardStack}>
        {draft.criteria.map((criterion, index) => <article key={criterionKeys[index]} className={styles.card}>
          <div className={styles.formGrid}>
            <label><SectionLabel>{t("builder.criterionId")}</SectionLabel><input value={criterion.id} onChange={(event) => updateCriterion(index, { id: event.target.value })} /></label>
            <label><SectionLabel>{t("builder.criterionName")}</SectionLabel><input value={criterion.name} onChange={(event) => updateCriterion(index, { name: event.target.value })} /></label>
            <label><SectionLabel>{t("builder.criterionWeight")}</SectionLabel><input type="number" min={0} max={1000} value={criterion.weight} onChange={(event) => updateCriterion(index, { weight: Number(event.target.value) })} /></label>
          </div>
          <label><SectionLabel>{t("builder.criterionDescription")}</SectionLabel><textarea rows={3} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></label>
          <div className={styles.cardActions}>
            <label><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(index, { required: event.target.checked })} />{t("builder.required")}</label>
            <label><input type="checkbox" checked={criterion.evidenceRequired !== false} onChange={(event) => updateCriterion(index, { evidenceRequired: event.target.checked })} />{t("builder.evidenceRequired")}</label>
            <Button variant="ghost" iconOnly aria-label={t("builder.deleteCriterion", { name: criterion.name || criterion.id })} onClick={() => deleteCriterion(index)} disabled={draft.criteria.length === 1}><Trash2 size={14} aria-hidden="true" /></Button>
          </div>
        </article>)}
      </div>
    </section>
    </fieldset>
  </div>;
}

function PublishedPlan({ plan, recipes, settingDefault, settingDefaultError, onNewVersion, onDuplicate, onSetDefault }: { plan: EvaluationPlan; recipes: IntelligenceRecipe[]; settingDefault: boolean; settingDefaultError: boolean; onNewVersion: () => void; onDuplicate: () => void; onSetDefault: () => void }) {
  const { locale, t } = useAppIntl();
  return <div className={styles.editorScroll}>
    <EditorHeader title={plan.name} version={plan.version} readOnly actions={<>
      {!plan.isDefault && <Button onClick={onSetDefault} disabled={settingDefault}><Star size={14} aria-hidden="true" />{settingDefault ? t("builder.settingDefault") : t("builder.setDefault")}</Button>}
      <Button onClick={onDuplicate}><Copy size={14} aria-hidden="true" />{t("builder.duplicate")}</Button>
      <Button variant="primary" onClick={onNewVersion}><FilePenLine size={14} aria-hidden="true" />{t("builder.newVersion")}</Button>
    </>} />
    <section className={styles.editorContent}>
      {settingDefaultError && <p className={styles.error} role="alert">{t("builder.saveError")}</p>}
      <div className={styles.factGrid}>
        <Fact label={t("builder.planId")} value={plan.id} />
        <Fact label={t("builder.operator")} value={t(`builder.operator.${plan.operator}`)} />
        <Fact label={t("builder.createdAt")} value={formatDate(plan.createdAt, locale)} />
      </div>
      <SectionHeading title={t("builder.planRecipes")} meta={t("builder.recipeCount", { count: plan.recipes.length })} />
      <PlanRecipesReadOnly plan={plan} recipes={recipes} />
    </section>
  </div>;
}

interface PlanDraftEditorProps {
  working: PlanWorkingDraft;
  recipes: IntelligenceRecipe[];
  error?: string;
  saving: boolean;
  blocked?: boolean;
  saveError: boolean;
  onChange: (update: (current: EvaluationPlanDraft) => EvaluationPlanDraft) => void;
  onDiscard: () => void;
  onPublish: () => void;
}

function PlanDraftEditor({ working, recipes, error, saving, blocked, saveError, onChange, onDiscard, onPublish }: PlanDraftEditorProps) {
  const { t } = useAppIntl();
  const draft = working.value;
  const families = groupVersions(recipes);
  const addRecipe = () => {
    const next = nextAvailableRecipe(recipes, draft.recipes);
    if (next) onChange((current) => ({ ...current, recipes: [...current.recipes, next] }));
  };
  return <div className={styles.editorScroll}>
    <EditorHeader title={draft.name || t("builder.untitledPlan")} draft actions={<>
      <Button onClick={onDiscard} disabled={saving || blocked}><Trash2 size={14} aria-hidden="true" />{t("builder.discardDraft")}</Button>
      <Button variant="primary" onClick={onPublish} disabled={Boolean(error) || saving || blocked}><Save size={14} aria-hidden="true" />{saving ? t("builder.saving") : t("builder.publishVersion")}</Button>
    </>} />
    <fieldset className={styles.draftFields} disabled={saving || blocked} aria-busy={saving}>
    <section className={styles.editorContent}>
      {(error || saveError) && <p className={styles.error} role="alert">{saveError ? t("builder.saveError") : `${t("builder.planInvalid")}: ${error}`}</p>}
      <div className={styles.formGrid}>
        <label><SectionLabel>{t("builder.planId")}</SectionLabel><input value={draft.id} readOnly={working.mode === "version"} onChange={(event) => onChange((current) => ({ ...current, id: event.target.value }))} /></label>
        <label><SectionLabel>{t("builder.planName")}</SectionLabel><input value={draft.name} onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))} /></label>
        <label><SectionLabel>{t("builder.operator")}</SectionLabel><select value={draft.operator} onChange={(event) => onChange((current) => ({ ...current, operator: event.target.value as EvaluationPlanDraft["operator"] }))}><option value="all">{t("builder.operator.all")}</option><option value="any">{t("builder.operator.any")}</option></select></label>
      </div>
      <div className={styles.operatorHelp}><Workflow size={20} aria-hidden="true" /><p>{t(`builder.operator.${draft.operator}.help`)}</p></div>
      <SectionHeading title={t("builder.planRecipes")} meta={t("builder.recipeCount", { count: draft.recipes.length })} action={<Button size="sm" onClick={addRecipe} disabled={draft.recipes.length >= MAX_PLAN_RECIPES || families.length <= draft.recipes.length}><Plus size={14} aria-hidden="true" />{t("builder.addRecipe")}</Button>} />
      {families.length === 0 ? <EmptyState>{t("builder.noRecipesForPlan")}</EmptyState> : <div className={styles.cardStack}>
        {draft.recipes.map((reference, index) => {
          const latest = latestRecipeVersion(recipes, reference.recipeId);
          const selectedFamilies = new Set(draft.recipes.filter((_, candidate) => candidate !== index).map((item) => item.recipeId));
          return <article key={`${index}-${recipeRefKey(reference)}`} className={styles.planStep}>
            <span className={styles.stepNumber}>{index + 1}</span>
            <label><SectionLabel>{t("builder.recipeVersion")}</SectionLabel><select aria-label={t("builder.recipePosition", { index: index + 1 })} value={recipeRefKey(reference)} onChange={(event) => {
              const parsed = parseRecipeRef(event.target.value);
              if (parsed) onChange((current) => ({ ...current, recipes: current.recipes.map((item, candidate) => candidate === index ? parsed : item) }));
            }}>{families.map((family) => <optgroup key={family.id} label={family.latest.name}>{family.versions.map((recipe) => <option key={recipeVersionKey(recipe)} value={recipeVersionKey(recipe)} disabled={selectedFamilies.has(recipe.id)}>{recipe.name} · v{recipe.version}</option>)}</optgroup>)}</select></label>
            <div className={styles.stepMeta}>{latest && latest > reference.recipeVersion && <Chip tone="sunset">{t("builder.newerVersion", { version: latest })}</Chip>}</div>
            <div className={styles.stepActions}>
              <Button variant="ghost" iconOnly aria-label={t("builder.moveUp")} onClick={() => onChange((current) => ({ ...current, recipes: moveItem(current.recipes, index, -1) }))} disabled={index === 0}><ArrowUp size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={t("builder.moveDown")} onClick={() => onChange((current) => ({ ...current, recipes: moveItem(current.recipes, index, 1) }))} disabled={index === draft.recipes.length - 1}><ArrowDown size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={t("builder.removeRecipe")} onClick={() => onChange((current) => ({ ...current, recipes: current.recipes.filter((_, candidate) => candidate !== index) }))} disabled={draft.recipes.length === 1}><Trash2 size={14} aria-hidden="true" /></Button>
            </div>
          </article>;
        })}
      </div>}
    </section>
    </fieldset>
  </div>;
}

function CriteriaReadOnly({ criteria }: { criteria: IntelligenceCriterion[] }) {
  const { t } = useAppIntl();
  return <div className={styles.cardStack}>{criteria.map((criterion) => <article key={criterion.id} className={styles.card}>
    <div className={styles.cardTitle}><span><strong>{criterion.name}</strong><small>{criterion.id}</small></span><Chip>{criterion.weight}</Chip></div>
    <p>{criterion.description}</p>
    <div className={styles.tagRow}>{criterion.required && <Chip>{t("builder.required")}</Chip>}{criterion.evidenceRequired !== false && <Chip>{t("builder.evidenceRequired")}</Chip>}</div>
  </article>)}</div>;
}

function PlanRecipesReadOnly({ plan, recipes }: { plan: EvaluationPlan; recipes: IntelligenceRecipe[] }) {
  const { t } = useAppIntl();
  return <div className={styles.cardStack}>{plan.recipes.map((reference, index) => {
    const recipe = recipes.find((candidate) => candidate.id === reference.recipeId && candidate.version === reference.recipeVersion);
    const latest = latestRecipeVersion(recipes, reference.recipeId);
    return <article key={recipeRefKey(reference)} className={styles.readOnlyStep}>
      <span className={styles.stepNumber}>{index + 1}</span>
      <span><strong>{recipe?.name ?? reference.recipeId}</strong><small>{reference.recipeId} · v{reference.recipeVersion}</small></span>
      {latest && latest > reference.recipeVersion && <Chip tone="sunset">{t("builder.newerVersion", { version: latest })}</Chip>}
    </article>;
  })}</div>;
}

function RecipeInspector({ family, selected }: { family?: VersionFamily<IntelligenceRecipe>; selected?: IntelligenceRecipe }) {
  const { t } = useAppIntl();
  return <><div className={styles.inspectorHeader}><SectionLabel>{t("builder.history")}</SectionLabel><strong>{selected?.name ?? t("builder.empty")}</strong></div>{family ? <dl className={styles.inspectorFacts}><FactRow label={t("builder.family")} value={family.id} /><FactRow label={t("builder.versionCountLabel")} value={String(family.versions.length)} /><FactRow label={t("builder.latestVersion")} value={`v${family.latest.version}`} /></dl> : <EmptyState>{t("builder.empty")}</EmptyState>}</>;
}

function PlanInspector({ family, selected, defaultPlan }: { family?: VersionFamily<EvaluationPlan>; selected?: EvaluationPlan; defaultPlan?: EvaluationPlan | null }) {
  const { t } = useAppIntl();
  return <><div className={styles.inspectorHeader}><SectionLabel>{t("builder.publishedPlan")}</SectionLabel><strong>{selected?.name ?? t("builder.noPlans")}</strong></div>{selected ? <dl className={styles.inspectorFacts}><FactRow label={t("builder.family")} value={selected.id} /><FactRow label={t("builder.versionCountLabel")} value={String(family?.versions.length ?? 1)} /><FactRow label={t("builder.defaultPlan")} value={selected.isDefault ? t("builder.yes") : t("builder.no")} /><FactRow label={t("builder.currentDefault")} value={defaultPlan ? `${defaultPlan.name} · v${defaultPlan.version}` : t("builder.none")} /></dl> : <EmptyState>{t("builder.noPlans")}</EmptyState>}</>;
}

function EditorHeader({ title, version, readOnly, draft, actions }: { title: string; version?: number; readOnly?: boolean; draft?: boolean; actions: React.ReactNode }) {
  const { t } = useAppIntl();
  return <header className={styles.editorHeader}><div><SectionLabel>{t("builder.title")}</SectionLabel><h2>{title}</h2><div className={styles.tagRow}>{version && <Chip>v{version}</Chip>}{readOnly && <Chip>{t("builder.readOnly")}</Chip>}{draft && <Chip tone="sunset">{t("common.draft")}</Chip>}</div></div><div className={styles.headerActions}>{actions}</div></header>;
}

function SectionHeading({ title, meta, action }: { title: string; meta?: string; action?: React.ReactNode }) {
  return <div className={styles.sectionHeading}><span><h3>{title}</h3>{meta && <small>{meta}</small>}</span>{action}</div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className={styles.fact}><SectionLabel>{label}</SectionLabel><strong>{value}</strong></div>;
}

function FactRow({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function BuilderState({ copy, retry }: { copy: string; retry?: () => void }) {
  const { t } = useAppIntl();
  return <EmptyState role={retry ? "alert" : "status"}><div className={styles.state}><h1>{t("builder.title")}</h1><p>{copy}</p>{retry && <Button onClick={retry}>{t("common.retry")}</Button>}</div></EmptyState>;
}

function nextCriterionId(criteria: IntelligenceCriterion[]): string {
  const used = new Set(criteria.map((criterion) => criterion.id));
  let index = criteria.length + 1;
  while (used.has(`criterion-${index}`)) index += 1;
  return `criterion-${index}`;
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
