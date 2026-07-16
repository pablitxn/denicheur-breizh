import { useEffect, useMemo, useState } from "react";
import { Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { useProperties, useRecipes, useSaveRecipe, useScorings } from "../../api/hooks";
import { Button, Chip, EmptyState, SectionLabel, Meter, ScoreBadge, Select } from "@denicheur-breizh/design-system";
import { getPropertyTitle, localizeRecipe, localizeScoring } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { MessageId } from "../../intl/messages";
import type { RecipeFilter, ScoreKey, ScoringRecipe } from "../../types";
import { formatDecimal, formatInteger, formatPercentage, formatPrice } from "../../utils/format";
import { getRecipeTotalWeight, isRecipeFilterValid, rankPropertiesByRecipe } from "../../utils/scoring";
import styles from "./BuilderView.module.css";

const scoreKeys: ScoreKey[] = ["coast", "quiet", "value", "family", "transit", "dpe", "flood"];
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
  const { data: scorings = [] } = useScorings();
  const { data: recipes = [], isLoading, error } = useRecipes();
  const { data: properties = [] } = useProperties();
  const saveRecipe = useSaveRecipe();
  const [activeTab, setActiveTab] = useState<"weights" | "filters" | "formula" | "qa">("weights");
  const [activeRecipeId, setActiveRecipeId] = useState("weekend");
  const [isCopyEdited, setIsCopyEdited] = useState(false);
  const [draft, setDraft] = useState<ScoringRecipe>(() => localizeRecipe(fallbackRecipe, locale));
  const isEditorReady =
    !isLoading &&
    draft.id === activeRecipeId &&
    recipes.some((recipe) => recipe.id === activeRecipeId);

  useEffect(() => {
    const recipe = recipes.find((item) => item.id === activeRecipeId);
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

        return {
          ...localized,
          weights: { ...recipe.weights },
          filters: recipe.filters.map((filter) => ({ ...filter })),
        };
      });
    }
  }, [activeRecipeId, isCopyEdited, locale, recipes]);

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

  const updateWeight = (key: ScoreKey, value: number) => {
    setDraft((current) => ({ ...current, weights: { ...current.weights, [key]: Math.max(0, Math.min(100, value)) } }));
  };

  const normalizeWeights = () => {
    setDraft((current) => {
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
    setDraft((current) => ({ ...current, filters: current.filters.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter)) }));
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
    setDraft((current) => ({
      ...current,
      filters: [...current.filters, { id: `filter-${Date.now()}`, field: "price", operator: "lte", value: "400000" }],
    }));
  };

  const deleteFilter = (id: string) => {
    setDraft((current) => ({ ...current, filters: current.filters.filter((filter) => filter.id !== id) }));
  };

  if (error) {
    return <EmptyState>{t("builder.error")}</EmptyState>;
  }

  return (
    <section className={styles.view} aria-busy={!isEditorReady} inert={!isEditorReady}>
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
          {isLoading && <span className={styles.muted}>{t("common.loading")}</span>}
          {localizedRecipes.map((recipe) => (
            <button
              key={recipe.id}
              className={activeRecipeId === recipe.id ? styles.presetActive : ""}
              type="button"
              onClick={() => {
                setIsCopyEdited(false);
                setActiveRecipeId(recipe.id);
              }}
            >
              <SlidersHorizontal size={14} />
              <span>{recipe.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.editor}>
        <header className={styles.editorHeader}>
          <div className={styles.titleBlock}>
            <div className={styles.statusRow}>
              <Chip active>{t("common.custom")}</Chip>
              <Chip tone={draft.status === "saved" ? "good" : "sunset"}>{draft.status === "saved" ? t("common.saved") : t("common.draft")}</Chip>
            </div>
            <input
              className={styles.titleInput}
              value={draft.name}
              name="recipe-name"
              autoComplete="off"
              disabled={!isEditorReady}
              onChange={(event) => {
                setIsCopyEdited(true);
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
              aria-label={t("builder.nameAria")}
            />
            <input
              className={styles.descriptionInput}
              value={draft.description}
              name="recipe-description"
              autoComplete="off"
              disabled={!isEditorReady}
              onChange={(event) => {
                setIsCopyEdited(true);
                setDraft((current) => ({ ...current, description: event.target.value }));
              }}
              aria-label={t("builder.descriptionAria")}
            />
          </div>
          <div className={styles.headerActions}>
            <Button
              variant="primary"
              onClick={() => saveRecipe.mutate(draft, { onSuccess: (savedRecipe) => setDraft(savedRecipe) })}
              disabled={!isEditorReady || saveRecipe.isPending || !canSave}
            >
              <Save size={14} />
              {saveRecipe.isPending ? t("builder.saving") : t("builder.save")}
            </Button>
          </div>
        </header>

        <nav className={styles.tabs} aria-label={t("builder.sections")} role="tablist">
          {[
            ["weights", t("builder.tab.weights")],
            ["filters", t("builder.tab.filters")],
            ["formula", t("builder.tab.formula")],
            ["qa", t("builder.tab.qa")],
          ].map(([id, label]) => (
            <button
              key={id}
              id={`builder-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`builder-panel-${id}`}
              className={activeTab === id ? styles.tabActive : ""}
              onClick={() => setActiveTab(id as typeof activeTab)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className={styles.content}>
          {saveRecipe.isError && <p className={styles.saveError} role="alert">{t("builder.saveError")}</p>}
          {!filtersAreValid && <p className={styles.saveError} role="alert">{t("builder.invalidFilters")}</p>}
          {activeTab === "weights" && (
            <section className={styles.weights} id="builder-panel-weights" role="tabpanel" aria-labelledby="builder-tab-weights">
              <div className={styles.sectionTop}>
                <SectionLabel>{t("builder.tab.weights")}</SectionLabel>
                <div>
                  <span className={totalWeight === 100 ? styles.totalOk : styles.totalWarn}>{totalWeight} / 100</span>
                  <Button size="sm" variant="ghost" onClick={normalizeWeights}>
                    {t("builder.normalize")}
                  </Button>
                </div>
              </div>

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
                        max={60}
                        value={weight}
                        aria-label={t("builder.weightingAria", { name: scoring.name })}
                        onChange={(event) => updateWeight(key, Number(event.target.value))}
                      />
                      <div className={styles.weightLegend}>
                        <span>{t("builder.weight.ignore")}</span>
                        <span>{weight === 0 ? t("builder.weight.out") : weight < 15 ? t("builder.weight.light") : weight < 35 ? t("builder.weight.strong") : t("builder.weight.dominant")}</span>
                        <span>60</span>
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
                <SectionLabel>{t("builder.exclusions")}</SectionLabel>
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
                  <Select aria-label={t("builder.filterOperatorAria")} value={filter.operator} onChange={(event) => updateFilter(filter.id, { operator: event.target.value as RecipeFilter["operator"] })}>
                    <option value="eq">=</option>
                    <option value="neq">!=</option>
                    {filter.field !== "type" && <option value="lte">&lt;=</option>}
                    {filter.field !== "type" && <option value="gte">&gt;=</option>}
                    {filter.field !== "type" && filter.field !== "dpe" && <option value="between">{t("filter.operator.between")}</option>}
                  </Select>
                  {filter.field === "type" ? (
                    <Select value={filter.value} aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })} onChange={(event) => updateFilter(filter.id, { value: event.target.value })}>
                      <option value="house">{t("property.type.house")}</option>
                      <option value="apartment">{t("property.type.apartment")}</option>
                      <option value="land">{t("property.type.land")}</option>
                    </Select>
                  ) : filter.field === "dpe" ? (
                    <Select value={filter.value} aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })} onChange={(event) => updateFilter(filter.id, { value: event.target.value })}>
                      {(["A", "B", "C", "D", "E", "F", "G"] as const).map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                    </Select>
                  ) : (
                    <input
                      value={filter.value}
                      name={`filter-${filter.id}`}
                      autoComplete="off"
                      inputMode="decimal"
                      aria-invalid={!isRecipeFilterValid(filter)}
                      aria-label={t("builder.filterValueAria", { field: localizedFilterField(filter.field) })}
                      onChange={(event) => updateFilter(filter.id, { value: event.target.value })}
                    />
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
              <SectionLabel>{t("builder.explicitFormula")}</SectionLabel>
              <pre>{buildFormula(draft)}</pre>
              <Chip active tone="good">{t("builder.validBlocks", { count: scoreKeys.filter((key) => draft.weights[key] > 0).length })}</Chip>
            </section>
          )}

          {activeTab === "qa" && (
            <section className={styles.qa} id="builder-panel-qa" role="tabpanel" aria-labelledby="builder-tab-qa">
              <div className={styles.qaStats}>
                <Stat label={t("builder.evaluatedProperties")} value={formatInteger(ranked.length, locale)} meterValue={ranked.length} />
                <Stat
                  label={t("builder.averageScore")}
                  value={formatDecimal(ranked.reduce((sum, item) => sum + item.customScore, 0) / Math.max(ranked.length, 1), locale, 2)}
                  meterValue={ranked.reduce((sum, item) => sum + item.customScore, 0) / Math.max(ranked.length, 1)}
                />
                <Stat label={t("builder.topScore")} value={formatDecimal(ranked[0]?.customScore ?? 0, locale)} meterValue={ranked[0]?.customScore ?? 0} />
                <Stat
                  label={t("builder.activeWeights")}
                  value={formatInteger(scoreKeys.filter((key) => draft.weights[key] > 0).length, locale)}
                  meterValue={scoreKeys.filter((key) => draft.weights[key] > 0).length}
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

      <aside className={styles.preview}>
        <div className={styles.previewHeader}>
          <SectionLabel>{t("builder.previewRanking")}</SectionLabel>
          <span>{previewRanked.length}</span>
        </div>
        <div className={styles.previewList}>
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

function Stat({ label, value, meterValue }: { label: string; value: string; meterValue: number }) {
  return (
    <div className={styles.stat}>
      <SectionLabel>{label}</SectionLabel>
      <strong>{value}</strong>
      <Meter value={meterValue || 5} max={10} />
    </div>
  );
}
