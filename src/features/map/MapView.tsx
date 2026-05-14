import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { Layers, LocateFixed, Pencil, Plus, Search } from "lucide-react";
import { useProperties } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { Button, Chip, EmptyState, FieldLabel, Meter, ScoreBadge } from "../../components/ui";
import { getPropertyTitle, scoreMessageIds } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import type { MessageId } from "../../intl/messages";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { PropertyFilters, PropertyListing, ProviderName, ScoreKey } from "../../types";
import { formatPostedDays, formatPrice, formatPricePerM2, formatRooms } from "../../utils/format";
import { propertiesToGeoJson, regionsGeoJson } from "../../utils/mapData";
import styles from "./MapView.module.css";

const dpeGrades = ["A", "B", "C", "D", "E", "F"] as const;
const paintOptions: Array<{ id: ScoreKey; labelId: MessageId }> = [
  { id: "coast", labelId: scoreMessageIds.coast },
  { id: "value", labelId: scoreMessageIds.value },
  { id: "quiet", labelId: scoreMessageIds.quiet },
  { id: "family", labelId: scoreMessageIds.family },
];

const providerOptions: ProviderName[] = ["SeLoger", "Bien'ici", "Leboncoin", "Ouest-France"];
const mapTools = [
  { id: "select", labelId: "map.tool.select", icon: <LocateFixed size={15} /> },
  { id: "draw", labelId: "map.tool.draw", icon: <Pencil size={15} /> },
  { id: "point", labelId: "map.tool.point", icon: <Plus size={15} /> },
  { id: "layers", labelId: "map.tool.layers", icon: <Layers size={15} /> },
] satisfies Array<{ id: string; labelId: MessageId; icon: ReactNode }>;

const detailScoreKeys: Array<"overall" | ScoreKey> = [
  "overall",
  "coast",
  "quiet",
  "value",
  "family",
  "transit",
];

