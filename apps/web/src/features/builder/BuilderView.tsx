import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { useProperties, useRecipes, useSaveRecipe, useScorings } from "../../api/hooks";
import { Button, Chip, EmptyState, SectionLabel, Meter, ScoreBadge, Select } from "@denicheur-breizh/design-system";
import { getPropertyTitle, localizeRecipe, localizeScoring } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { MessageId } from "../../intl/messages";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { RecipeFilter, ScoreKey, ScoringRecipe } from "../../types";
import { formatDecimal, formatInteger, formatPercentage, formatPrice } from "../../utils/format";
import { getRecipeTotalWeight, isRecipeFilterValid, rankPropertiesByRecipe } from "../../utils/scoring";
import { enumUrlCodec, stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import { workspaceUrlChangeEvent } from "../../utils/workspaceNavigation";
import styles from "./BuilderView.module.css";

const scoreKeys: ScoreKey[] = ["coast", "quiet", "value", "family", "transit", "dpe", "flood"];
const builderTabs = ["weights", "filters", "formula", "qa"] as const;
type BuilderTab = (typeof builderTabs)[number];
const builderTabUrlOptions = {
  ...enumUrlCodec(builderTabs),
  isDefault: (value: BuilderTab) => value === "weights",
};
const builderRecipeUrlOptions = {
  ...stringUrlCodec,
  isDefault: (value: string) => value === "weekend",
};
const filterFieldMessageIds: Record<RecipeFilter["field"], MessageId> = {
  price: "filter.field.price",
  type: "filter.field.type",
  surface: "filter.field.surface",
  rooms: "filter.field.rooms",
  dpe: "filter.field.dpe",
  transit: "filter.field.transit",
  coast: "score.coast",
  quiet: "score.quiet",
  value: "score.value",
  family: "score.family",
  flood: "score.flood",
};

const fallbackRecipe: ScoringRecipe = {
  id: "draft",
  name: "Weekend retreat",
  description: "Résidence secondaire, accès mer rapide, calme la nuit, prix défendable.",
  status: "draft",
  weights: { coast: 35, quiet: 25, value: 20, transit: 10, dpe: 10, family: 0, flood: 0 },
  filters: [
    { id: "f1", field: "price", operator: "lte", value: "480000" },
    { id: "f2", field: "type", operator: "eq", value: "house" },
    { id: "f3", field: "dpe", operator: "lte", value: "D" },
  ],
};

export function BuilderView() {
  const { locale, t } = useAppIntl();
  const scoringsQuery = useScorings();
  const recipesQuery = useRecipes();
  const propertiesQuery = useProperties();
  const scorings = scoringsQuery.data ?? [];
  const recipes = recipesQuery.data ?? [];
  const properties = propertiesQuery.data ?? [];
  const isLoading = scoringsQuery.isLoading || recipesQuery.isLoading || propertiesQuery.isLoading;
  const error = scoringsQuery.error || recipesQuery.error || propertiesQuery.error;
  const saveRecipe = useSaveRecipe();
  const [activeTab, setActiveTab] = useUrlState<BuilderTab>("btab", "weights", builderTabUrlOptions);
  const [requestedRecipeId, setRequestedRecipeId] = useUrlState("brid", "weekend", builderRecipeUrlOptions);
  const [isCopyEdited, setIsCopyEdited] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [draft, setDraft] = useState<ScoringRecipe>(() => localizeRecipe(fallbackRecipe, locale));
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const acceptedHrefRef = useRef(typeof window === "undefined" ? "" : window.location.href);
  const draftRevisionRef = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const activeRecipe = recipes.find((recipe) => recipe.id === requestedRecipeId) ?? recipes[0];
  const activeRecipeId = activeRecipe?.id ?? requestedRecipeId;

  useEffect(() => {
    const recipe = activeRecipe;
    if (recipe) {
      setDraft((current) => {
        const localized = localizeRecipe(recipe, locale);
        if (current.id === recipe.id) {
          return {
            ...current,
            ...(!isCopyEdited
              ? { name: localized.name, description: localized.description }
              : {}),
          };
        }

        draftRevisionRef.current += 1;
        return {
          ...localized,
          weights: { ...recipe.weights },
          filters: recipe.filters.map((filter) => ({ ...filter })),
        };
      });
    }
  }, [activeRecipe, activeRecipeId, isCopyEdited, locale]);

  useEffect(() => {
    if (activeRecipe && requestedRecipeId !== activeRecipe.id) setRequestedRecipeId(activeRecipe.id);
  }, [activeRecipe, requestedRecipeId, setRequestedRecipeId]);

  const pristineRecipe = useMemo(
    () => (activeRecipe ? localizeRecipe(activeRecipe, locale) : undefined),
    [activeRecipe, locale],
  );
  const isDirty = pristineRecipe ? recipeSignature(draft) !== recipeSignature(pristineRecipe) : false;

  const totalWeight = getRecipeTotalWeight(draft);
  const ranked = useMemo(() => rankPropertiesByRecipe(properties, draft), [draft, properties]);
  const previewRanked = ranked.slice(0, 6);
  const palette = scoreKeys
    .map((key) => scorings.find((scoring) => scoring.id === key))
    .filter((scoring): scoring is NonNullable<typeof scoring> => Boolean(scoring));
  const localizedPalette = useMemo(() => palette.map((scoring) => localizeScoring(scoring, locale)), [locale, palette]);
  const localizedRecipes = useMemo(() => recipes.map((recipe) => localizeRecipe(recipe, locale)), [locale, recipes]);
  const scoreDistribution = useMemo(() => {
    const bins = Array.from({ length: 10 }, () => 0);
    ranked.forEach((property) => {
      const index = Math.min(9, Math.max(0, Math.floor(property.customScore)));
      bins[index] += 1;
    });
    return bins;
  }, [ranked]);
  const maxDistributionCount = Math.max(...scoreDistribution, 1);
  const filtersAreValid = draft.filters.every(isRecipeFilterValid);
  const canSave = totalWeight === 100 && Boolean(draft.name.trim()) && filtersAreValid;
  const localizedFilterField = (field: RecipeFilter["field"]) => t(filterFieldMessageIds[field]);

  const editDraft = (updater: (current: ScoringRecipe) => ScoringRecipe) => {
    draftRevisionRef.current += 1;
    setDraft(updater);
  };

  useEffect(() => {
    if (!isDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handleDocumentClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.target === "_blank") return;
      const destination = new URL(target.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (!window.confirm(t("builder.discardConfirm"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleDocumentClick, true);
    };
  }, [isDirty, t]);

  useEffect(() => {
    const acceptCurrentHref = () => {
      acceptedHrefRef.current = window.location.href;
    };
    const handlePopState = () => {
      const poppedHref = window.location.href;
      if (!isDirty) {
        acceptedHrefRef.current = poppedHref;
        return;
      }

      if (window.confirm(t("builder.discardConfirm"))) {
        acceptedHrefRef.current = poppedHref;
        if (new URL(poppedHref).searchParams.get("view") === "builder" && pristineRecipe) {
          draftRevisionRef.current += 1;
          setDraft(cloneRecipe(pristineRecipe));
          setIsCopyEdited(false);
          setShowValidation(false);
        }
        return;
      }

      restoreCancelledBuilderPopstate(acceptedHrefRef.current);
    };

    window.addEventListener(workspaceUrlChangeEvent, acceptCurrentHref);
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener(workspaceUrlChangeEvent, acceptCurrentHref);
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isDirty, pristineRecipe, t]);

  const updateWeight = (key: ScoreKey, value: number) => {
    editDraft((current) => ({ ...current, weights: { ...current.weights, [key]: Math.max(0, Math.min(100, value)) } }));
  };

  const normalizeWeights = () => {
    editDraft((current) => {
      const activeKeys = scoreKeys.filter((key) => current.weights[key] > 0);
      const each = Math.floor(100 / Math.max(activeKeys.length, 1));
      const normalized = { ...current.weights };
      activeKeys.forEach((key, index) => {
        normalized[key] = each + (index === 0 ? 100 - each * activeKeys.length : 0);
      });
      return { ...current, weights: normalized };
    });
  };

  const updateFilter = (id: string, patch: Partial<RecipeFilter>) => {
    editDraft((current) => ({ ...current, filters: current.filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)) }));
  };

  const updateFilterField = (id: string, field: RecipeFilter["field"]) => {
    if (field === "type") {
      updateFilter(id, { field, operator: "eq", value: "house" });
    } else if (field === "dpe") {
      updateFilter(id, { field, operator: "lte", value: "D" });
    } else {
      updateFilter(id, { field, operator: "lte", value: "0" });
    }
  };

  const addFilter = () => {
    editDraft((current) => ({
      ...current,
      filters: [...current.filters, { id: `filter-${Date.now()}`, field: "price", operator: "lte", value: "400000" }],
    }));
  };

  const deleteFilter = (id: string) => {
    if (!window.confirm(t("builder.deleteConfirm"))) return;
    editDraft((current) => ({ ...current, filters: current.filters.filter((filter) => filter.id !== id) }));
  };

  const selectRecipe = (recipeId: string) => {
    if (recipeId === activeRecipeId) return;
    if (isDirty && !window.confirm(t("builder.discardConfirm"))) return;
    draftRevisionRef.current += 1;
    setIsCopyEdited(false);
    setShowValidation(false);
    setRequestedRecipeId(recipeId);
  };

  const selectTab = (tab: BuilderTab) => {
    setActiveTab(tab);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: BuilderTab) => {
    const currentIndex = builderTabs.indexOf(tab);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % builderTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + builderTabs.length) % builderTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = builderTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = builderTabs[nextIndex];
    selectTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`builder-tab-${nextTab}`)?.focus());
  };

  const saveDraft = () => {
    setShowValidation(true);
    if (!draft.name.trim()) {
      titleInputRef.current?.focus();
      return;
    }
    if (totalWeight !== 100) {
      selectTab("weights");
      focusBuilderControl("builder-weight-coast");
      return;
    }
    if (!filtersAreValid) {
      selectTab("filters");
      const firstInvalidFilter = draft.filters.find((filter) => !isRecipeFilterValid(filter));
      if (firstInvalidFilter) {
        focusBuilderControl(`builder-filter-${firstInvalidFilter.id}${firstInvalidFilter.operator === "between" ? "-min" : ""}`);
      }
      return;
    }

    const submittedRevision = draftRevisionRef.current;
    const submittedRecipeId = draft.id;
    saveRecipe.mutate(draft, {
      onSuccess: (savedRecipe) => {
        if (!shouldApplySavedRecipe(submittedRevision, draftRevisionRef.current, submittedRecipeId, draftRef.current.id)) return;
        setDraft(savedRecipe);
        setIsCopyEdited(false);
        setShowValidation(false);
      },
    });
  };

  const retryBuilder = () => {
    void Promise.all([scoringsQuery.refetch(), recipesQuery.refetch(), propertiesQuery.refetch()]);
  };

  if (error) {
    return (
      <EmptyState role="alert">
        <div className={styles.stateContent}>
          <h1>{t("builder.title")}</h1>
          <p>{t("builder.error")}</p>
          <Button onClick={retryBuilder}>{t("common.retry")}</Button>
        </div>
      </EmptyState>
    );
  }

  if (isLoading) {
    return (
      <EmptyState role="status">
        <div className={styles.stateContent}>
          <h1>{t("builder.title")}</h1>
          <p>{t("builder.loading")}</p>
        </div>
      </EmptyState>
    );
  }

  if (recipes.length === 0) {
    return (
      <EmptyState>
        <div className={styles.stateContent}>
          <h1>{t("builder.title")}</h1>
          <p>{t("builder.empty")}</p>
          <Button onClick={retryBuilder}>{t("common.retry")}</Button>
        </div>
      </EmptyState>
    );
  }

  const palettePanel = (
    <aside className={styles.palette}>
      <div className={styles.paletteIntro}>
        <SectionLabel>{t("builder.availableBlocks")}</SectionLabel>
        <strong>{t("builder.criteria", { count: palette.length })}</strong>
      </div>
      <div className={styles.paletteList}>
        {localizedPalette.map((scoring) => (
          <button key={scoring.id} type="button" onClick={() => updateWeight(scoring.id as ScoreKey, Math.max(draft.weights[scoring.id as ScoreKey], 10))}>
            <span>{scoring.name.slice(0, 2)}</span>
            <div>
              <strong>{scoring.name}</strong>
              <small>{scoring.group}</small>
            </div>
            <Plus size={14} />
          </button>
        ))}
      </div>

      <div className={styles.presets}>
        <SectionLabel>{t("builder.presets")}</SectionLabel>
        {localizedRecipes.map((recipe) => (
          <button
            key={recipe.id}
            className={activeRecipeId === recipe.id ? styles.presetActive : ""}
            type="button"
            onClick={() => selectRecipe(recipe.id)}
            aria-pressed={activeRecipeId === recipe.id}
          >
            <SlidersHorizontal size={14} />
            <span>{recipe.name}</span>
          </button>
        ))}
      </div>
    </aside>
  );

  return (
    <section className={styles.view} aria-labelledby="builder-view-title">
      <section className={styles.editor}>
        <header className={styles.editorHeader}>
          <div className={styles.titleBlock}>
            <h1 id="builder-view-title" className={styles.viewTitle}>{t("builder.title")}</h1>
            <div className={styles.statusRow} aria-live="polite">
              <Chip active>{t("common.custom")}</Chip>
              <Chip tone={draft.status === "saved" ? "good" : "sunset"}>{draft.status === "saved" ? t("common.saved") : t("common.draft")}</Chip>
              {isDirty && <Chip tone="sunset">{t("builder.unsaved")}</Chip>}
            </div>
            <input
              ref={titleInputRef}
              className={styles.titleInput}
              value={draft.name}
              name="recipe-name"
              autoComplete="off"
              aria-invalid={showValidation && !draft.name.trim()}
              aria-describedby={showValidation && !draft.name.trim() ? "builder-name-error" : undefined}
              onChange={(event) => {
                setIsCopyEdited(true);
                editDraft((current) => ({ ...current, name: event.target.value }));
              }}
              aria-label={t("builder.nameAria")}
            />
            {showValidation && !draft.name.trim() && <span id="builder-name-error" className={styles.fieldError}>{t("builder.nameError")}</span>}
            <textarea
              className={styles.descriptionInput}
              value={draft.description}
              name="recipe-description"
              autoComplete="off"
              rows={3}
              onChange={(event) => {
                setIsCopyEdited(true);
                editDraft((current) => ({ ...current, description: event.target.value }));
              }}
              aria-label={t("builder.descriptionAria")}
            />
          </div>
          <div className={styles.headerActions}>
            <Button
              variant="primary"
              onClick={saveDraft}
              disabled={saveRecipe.isPending}
            >
              <Save size={14} />
              {saveRecipe.isPending ? t("builder.saving") : t("builder.save")}
            </Button>
          </div>
        </header>

        <nav className={styles.tabs} aria-label={t("builder.sections")} role="tablist">
          {builderTabs.map((id) => (
            <button
              key={id}
              id={`builder-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`builder-panel-${id}`}
              className={activeTab === id ? styles.tabActive : ""}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => selectTab(id)}
              onKeyDown={(event) => handleTabKeyDown(event, id)}
            >
              {t(`builder.tab.${id}` as MessageId)}
            </button>
          ))}
        </nav>

        <div className={styles.content}>
          {saveRecipe.isError && <p className={styles.saveError} role="alert">{t("builder.saveError")}</p>}
          {showValidation && !filtersAreValid && <p className={styles.saveError} role="alert">{t("builder.invalidFilters")}</p>}
          {activeTab === "weights" && (
            <section className={styles.weights} id="builder-panel-weights" role="tabpanel" aria-labelledby="builder-tab-weights">
              <div className={styles.sectionTop}>
                <h2 className={styles.sectionHeading}>{t("builder.tab.weights")}</h2>
                <div>
                  <span className={totalWeight === 100 ? styles.totalOk : styles.totalWarn}>{totalWeight} / 100</span>
                  <Button size="sm" variant="ghost" onClick={normalizeWeights}>
                    {t("builder.normalize")}
                  </Button>
                </div>
              </div>
              {showValidation && totalWeight !== 100 && <p className={styles.fieldError} role="alert">{t("builder.totalError")}</p>}

              <div className={styles.weightStack}>
                {localizedPalette.map((scoring) => {
                  const key = scoring.id as ScoreKey;
                  const weight = draft.weights[key] ?? 0;
                  return (
                    <article key={scoring.id} className={styles.weightCard}>
                      <div className={styles.weightHeader}>
                        <div>
                          <strong>{scoring.name}</strong>
                          <span>{scoring.short}</span>
                        </div>
                        <label>
                          <input
                            id={`builder-weight-${key}`}
                            type="number"
                            min={0}
                            max={100}
                            value={weight}
                            aria-label={t("builder.weightAria", { name: scoring.name })}
                            onChange={(event) => updateWeight(key, Number(event.target.value))}
                          />
                          %
                        </label>
                      </div>
                      <input
                        className={styles.range}
                        type="range"
                        min={0}
                        max={100}
                        value={weight}
                        aria-label={t("builder.weightingAria", { name: scoring.name })}
                        onChange={(event) => updateWeight(key, Number(event.target.value))}
                      />
                      <div className={styles.weightLegend}>
                        <span>{t("builder.weight.ignore")}</span>
                        <span>{weight === 0 ? t("builder.weight.out") : weight < 15 ? t("builder.weight.light") : weight < 35 ? t("builder.weight.strong") : t("builder.weight.dominant")}</span>
                        <span>100</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {activeTab === "filters" && (
            <section className={styles.filters} id="builder-panel-filters" role="tabpanel" aria-labelledby="builder-tab-filters">
              <div className={styles.sectionTop}>
                <h2 className={styles.sectionHeading}>{t("builder.exclusions")}</h2>
                <Button size="sm" onClick={addFilter}>
                  <Plus size={14} />
                  {t("builder.add")}
                </Button>
              </div>
              {draft.filters.map((filter) => (
                <div key={filter.id} className={styles.filterRow}>
                  <Select aria-label={t("builder.filterFieldAria")} value={filter.field} onChange={(event) => updateFilterField(filter.id, event.target.value as RecipeFilter["field"])}>
                    <option value="price">{t("filter.field.price")}</option>
                    <option value="type">{t("filter.field.type")}</option>
                    <option value="surface">{t("filter.field.surface")}</option>
                    <option value="rooms">{t("filter.field.rooms")}</option>
                    <option value="dpe">{t("filter.field.dpe")}</option>
                    <option value="transit">{t("filter.field.transit")}</option>
                  </Select>
                  <Select
                    aria-label={t("builder.filterOperatorAria")}
                    value={filter.operator}
                    onChange={(event) => {
                      const operator = event.target.value as RecipeFilter["operator"];
                      updateFilter(filter.id, {
                        operator,
                        value: operator === "between" && !parseRangeValue(filter.value) ? `${filter.value || "0"}..${filter.value || "0"}` : filter.value,
                      });
                    }}
                  >
                    <option value="eq">=</option>
                    <option value="neq">!=</option>
                    {filter.field !== "type" && <option value="lte">&lt;=</option>}
                    {filter.field !== "type" && <option value="gte">&gt;=</option>}
                    {filter.field !== "type" && filter.field !== "dpe" && <option value="between">{t("filter.operator.between")}</option>}
                  </Select>
                  {filter.field === "type" ? (
                    <Select id={`builder-filter-${filter.id}`} value={filter.value} aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })} onChange={(event) => updateFilter(filter.id, { value: event.target.value })}>
                      <option value="house">{t("property.type.house")}</option>
                      <option value="apartment">{t("property.type.apartment")}</option>
                      <option value="land">{t("property.type.land")}</option>
                    </Select>
                  ) : filter.field === "dpe" ? (
                    <Select id={`builder-filter-${filter.id}`} value={filter.value} aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })} onChange={(event) => updateFilter(filter.id, { value: event.target.value })}>
                      {(["A", "B", "C", "D", "E", "F", "G"] as const).map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                    </Select>
                  ) : filter.operator === "between" ? (
                    <div className={styles.filterValue}>
                      <div className={styles.rangeValues}>
                        <input
                          id={`builder-filter-${filter.id}-min`}
                          value={parseRangeValue(filter.value)?.[0] ?? ""}
                          name={`filter-${filter.id}-min`}
                          autoComplete="off"
                          inputMode="decimal"
                          aria-invalid={!isRecipeFilterValid(filter)}
                          aria-describedby={!isRecipeFilterValid(filter) ? `filter-error-${filter.id}` : undefined}
                          aria-label={t("builder.rangeMin", { field: localizedFilterField(filter.field) })}
                          placeholder={t("builder.rangeMinPlaceholder")}
                          onChange={(event) => updateFilter(filter.id, { value: updateRangeValue(filter.value, 0, event.target.value) })}
                        />
                        <span aria-hidden="true">–</span>
                        <input
                          id={`builder-filter-${filter.id}-max`}
                          value={parseRangeValue(filter.value)?.[1] ?? ""}
                          name={`filter-${filter.id}-max`}
                          autoComplete="off"
                          inputMode="decimal"
                          aria-invalid={!isRecipeFilterValid(filter)}
                          aria-describedby={!isRecipeFilterValid(filter) ? `filter-error-${filter.id}` : undefined}
                          aria-label={t("builder.rangeMax", { field: localizedFilterField(filter.field) })}
                          placeholder={t("builder.rangeMaxPlaceholder")}
                          onChange={(event) => updateFilter(filter.id, { value: updateRangeValue(filter.value, 1, event.target.value) })}
                        />
                      </div>
                      {!isRecipeFilterValid(filter) && <span id={`filter-error-${filter.id}`} className={styles.fieldError}>{t("builder.filterError")}</span>}
                    </div>
                  ) : (
                    <div className={styles.filterValue}>
                      <input
                        id={`builder-filter-${filter.id}`}
                        value={filter.value}
                        name={`filter-${filter.id}`}
                        autoComplete="off"
                        inputMode="decimal"
                        aria-invalid={!isRecipeFilterValid(filter)}
                        aria-describedby={!isRecipeFilterValid(filter) ? `filter-error-${filter.id}` : undefined}
                        aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })}
                        onChange={(event) => updateFilter(filter.id, { value: event.target.value })}
                      />
                      {!isRecipeFilterValid(filter) && <span id={`filter-error-${filter.id}`} className={styles.fieldError}>{t("builder.filterError")}</span>}
                    </div>
                  )}
                  <Button variant="ghost" size="sm" iconOnly aria-label={t("builder.deleteFilter")} onClick={() => deleteFilter(filter.id)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </section>
          )}

          {activeTab === "formula" && (
            <section className={styles.formula} id="builder-panel-formula" role="tabpanel" aria-labelledby="builder-tab-formula">
              <h2 className={styles.sectionHeading}>{t("builder.explicitFormula")}</h2>
              <pre>{buildFormula(draft)}</pre>
              <Chip active={canSave} tone={canSave ? "good" : "sunset"}>
                {canSave
                  ? t("builder.validBlocks", { count: scoreKeys.filter((key) => draft.weights[key] > 0).length })
                  : t("builder.invalidRecipe")}
              </Chip>
            </section>
          )}

          {activeTab === "qa" && (
            <section className={styles.qa} id="builder-panel-qa" role="tabpanel" aria-labelledby="builder-tab-qa">
              <h2 className={styles.sectionHeading}>{t("builder.tab.qa")}</h2>
              <div className={styles.qaStats}>
                <Stat label={t("builder.evaluatedProperties")} value={formatInteger(ranked.length, locale)} meterValue={ranked.length} max={Math.max(properties.length, 1)} />
                <Stat
                  label={t("builder.averageScore")}
                  value={formatDecimal(ranked.reduce((sum, item) => sum + item.customScore, 0) / Math.max(ranked.length, 1), locale, 2)}
                  meterValue={ranked.reduce((sum, item) => sum + item.customScore, 0) / Math.max(ranked.length, 1)}
                  max={10}
                />
                <Stat label={t("builder.topScore")} value={formatDecimal(ranked[0]?.customScore ?? 0, locale)} meterValue={ranked[0]?.customScore ?? 0} max={10} />
                <Stat
                  label={t("builder.activeWeights")}
                  value={formatInteger(scoreKeys.filter((key) => draft.weights[key] > 0).length, locale)}
                  meterValue={scoreKeys.filter((key) => draft.weights[key] > 0).length}
                  max={scoreKeys.length}
                />
              </div>
              <div className={styles.histogram} role="img" aria-label={t("builder.distributionAria")}>
                {scoreDistribution.map((count, index) => (
                  <span
                    key={index}
                    title={t("builder.distributionBin", {
                      from: formatInteger(index, locale),
                      to: formatInteger(index + 1, locale),
                      count: formatInteger(count, locale),
                    })}
                    style={{ height: count === 0 ? "2px" : `${(count / maxDistributionCount) * 100}%` }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </section>

      {palettePanel}

      <aside className={styles.preview}>
        <div className={styles.previewHeader}>
          <SectionLabel>{t("builder.previewRanking")}</SectionLabel>
          <span>{previewRanked.length}</span>
        </div>
        <div className={styles.previewList}>
          {previewRanked.length === 0 && <EmptyState className={styles.previewEmpty}>{t("builder.previewEmpty")}</EmptyState>}
          {previewRanked.map((property, index) => (
            <article key={property.id} className={styles.previewItem}>
              <b>{formatInteger(index + 1, locale)}</b>
              <div>
                <strong>{getPropertyTitle(property, locale)}</strong>
                <span>{property.locality} · {formatPrice(property.price, locale)}</span>
              </div>
              <ScoreBadge
                value={property.customScore}
                displayValue={formatDecimal(property.customScore, locale)}
                label={t("score.valueAria", {
                  name: t("builder.topScore"),
                  value: formatDecimal(property.customScore, locale),
                })}
              />
            </article>
          ))}
        </div>
        <div className={styles.mixBox}>
          <SectionLabel>{t("builder.mix")}</SectionLabel>
          <div className={styles.mixBar}>
            {scoreKeys
              .filter((key) => draft.weights[key] > 0)
              .map((key) => (
                <span key={key} style={{ width: `${(draft.weights[key] / Math.max(totalWeight, 1)) * 100}%` }} />
              ))}
          </div>
          {scoreKeys
            .filter((key) => draft.weights[key] > 0)
            .map((key) => (
              <div key={key} className={styles.mixRow}>
                <span>{localizedPalette.find((scoring) => scoring.id === key)?.name ?? key}</span>
                <b>{formatPercentage(draft.weights[key], locale)}</b>
              </div>
            ))}
        </div>
      </aside>
    </section>
  );
}

function buildFormula(recipe: ScoringRecipe) {
  const total = Math.max(getRecipeTotalWeight(recipe), 1);
  return scoreKeys
    .filter((key) => recipe.weights[key] > 0)
    .map((key, index) => `${index === 0 ? "score =" : "       +"} ${(recipe.weights[key] / total).toFixed(2)} x ${key}`)
    .join("\n");
}

function recipeSignature(recipe: ScoringRecipe) {
  return JSON.stringify({
    ...recipe,
    weights: scoreKeys.map((key) => [key, recipe.weights[key]]),
    filters: recipe.filters.map(({ id: _id, ...filter }) => filter),
  });
}

function cloneRecipe(recipe: ScoringRecipe): ScoringRecipe {
  return {
    ...recipe,
    weights: { ...recipe.weights },
    filters: recipe.filters.map((filter) => ({ ...filter })),
  };
}

export function shouldApplySavedRecipe(
  submittedRevision: number,
  currentRevision: number,
  submittedRecipeId: string,
  currentRecipeId: string,
) {
  return submittedRevision === currentRevision && submittedRecipeId === currentRecipeId;
}

export function restoreCancelledBuilderPopstate(previousHref: string) {
  window.history.pushState({}, "", previousHref);
  useWorkspaceStore.getState().setActiveView("builder");
  window.dispatchEvent(new CustomEvent(workspaceUrlChangeEvent));
}

export function focusBuilderControl(
  elementId: string,
  scheduler: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(window),
) {
  scheduler(() => document.getElementById(elementId)?.focus());
}

export function parseRangeValue(value: string): [string, string] | undefined {
  const match = value.match(/^\s*(.*?)\s*(?:\.\.|-|,|;)\s*(.*?)\s*$/);
  if (!match || !match[1] || !match[2]) return undefined;
  return [match[1].trim(), match[2].trim()];
}

export function updateRangeValue(value: string, bound: 0 | 1, nextValue: string) {
  const current = parseRangeValue(value) ?? ["", ""];
  current[bound] = nextValue;
  return `${current[0]}..${current[1]}`;
}

function Stat({ label, value, meterValue, max }: { label: string; value: string; meterValue: number; max: number }) {
  return (
    <div className={styles.stat}>
      <SectionLabel>{label}</SectionLabel>
      <strong>{value}</strong>
      <Meter value={meterValue} max={max} />
    </div>
  );
}
