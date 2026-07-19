import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button, Chip, EmptyState, SectionLabel } from "@denicheur-breizh/design-system";
import { useActivateRecipe, useActiveRecipe, useRecipes, useSaveRecipe } from "../../api/hooks";
import { useAppIntl } from "../../intl/IntlContext";
import type { IntelligenceCriterion, IntelligenceRecipe, RecipeDraft } from "../../types";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./BuilderView.module.css";

const MAX_CRITERIA = 12;

export function BuilderView() {
  const { t } = useAppIntl();
  const recipesQuery = useRecipes();
  const activeQuery = useActiveRecipe();
  const saveRecipe = useSaveRecipe();
  const activateRecipe = useActivateRecipe();
  const recipes = recipesQuery.data ?? [];
  const [requestedVersion, setRequestedVersion] = useUrlState("brid", "", stringUrlCodec);
  const selectedRecipe = recipes.find((recipe) => recipeKey(recipe) === requestedVersion)
    ?? recipes.find((recipe) => recipe.active)
    ?? recipes[0];
  const [draft, setDraft] = useState<RecipeDraft>(() => blankRecipe());
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!selectedRecipe || dirty) return;
    setDraft(toDraft(selectedRecipe));
    if (requestedVersion !== recipeKey(selectedRecipe)) setRequestedVersion(recipeKey(selectedRecipe));
  }, [dirty, requestedVersion, selectedRecipe, setRequestedVersion]);

  const validation = useMemo(() => validateDraft(draft), [draft]);
  const totalWeight = useMemo(() => draft.criteria.reduce((sum, criterion) => sum + criterion.weight, 0), [draft.criteria]);

  const editDraft = (update: (current: RecipeDraft) => RecipeDraft) => {
    setDirty(true);
    setDraft(update);
  };

  const selectRecipe = (recipe: IntelligenceRecipe) => {
    if (dirty && !window.confirm(t("builder.discardConfirm"))) return;
    setDirty(false);
    setDraft(toDraft(recipe));
    setRequestedVersion(recipeKey(recipe));
  };

  const createRecipe = () => {
    if (dirty && !window.confirm(t("builder.discardConfirm"))) return;
    setDraft(blankRecipe());
    setDirty(true);
    setRequestedVersion("");
  };

  const addCriterion = () => {
    if (draft.criteria.length >= MAX_CRITERIA) return;
    const used = new Set(draft.criteria.map((criterion) => criterion.id));
    let index = draft.criteria.length + 1;
    while (used.has(`criterion-${index}`)) index += 1;
    editDraft((current) => ({ ...current, criteria: [...current.criteria, blankCriterion(`criterion-${index}`)] }));
  };

  const updateCriterion = (criterionId: string, update: Partial<IntelligenceCriterion>) => {
    editDraft((current) => ({
      ...current,
      criteria: current.criteria.map((criterion) => criterion.id === criterionId ? { ...criterion, ...update } : criterion),
    }));
  };

  const removeCriterion = (criterionId: string) => {
    editDraft((current) => ({ ...current, criteria: current.criteria.filter((criterion) => criterion.id !== criterionId) }));
  };

  const save = () => {
    if (!validation.valid) return;
    saveRecipe.mutate(draft, {
      onSuccess: (saved) => {
        setDraft(toDraft(saved));
        setDirty(false);
        setRequestedVersion(recipeKey(saved));
      },
    });
  };

  const activate = () => {
    if (!selectedRecipe || dirty) return;
    activateRecipe.mutate({ id: selectedRecipe.id, version: selectedRecipe.version });
  };

  if (recipesQuery.isLoading || activeQuery.isLoading) return <BuilderState title={t("builder.title")} copy={t("builder.loading")} />;
  if (recipesQuery.error || activeQuery.error) return <BuilderState title={t("builder.title")} copy={t("builder.error")} retry={() => void Promise.all([recipesQuery.refetch(), activeQuery.refetch()])} />;

  return (
    <section className={styles.view} aria-labelledby="builder-view-title">
      <aside className={styles.palette}>
        <div className={styles.paletteIntro}>
          <SectionLabel>{t("builder.recipeVersions")}</SectionLabel>
          <strong>{t("builder.versionCount", { count: recipes.length })}</strong>
          <Button size="sm" onClick={createRecipe}><Plus size={14} aria-hidden="true" />{t("builder.newRecipe")}</Button>
        </div>
        <div className={styles.presets}>
          {recipes.map((recipe) => (
            <button key={recipeKey(recipe)} className={recipeKey(recipe) === recipeKey(selectedRecipe) ? styles.presetActive : ""} type="button" onClick={() => selectRecipe(recipe)} aria-pressed={recipeKey(recipe) === recipeKey(selectedRecipe)} title={`${recipe.name} · v${recipe.version}`}>
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>{recipe.name} · v{recipe.version}</span>
              {recipe.active && <Check size={14} aria-label={t("builder.active")} />}
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.editor}>
        <header className={styles.editorHeader}>
          <div className={styles.titleBlock}>
            <h1 id="builder-view-title" className={styles.viewTitle}>{t("builder.title")}</h1>
            <div className={styles.statusRow} aria-live="polite">
              {selectedRecipe && <Chip>v{selectedRecipe.version}</Chip>}
              {selectedRecipe?.active && <Chip active tone="good">{t("builder.active")}</Chip>}
              {dirty && <Chip tone="sunset">{t("builder.unsaved")}</Chip>}
            </div>
          </div>
          <div className={styles.headerActions}>
            <Button onClick={activate} disabled={!selectedRecipe || dirty || selectedRecipe.active || activateRecipe.isPending}>
              <Check size={14} aria-hidden="true" />{activateRecipe.isPending ? t("builder.activating") : t("builder.activate")}
            </Button>
            <Button variant="primary" onClick={save} disabled={!validation.valid || saveRecipe.isPending}>
              <Save size={14} aria-hidden="true" />{saveRecipe.isPending ? t("builder.saving") : t("builder.saveVersion")}
            </Button>
          </div>
        </header>

        <div className={styles.content}>
          {(saveRecipe.isError || activateRecipe.isError) && <p className={styles.saveError} role="alert">{t("builder.saveError")}</p>}
          {!validation.valid && dirty && <p className={styles.saveError} role="alert">{t("builder.invalidRecipe")}: {validation.message}</p>}

          <section className={styles.weights}>
            <div className={styles.recipeFields}>
              <label><SectionLabel>{t("builder.recipeId")}</SectionLabel><input className={styles.titleInput} value={draft.id} onChange={(event) => editDraft((current) => ({ ...current, id: event.target.value }))} autoComplete="off" /></label>
              <label><SectionLabel>{t("builder.recipeName")}</SectionLabel><input className={styles.titleInput} value={draft.name} onChange={(event) => editDraft((current) => ({ ...current, name: event.target.value }))} autoComplete="off" /></label>
              <label><SectionLabel>{t("builder.threshold")}</SectionLabel><input className={styles.thresholdInput} type="number" min={0} max={100} value={draft.threshold} onChange={(event) => editDraft((current) => ({ ...current, threshold: Number(event.target.value) }))} /></label>
            </div>

            <div className={styles.sectionTop}>
              <div><h2 className={styles.sectionHeading}>{t("builder.criteriaEditor")}</h2><span className={styles.muted}>{t("builder.weightTotal", { value: totalWeight })}</span></div>
              <Button size="sm" onClick={addCriterion} disabled={draft.criteria.length >= MAX_CRITERIA}><Plus size={14} aria-hidden="true" />{t("builder.addCriterion")}</Button>
            </div>

            <div className={styles.weightStack}>
              {draft.criteria.map((criterion, index) => (
                <article key={`${criterion.id}-${index}`} className={styles.weightCard}>
                  <div className={styles.criterionGrid}>
                    <label><SectionLabel>{t("builder.criterionId")}</SectionLabel><input value={criterion.id} onChange={(event) => updateCriterion(criterion.id, { id: event.target.value })} /></label>
                    <label><SectionLabel>{t("builder.criterionName")}</SectionLabel><input value={criterion.name} onChange={(event) => updateCriterion(criterion.id, { name: event.target.value })} /></label>
                    <label><SectionLabel>{t("builder.criterionWeight")}</SectionLabel><input type="number" min={0} max={1000} value={criterion.weight} onChange={(event) => updateCriterion(criterion.id, { weight: Number(event.target.value) })} /></label>
                  </div>
                  <label><SectionLabel>{t("builder.criterionDescription")}</SectionLabel><textarea className={styles.descriptionInput} rows={3} value={criterion.description} onChange={(event) => updateCriterion(criterion.id, { description: event.target.value })} /></label>
                  <div className={styles.criterionActions}>
                    <label><input type="checkbox" checked={criterion.required} onChange={(event) => updateCriterion(criterion.id, { required: event.target.checked })} />{t("builder.required")}</label>
                    <label><input type="checkbox" checked={criterion.evidenceRequired ?? false} onChange={(event) => updateCriterion(criterion.id, { evidenceRequired: event.target.checked })} />{t("builder.evidenceRequired")}</label>
                    <Button size="sm" variant="ghost" iconOnly aria-label={t("builder.deleteCriterion", { name: criterion.name || criterion.id })} onClick={() => removeCriterion(criterion.id)} disabled={draft.criteria.length <= 1}><Trash2 size={14} aria-hidden="true" /></Button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>

      <aside className={styles.preview}>
        <div className={styles.previewHeader}><SectionLabel>{t("builder.publishedRecipe")}</SectionLabel></div>
        {activeQuery.data ? (
          <div className={styles.previewBody}>
            <h2>{activeQuery.data.name}</h2>
            <Chip active tone="good">v{activeQuery.data.version}</Chip>
            <dl className={styles.previewFacts}>
              <div><dt>{t("builder.threshold")}</dt><dd>{activeQuery.data.threshold} / 100</dd></div>
              <div><dt>{t("builder.criteriaEditor")}</dt><dd>{activeQuery.data.criteria.length}</dd></div>
              <div><dt>{t("builder.createdAt")}</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(activeQuery.data.createdAt ?? ""))}</dd></div>
            </dl>
            <p>{t("builder.extensionConsumesActive")}</p>
          </div>
        ) : <EmptyState>{t("builder.noActiveRecipe")}</EmptyState>}
      </aside>
    </section>
  );
}

function BuilderState({ title, copy, retry }: { title: string; copy: string; retry?: () => void }) {
  const { t } = useAppIntl();
  return <EmptyState role={retry ? "alert" : "status"}><div className={styles.stateContent}><h1>{title}</h1><p>{copy}</p>{retry && <Button onClick={retry}>{t("common.retry")}</Button>}</div></EmptyState>;
}

function recipeKey(recipe?: IntelligenceRecipe): string { return recipe ? `${recipe.id}:${recipe.version}` : ""; }
function toDraft(recipe: IntelligenceRecipe): RecipeDraft { return { id: recipe.id, name: recipe.name, threshold: recipe.threshold, criteria: recipe.criteria.map((criterion) => ({ ...criterion })) }; }
function blankCriterion(id: string): IntelligenceCriterion { return { id, name: "", description: "", weight: 1, required: false, evidenceRequired: true }; }
function blankRecipe(): RecipeDraft { return { id: `recipe-${Date.now()}`, name: "", threshold: 70, criteria: [blankCriterion("criterion-1")] }; }

function validateDraft(draft: RecipeDraft): { valid: boolean; message: string } {
  if (!draft.id.trim() || !draft.name.trim()) return { valid: false, message: "id/name" };
  if (!Number.isFinite(draft.threshold) || draft.threshold < 0 || draft.threshold > 100) return { valid: false, message: "threshold" };
  if (draft.criteria.length < 1 || draft.criteria.length > MAX_CRITERIA) return { valid: false, message: "criteria" };
  const ids = draft.criteria.map((criterion) => criterion.id.trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return { valid: false, message: "criterion ids" };
  if (draft.criteria.some((criterion) => !criterion.name.trim() || !criterion.description.trim() || !Number.isFinite(criterion.weight) || criterion.weight < 0)) return { valid: false, message: "criterion fields" };
  return { valid: true, message: "" };
}