export function MapView() {
  const { locale, t } = useAppIntl();
  const selectedPropertyId = useWorkspaceStore((state) => state.selectedPropertyId);
  const setSelectedPropertyId = useWorkspaceStore((state) => state.setSelectedPropertyId);
  const toggleShortlist = useWorkspaceStore((state) => state.toggleShortlist);
  const shortlisted = useWorkspaceStore((state) => state.shortlistedPropertyIds);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [paintBy, setPaintBy] = useState<ScoreKey>("coast");
  const [activeTool, setActiveTool] = useState("select");
  const [filters, setFilters] = useState<PropertyFilters>({
    providers: providerOptions,
    priceMin: 120000,
    priceMax: 480000,
    surfaceMin: 80,
    dpeMax: "D",
  });

  const { data: properties = [], isLoading, error } = useProperties(filters);
  const latestPropertiesRef = useRef<PropertyListing[]>(properties);
  const selectedProperty = properties.find((property) => property.id === selectedPropertyId) ?? properties[0];

  useEffect(() => {
    latestPropertiesRef.current = properties;
  }, [properties]);

  const summary = useMemo(() => {
    const averageScore = properties.reduce((total, property) => total + property.scores.overall, 0) / Math.max(properties.length, 1);
    return { count: properties.length, averageScore };
  }, [properties]);

  useEffect(() => {
    let disposed = false;

    async function initMap() {
      if (!mapEl.current || mapRef.current) {
        return;
      }

      const maplibregl = await import("maplibre-gl");
      if (disposed || !mapEl.current) {
        return;
      }

      const map = new maplibregl.Map({
        container: mapEl.current,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: [
                "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
                "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
                "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
              ],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [
            {
              id: "osm",
              type: "raster",
              source: "osm",
              paint: {
                "raster-saturation": -0.5,
                "raster-brightness-min": 0.12,
                "raster-brightness-max": 0.68,
                "raster-contrast": 0.04,
                "raster-hue-rotate": 220,
              },
            },
          ],
        },
        center: [-2.05, 48.55],
        zoom: 8.75,
        attributionControl: false,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;

      map.on("load", () => {
        map.addSource("regions", { type: "geojson", data: regionsGeoJson() });
        map.addLayer({
          id: "regions-fill",
          type: "fill",
          source: "regions",
          paint: {
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "value"],
              0,
              "rgba(232, 116, 138, 0)",
              3,
              "rgba(232, 116, 138, 0.30)",
              5,
              "rgba(245, 165, 133, 0.36)",
              7,
              "rgba(240, 200, 120, 0.42)",
              9,
              "rgba(157, 211, 176, 0.50)",
            ],
            "fill-opacity": 0.82,
          },
        });
        map.addLayer({
          id: "regions-outline",
          type: "line",
          source: "regions",
          paint: {
            "line-color": "rgba(201, 179, 230, 0.28)",
            "line-width": 0.7,
          },
        });

        map.addSource("properties", { type: "geojson", data: propertiesToGeoJson(latestPropertiesRef.current) });
        map.addLayer({
          id: "properties-glow",
          type: "circle",
          source: "properties",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 8, 12, 22],
            "circle-color": "#c9b3e6",
            "circle-opacity": 0.24,
            "circle-blur": 0.58,
          },
        });
        map.addLayer({
          id: "properties-point",
          type: "circle",
          source: "properties",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 8],
            "circle-color": ["interpolate", ["linear"], ["get", "score"], 5, "#e8748a", 6.5, "#f5a585", 7.5, "#f0c878", 8.5, "#9dd3b0"],
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 1.5,
          },
        });

        map.on("click", "properties-point", (event) => {
          const id = event.features?.[0]?.properties?.id as string | undefined;
          if (id) {
            setSelectedPropertyId(id);
          }
        });
        map.on("mouseenter", "properties-point", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "properties-point", () => {
          map.getCanvas().style.cursor = "";
        });
      });
    }

    void initMap();

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [setSelectedPropertyId]);

  useEffect(() => {
    const source = mapRef.current?.getSource("properties") as GeoJSONSource | undefined;
    source?.setData(propertiesToGeoJson(properties));
  }, [properties]);

  const toggleProvider = (provider: ProviderName) => {
    setFilters((current) => {
      const providers = current.providers.includes(provider)
        ? current.providers.filter((item) => item !== provider)
        : [...current.providers, provider];
      return { ...current, providers };
    });
  };

  return (
    <section className={styles.view}>
      <aside className={styles.filterPanel}>
        <div className={styles.panelSection}>
          <div className={styles.sectionHeader}>
            <FieldLabel>{t("map.searchActive")}</FieldLabel>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setFilters({ providers: providerOptions, priceMin: 120000, priceMax: 480000, surfaceMin: 80, dpeMax: "D" })
              }
            >
              {t("map.reset")}
            </Button>
          </div>
          <div className={styles.chipWrap}>
            {providerOptions.map((provider) => (
              <Chip key={provider} active={filters.providers.includes(provider)} onClick={() => toggleProvider(provider)}>
                {provider}
              </Chip>
            ))}
            <Chip active>{t("property.type.house")}</Chip>
            <Chip>
              {formatPrice(filters.priceMin, locale)}-{formatPrice(filters.priceMax, locale)}
            </Chip>
          </div>
        </div>

        <div className={styles.panelSection}>
          <FieldLabel>{t("map.maxPrice")}</FieldLabel>
          <input
            className={styles.range}
            type="range"
            aria-label={t("map.maxPrice")}
            min="160000"
            max="540000"
            step="10000"
            value={filters.priceMax}
            onChange={(event) => setFilters((current) => ({ ...current, priceMax: Number(event.target.value) }))}
          />
          <div className={styles.rangeLegend}>
            <span>160 k</span>
            <span>{formatPrice(filters.priceMax, locale)}</span>
            <span>540 k</span>
          </div>

          <FieldLabel>{t("map.minSurface")}</FieldLabel>
          <input
            className={styles.range}
            type="range"
            aria-label={t("map.minSurface")}
            min="40"
            max="140"
            step="5"
            value={filters.surfaceMin}
            onChange={(event) => setFilters((current) => ({ ...current, surfaceMin: Number(event.target.value) }))}
          />
          <div className={styles.rangeLegend}>
            <span>40</span>
            <span>{filters.surfaceMin} m²</span>
            <span>140+</span>
          </div>

          <FieldLabel>{t("map.acceptedDpe")}</FieldLabel>
          <div className={styles.gradeRow}>
            {dpeGrades.map((grade) => (
              <button
                key={grade}
                type="button"
                className={[styles.grade, grade <= filters.dpeMax ? styles.gradeActive : ""].join(" ")}
                onClick={() => setFilters((current) => ({ ...current, dpeMax: grade }))}
              >
                {grade}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.panelSection}>
          <FieldLabel>{t("map.paintBy")}</FieldLabel>
          <div className={styles.radioStack}>
            {paintOptions.map((option) => (
              <label key={option.id} className={styles.radioRow}>
                <input type="radio" name="paint" checked={paintBy === option.id} onChange={() => setPaintBy(option.id)} />
                <span>{t(option.labelId)}</span>
                <i />
              </label>
            ))}
          </div>
        </div>

        <div className={styles.panelSection}>
          <FieldLabel>{t("map.layers")}</FieldLabel>
          <label className={styles.checkRow}>
            <input type="checkbox" defaultChecked />
            {t("map.schoolsLayer")}
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" defaultChecked />
            {t("map.transitLayer")}
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" />
            {t("map.noiseLayer")}
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" />
            {t("map.floodLayer")}
          </label>
        </div>
      </aside>

      <div className={styles.mapStage}>
        <div ref={mapEl} className={styles.mapCanvas} />
        <div className={styles.toolPalette}>
          {mapTools.map(({ id, labelId, icon }) => (
            <Button
              key={id}
              variant={activeTool === id ? "default" : "ghost"}
              size="sm"
              iconOnly
              aria-label={t(labelId)}
              onClick={() => setActiveTool(id)}
            >
              {icon}
            </Button>
          ))}
          <Button variant="ghost" size="sm">
            <Search size={14} />
            {t("map.searchButton")}
          </Button>
        </div>

        <div className={styles.mapNotice}>
          <span className={styles.goodDot} />
          <span>{t("map.summary", { count: summary.count, score: summary.averageScore.toFixed(1) })}</span>
        </div>

        <div className={styles.legend}>
          <div className={styles.sectionHeader}>
            <FieldLabel>{t(paintOptions.find((option) => option.id === paintBy)?.labelId ?? scoreMessageIds.coast)}</FieldLabel>
            <span>0-10</span>
          </div>
          <div className={styles.gradientBar} />
          <div className={styles.legendLabels}>
            <span>{t("map.legend.low")}</span>
            <span>{t("map.legend.high")}</span>
          </div>
          <div className={styles.legendMeta}>{isLoading ? t("common.loading") : t("map.legendMeta")}</div>
        </div>
      </div>

      <aside className={styles.detailPanel}>
        {error && <EmptyState>{t("map.errorProperties")}</EmptyState>}
        {!error && !selectedProperty && <EmptyState>{t("map.emptySelection")}</EmptyState>}
        {selectedProperty && (
          <>
            <PropertyVisual property={selectedProperty} size="lg" />
            <div className={styles.detailBody}>
              <div className={styles.detailTop}>
                <div>
                  <strong className={styles.price}>{formatPrice(selectedProperty.price, locale)}</strong>
                  <h1>{getPropertyTitle(selectedProperty, locale)}</h1>
                  <p>{selectedProperty.address}</p>
                </div>
                <ScoreBadge value={selectedProperty.scores.overall} />
              </div>

              <div className={styles.metaRow}>
                <span>{selectedProperty.surfaceM2} m²</span>
                <span>{formatRooms(selectedProperty.rooms, locale)}</span>
                <span>{formatPricePerM2(selectedProperty.price, selectedProperty.surfaceM2, locale)}</span>
                <span>{t("property.dpe")} {selectedProperty.dpe}</span>
              </div>

              <div className={styles.scoreStack}>
                <div className={styles.sectionHeader}>
                  <FieldLabel>{t("map.scoring")}</FieldLabel>
                  <span>{t("map.scoringRecipe")}</span>
                </div>
                {detailScoreKeys.map((key) => {
                  const value = key === "overall" ? selectedProperty.scores.overall : selectedProperty.scores[key];
                  return (
                  <div key={key} className={styles.scoreRow}>
                    <div>
                      <span>{t(scoreMessageIds[key])}</span>
                      <b>{value.toFixed(1)}</b>
                    </div>
                    <Meter value={value} />
                  </div>
                  );
                })}
              </div>

              <div className={styles.explain}>
                <FieldLabel>{t("map.why")}</FieldLabel>
                <p>{t("map.whyCoast", { score: (selectedProperty.scores.coast / 8).toFixed(1), distance: selectedProperty.diagnostics.coastalDistanceKm })}</p>
                <p>{t("map.whyTransit", { minutes: selectedProperty.diagnostics.transitMinutes })}</p>
                <p>{t("map.whyNoise", { db: selectedProperty.diagnostics.noiseDbNight })}</p>
              </div>

              <div className={styles.actions}>
                <Button className={styles.actionButton} onClick={() => toggleShortlist(selectedProperty.id)}>
                  {shortlisted.includes(selectedProperty.id) ? t("properties.shortlisted") : t("properties.shortlist")}
                </Button>
                <Button className={styles.actionButton} variant="primary">
                  {t("properties.listing")}
                </Button>
              </div>
              <span className={styles.posted}>{formatPostedDays(selectedProperty.postedDaysAgo, locale)}</span>
            </div>
          </>
        )}
      </aside>
    </section>
  );
}
