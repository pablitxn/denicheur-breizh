import { useEffect, useMemo, useState } from "react";
import { Play, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";
import { useProperties, useRecipes, useSaveRecipe, useScorings } from "../../api/hooks";
import { Button, Chip, EmptyState, FieldLabel, Meter, ScoreBadge, Select } from "../../components/ui";
import { getPropertyTitle, localizeRecipe, localizeScoring } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { RecipeFilter, ScoreKey, ScoringRecipe } from "../../types";
import { formatPrice } from "../../utils/format";
import { getRecipeTotalWeight, rankPropertiesByRecipe } from "../../utils/scoring";
import styles from "./BuilderView.module.css";

const scoreKeys: ScoreKey[] = ["coast", "quiet", "value", "family", "transit", "dpe", "flood"];

const fallbackRecipe: ScoringRecipe = {
  id: "draft",
  name: "Weekend retreat",
  description: "Residence secondaire, acces mer rapide, calme la nuit, prix defendable.",
  status: "draft",
  weights: { coast: 35, quiet: 25, value: 20, transit: 10, dpe: 10, family: 0, flood: 0 },
  filters: [
    { id: "f1", field: "price", operator: "lte", value: "480000" },
    { id: "f2", field: "type", operator: "eq", value: "Maison" },
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
  const [draft, setDraft] = useState<ScoringRecipe>(() => localizeRecipe(fallbackRecipe, locale));

  useEffect(() => {
    const recipe = recipes.find((item) => item.id === activeRecipeId);
    if (recipe) {
      const localizedRecipe = localizeRecipe(recipe, locale);
      setDraft({ ...localizedRecipe, weights: { ...localizedRecipe.weights }, filters: localizedRecipe.filters.map((filter) => ({ ...filter })) });
    }
  }, [activeRecipeId, locale, recipes]);

  const totalWeight = getRecipeTotalWeight(draft);
  const ranked = useMemo(() => rankPropertiesByRecipe(properties, draft).slice(0, 6), [draft, properties]);
  const palette = scoreKeys
    .map((key) => scorings.find((scoring) => scoring.id === key))
    .filter((scoring): scoring is NonNullable<typeof scoring> => Boolean(scoring));
  const localizedPalette = useMemo(() => palette.map((scoring) => localizeScoring(scoring, locale)), [locale, palette]);
  const localizedRecipes = useMemo(() => recipes.map((recipe) => localizeRecipe(recipe, locale)), [locale, recipes]);

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
    <section className={styles.view}>
      <aside className={styles.palette}>
        <div className={styles.paletteIntro}>
          <FieldLabel>{t("builder.availableBlocks")}</FieldLabel>
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
          <FieldLabel>{t("builder.presets")}</FieldLabel>
          {isLoading && <span className={styles.muted}>{t("common.loading")}</span>}
          {localizedRecipes.map((recipe) => (
            <button
              key={recipe.id}
              className={activeRecipeId === recipe.id ? styles.presetActive : ""}
              type="button"
              onClick={() => setActiveRecipeId(recipe.id)}
            >
              <SlidersHorizontal size={14} />
              <span>{recipe.name}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className={styles.editor}>
        <header className={styles.editorHeader}>
          <div className={styles.titleBlock}>
            <div className={styles.statusRow}>
              <Chip active>{t("common.custom")}</Chip>
              <Chip tone={draft.status === "saved" ? "good" : "sunset"}>{draft.status === "saved" ? t("common.saved") : t("common.draft")}</Chip>
            </div>
            <input
              className={styles.titleInput}
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              aria-label={t("builder.nameAria")}
            />
            <input
              className={styles.descriptionInput}
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              aria-label={t("builder.descriptionAria")}
            />
          </div>
          <div className={styles.headerActions}>
            <Button>
              <Play size={14} />
              {t("builder.testOn", { count: properties.length })}
            </Button>
            <Button variant="primary" onClick={() => saveRecipe.mutate(draft)} disabled={saveRecipe.isPending}>
              <Save size={14} />
              {saveRecipe.isPending ? t("builder.saving") : t("builder.save")}
            </Button>
          </div>
        </header>

        <nav className={styles.tabs} aria-label={t("builder.sections")}>
          {[
            ["weights", t("builder.tab.weights")],
            ["filters", t("builder.tab.filters")],
            ["formula", t("builder.tab.formula")],
            ["qa", t("builder.tab.qa")],
          ].map(([id, label]) => (
            <button key={id} type="button" className={activeTab === id ? styles.tabActive : ""} onClick={() => setActiveTab(id as typeof activeTab)}>
              {label}
            </button>
          ))}
        </nav>

        <div className={styles.content}>
          {activeTab === "weights" && (
            <section className={styles.weights}>
              <div className={styles.sectionTop}>
                <FieldLabel>{t("builder.tab.weights")}</FieldLabel>
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
            <section className={styles.filters}>
              <div className={styles.sectionTop}>
                <FieldLabel>{t("builder.exclusions")}</FieldLabel>
                <Button size="sm" onClick={addFilter}>
                  <Plus size={14} />
                  {t("builder.add")}
                </Button>
              </div>
              {draft.filters.map((filter) => (
                <div key={filter.id} className={styles.filterRow}>
                  <Select value={filter.field} onChange={(event) => updateFilter(filter.id, { field: event.target.value as RecipeFilter["field"] })}>
                    <option value="price">{t("filter.field.price")}</option>
                    <option value="surface">{t("filter.field.surface")}</option>
                    <option value="rooms">{t("filter.field.rooms")}</option>
                    <option value="dpe">{t("filter.field.dpe")}</option>
                    <option value="transit">{t("filter.field.transit")}</option>
                  </Select>
                  <Select value={filter.operator} onChange={(event) => updateFilter(filter.id, { operator: event.target.value as RecipeFilter["operator"] })}>
                    <option value="eq">=</option>
                    <option value="neq">!=</option>
                    <option value="lte">&lt;=</option>
                    <option value="gte">&gt;=</option>
                    <option value="between">{t("filter.operator.between")}</option>
                  </Select>
                  <input
                    value={filter.value}
                    name={`filter-${filter.id}`}
                    autoComplete="off"
                    aria-label={t("builder.filterValueAria", { field: filter.field })}
                    onChange={(event) => updateFilter(filter.id, { value: event.target.value })}
                  />
                  <Button variant="ghost" size="sm" iconOnly aria-label={t("builder.deleteFilter")} onClick={() => deleteFilter(filter.id)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </section>
          )}

          {activeTab === "formula" && (
            <section className={styles.formula}>
              <FieldLabel>{t("builder.explicitFormula")}</FieldLabel>
              <pre>{buildFormula(draft)}</pre>
              <Chip active tone="good">{t("builder.validBlocks", { count: scoreKeys.filter((key) => draft.weights[key] > 0).length })}</Chip>
            </section>
          )}

          {activeTab === "qa" && (
            <section className={styles.qa}>
              <div className={styles.qaStats}>
                <Stat label={t("builder.evaluatedProperties")} value={String(properties.length)} />
                <Stat label={t("builder.averageScore")} value={(ranked.reduce((sum, item) => sum + item.customScore, 0) / Math.max(ranked.length, 1)).toFixed(2)} />
                <Stat label={t("builder.topScore")} value={ranked[0]?.customScore.toFixed(1) ?? "0.0"} />
                <Stat label={t("builder.activeWeights")} value={String(scoreKeys.filter((key) => draft.weights[key] > 0).length)} />
              </div>
              <div className={styles.histogram}>
                {[2, 4, 6, 9, 14, 22, 28, 34, 30, 22, 18, 12, 8, 5, 3, 2, 1].map((height, index) => (
                  <span key={index} style={{ height: `${height * 3}px` }} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      <aside className={styles.preview}>
        <div className={styles.previewHeader}>
          <FieldLabel>{t("builder.previewRanking")}</FieldLabel>
          <span>{ranked.length}</span>
        </div>
        <div className={styles.previewList}>
          {ranked.map((property, index) => (
            <article key={property.id} className={styles.previewItem}>
              <b>{index + 1}</b>
              <div>
                <strong>{getPropertyTitle(property, locale)}</strong>
                <span>{property.locality} · {formatPrice(property.price, locale)}</span>
              </div>
              <ScoreBadge value={property.customScore} />
            </article>
          ))}
        </div>
        <div className={styles.mixBox}>
          <FieldLabel>{t("builder.mix")}</FieldLabel>
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
                <b>{draft.weights[key]}%</b>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <FieldLabel>{label}</FieldLabel>
      <strong>{value}</strong>
      <Meter value={Number(value) || 5} max={10} />
    </div>
  );
}
