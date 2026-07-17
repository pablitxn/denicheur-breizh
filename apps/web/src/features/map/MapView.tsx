import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useProperties } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { Button, Chip, EmptyState, SectionLabel, Meter, ScoreBadge, Select } from "@denicheur-breizh/design-system";
import { getPropertyTitle, scoreMessageIds } from "../../intl/domain";
import { useAppIntl } from "../../intl/IntlContext";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { PropertyFilters, PropertyListing, PropertyType, ProviderName, ScoreKey } from "../../types";
import { formatDecimal, formatDistanceKm, formatInteger, formatPostedDays, formatPrice, formatPricePerM2, formatRooms } from "../../utils/format";
import { propertiesToGeoJson, regionsGeoJson } from "../../utils/mapData";
import {
  enumUrlCodec,
  numberUrlCodec,
  stringArrayUrlCodec,
  stringUrlCodec,
  useUrlState,
} from "../../utils/useUrlState";
import styles from "./MapView.module.css";

const dpeGrades = ["A", "B", "C", "D", "E", "F", "G"] as const;
const providerOptions: ProviderName[] = ["SeLoger", "Bien'ici", "Leboncoin", "Ouest-France"];
const propertyTypeOptions: PropertyType[] = ["house", "apartment", "land"];
const defaultMapFilters: PropertyFilters = {
  providers: providerOptions,
  propertyTypes: ["house"],
  priceMin: 120000,
  priceMax: 480000,
  surfaceMin: 80,
  dpeMax: "D",
};

const mapProviderUrlOptions = {
  ...stringArrayUrlCodec(providerOptions),
  isDefault: (value: ProviderName[]) => sameMembers(value, defaultMapFilters.providers),
};
const mapPropertyTypeUrlOptions = {
  ...stringArrayUrlCodec(propertyTypeOptions),
  isDefault: (value: PropertyType[]) => sameMembers(value, defaultMapFilters.propertyTypes),
};
const mapPriceUrlOptions = boundedNumberUrlOptions(160000, 540000, defaultMapFilters.priceMax);
const mapSurfaceUrlOptions = boundedNumberUrlOptions(40, 140, defaultMapFilters.surfaceMin);
const mapDpeUrlOptions = {
  ...enumUrlCodec(dpeGrades),
  isDefault: (value: PropertyFilters["dpeMax"]) => value === defaultMapFilters.dpeMax,
};
const mapPropertyUrlOptions = {
  ...stringUrlCodec,
  isDefault: (value: string) => value === "",
};

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
  const storedSelectedPropertyId = useWorkspaceStore((state) => state.selectedPropertyId);
  const setSelectedPropertyId = useWorkspaceStore((state) => state.setSelectedPropertyId);
  const toggleShortlist = useWorkspaceStore((state) => state.toggleShortlist);
  const shortlisted = useWorkspaceStore((state) => state.shortlistedPropertyIds);
  const theme = useWorkspaceStore((state) => state.theme);
  const accent = useWorkspaceStore((state) => state.accent);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [providers, setProviders] = useUrlState("mprov", defaultMapFilters.providers, mapProviderUrlOptions);
  const [propertyTypes, setPropertyTypes] = useUrlState(
    "mtype",
    defaultMapFilters.propertyTypes,
    mapPropertyTypeUrlOptions,
  );
  const [priceMax, setPriceMax] = useUrlState("mmax", defaultMapFilters.priceMax, mapPriceUrlOptions);
  const [surfaceMin, setSurfaceMin] = useUrlState("msurf", defaultMapFilters.surfaceMin, mapSurfaceUrlOptions);
  const [dpeMax, setDpeMax] = useUrlState("mdpe", defaultMapFilters.dpeMax, mapDpeUrlOptions);
  const [urlSelectedPropertyId, setUrlSelectedPropertyId] = useUrlState(
    "pid",
    storedSelectedPropertyId,
    mapPropertyUrlOptions,
  );
  const filters = useMemo<PropertyFilters>(
    () => ({
      providers,
      propertyTypes,
      priceMin: defaultMapFilters.priceMin,
      priceMax,
      surfaceMin,
      dpeMax,
    }),
    [dpeMax, priceMax, propertyTypes, providers, surfaceMin],
  );
  const debouncedFilters = useDebouncedValue(filters, 250);
  const {
    data: properties = [],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useProperties(debouncedFilters);
  const latestPropertiesRef = useRef<PropertyListing[]>(properties);
  const selectedProperty =
    properties.find((property) => property.id === urlSelectedPropertyId) ?? properties[0];
  const isFilterUpdatePending = debouncedFilters !== filters || isFetching;

  useEffect(() => {
    latestPropertiesRef.current = properties;
  }, [properties]);

  useEffect(() => {
    if (!selectedProperty || isFilterUpdatePending) return;
    if (storedSelectedPropertyId !== selectedProperty.id) {
      setSelectedPropertyId(selectedProperty.id);
    }
    if (urlSelectedPropertyId !== selectedProperty.id) {
      setUrlSelectedPropertyId(selectedProperty.id);
    }
  }, [
    isFilterUpdatePending,
    selectedProperty,
    setSelectedPropertyId,
    setUrlSelectedPropertyId,
    storedSelectedPropertyId,
    urlSelectedPropertyId,
  ]);

  const summary = useMemo(() => {
    const averageScore = properties.reduce((total, property) => total + property.scores.overall, 0) / Math.max(properties.length, 1);
    return { count: properties.length, averageScore };
  }, [properties]);
  const mapUiLocale = useMemo(() => ({
    "Map.Title": t("map.control.title"),
    "NavigationControl.ZoomIn": t("map.control.zoomIn"),
    "NavigationControl.ZoomOut": t("map.control.zoomOut"),
    "AttributionControl.ToggleAttribution": t("map.control.toggleAttribution"),
  }), [t]);
  const selectProperty = useCallback(
    (propertyId: string, centerMap = true) => {
      const property = latestPropertiesRef.current.find((item) => item.id === propertyId);
      setSelectedPropertyId(propertyId);
      setUrlSelectedPropertyId(propertyId);
      if (centerMap && property) {
        const map = mapRef.current;
        if (!map) return;
        const camera = {
          center: [property.coordinates.lng, property.coordinates.lat] as [number, number],
          zoom: Math.max(map.getZoom(), 11),
        };
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        if (reduceMotion) map.jumpTo(camera);
        else map.easeTo(camera);
      }
    },
    [setSelectedPropertyId, setUrlSelectedPropertyId],
  );

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
      const mapPalette = getMapPalette();

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
        attributionControl: { compact: true },
        locale: mapUiLocale,
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
              rgba(mapPalette.low, 0),
              3,
              rgba(mapPalette.low, 0.3),
              5,
              rgba(mapPalette.mid, 0.36),
              7,
              rgba(mapPalette.warning, 0.42),
              9,
              rgba(mapPalette.high, 0.5),
            ],
            "fill-opacity": 0.82,
          },
        });
        map.addLayer({
          id: "regions-outline",
          type: "line",
          source: "regions",
          paint: {
            "line-color": rgba(mapPalette.accent, 0.28),
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
            "circle-color": rgb(mapPalette.accent),
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
            "circle-color": [
              "interpolate",
              ["linear"],
              ["get", "score"],
              5,
              rgb(mapPalette.low),
              6.5,
              rgb(mapPalette.mid),
              7.5,
              rgb(mapPalette.warning),
              8.5,
              rgb(mapPalette.high),
            ],
            "circle-stroke-color": rgb(mapPalette.surface),
            "circle-stroke-width": 1.5,
          },
        });

        map.on("click", "properties-point", (event) => {
          const id = event.features?.[0]?.properties?.id as string | undefined;
          if (id) {
            selectProperty(id, false);
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
  }, [accent, mapUiLocale, selectProperty, theme]);

  useEffect(() => {
    const source = mapRef.current?.getSource("properties") as GeoJSONSource | undefined;
    source?.setData(propertiesToGeoJson(properties));
  }, [properties]);

  const toggleProvider = (provider: ProviderName) => {
    setProviders((current) =>
      current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider],
    );
  };

  const togglePropertyType = (propertyType: PropertyType) => {
    setPropertyTypes((current) =>
      current.includes(propertyType)
        ? current.filter((item) => item !== propertyType)
        : [...current, propertyType],
    );
  };

  const resetFilters = () => {
    setProviders(defaultMapFilters.providers);
    setPropertyTypes(defaultMapFilters.propertyTypes);
    setPriceMax(defaultMapFilters.priceMax);
    setSurfaceMin(defaultMapFilters.surfaceMin);
    setDpeMax(defaultMapFilters.dpeMax);
  };

  return (
    <section className={styles.view} aria-labelledby="map-view-title">
      <aside className={styles.filterPanel} aria-label={t("map.filtersAria")}>
        <div className={styles.panelSection}>
          <div className={styles.sectionHeader}>
            <div>
              <SectionLabel>{t("map.searchActive")}</SectionLabel>
              <h1 id="map-view-title" className={styles.panelTitle}>{t("map.title")}</h1>
            </div>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              {t("map.reset")}
            </Button>
          </div>
          <div className={styles.chipGroup} role="group" aria-label={t("map.filterProviders")}>
            {providerOptions.map((provider) => (
              <Chip key={provider} active={providers.includes(provider)} onClick={() => toggleProvider(provider)}>
                {provider}
              </Chip>
            ))}
          </div>
          <div className={styles.chipGroup} role="group" aria-label={t("map.filterTypes")}>
            {propertyTypeOptions.map((propertyType) => (
              <Chip
                key={propertyType}
                active={propertyTypes.includes(propertyType)}
                onClick={() => togglePropertyType(propertyType)}
              >
                {t(`property.type.${propertyType}`)}
              </Chip>
            ))}
          </div>
          <div className={styles.chipWrap}>
            <Chip>
              {formatPrice(filters.priceMin, locale)}–{formatPrice(filters.priceMax, locale)}
            </Chip>
          </div>
        </div>

        <div className={styles.panelSection}>
          <SectionLabel>{t("map.maxPrice")}</SectionLabel>
          <input
            className={styles.range}
            type="range"
            aria-label={t("map.maxPrice")}
            min="160000"
            max="540000"
            step="10000"
            name="map-maximum-price"
            value={priceMax}
            onChange={(event) => setPriceMax(Number(event.target.value))}
          />
          <div className={styles.rangeLegend}>
            <span>{formatPrice(160000, locale)}</span>
            <span>{formatPrice(priceMax, locale)}</span>
            <span>{formatPrice(540000, locale)}</span>
          </div>

          <SectionLabel>{t("map.minSurface")}</SectionLabel>
          <input
            className={styles.range}
            type="range"
            aria-label={t("map.minSurface")}
            min="40"
            max="140"
            step="5"
            name="map-minimum-surface"
            value={surfaceMin}
            onChange={(event) => setSurfaceMin(Number(event.target.value))}
          />
          <div className={styles.rangeLegend}>
            <span>{formatInteger(40, locale)}</span>
            <span>{formatInteger(surfaceMin, locale)}&nbsp;m²</span>
            <span>{formatInteger(140, locale)}+</span>
          </div>

          <fieldset className={styles.gradeFieldset}>
            <legend><SectionLabel>{t("map.acceptedDpe")}</SectionLabel></legend>
            <div className={styles.gradeRow}>
            {dpeGrades.map((grade) => (
              <label key={grade} className={[styles.grade, grade === dpeMax ? styles.gradeActive : ""].join(" ")}>
                <input
                  type="radio"
                  name="map-maximum-dpe"
                  value={grade}
                  checked={grade === dpeMax}
                  onChange={() => setDpeMax(grade)}
                />
                <span>{grade}</span>
              </label>
            ))}
            </div>
          </fieldset>
        </div>

        <div className={styles.panelSection}>
          <label className={styles.resultPicker}>
            <SectionLabel>{t("map.results")}</SectionLabel>
            <Select
              value={selectedProperty?.id ?? ""}
              onChange={(event) => selectProperty(event.target.value)}
              disabled={properties.length === 0 || Boolean(error)}
              aria-label={t("map.resultPicker")}
            >
              {properties.length === 0 && <option value="">{t(isLoading ? "map.loading" : "map.emptySelection")}</option>}
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {getPropertyTitle(property, locale)} · {property.locality}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </aside>

      <div className={styles.mapStage} aria-busy={isFilterUpdatePending}>
        <div ref={mapEl} className={styles.mapCanvas} role="region" aria-label={t("map.canvasAria")} />

        <div
          className={[
            styles.mapNotice,
            error ? styles.mapNoticeError : isFilterUpdatePending ? styles.mapNoticePending : summary.count === 0 ? styles.mapNoticeEmpty : "",
          ].join(" ")}
          role="status"
          aria-live="polite"
        >
          {!error && !isFilterUpdatePending && summary.count > 0 && <span className={styles.goodDot} aria-hidden="true" />}
          <span>
            {error
              ? t("map.errorProperties")
              : isFilterUpdatePending
              ? t("map.refreshing")
              : summary.count > 0
                ? t("map.summary", { count: summary.count, score: formatDecimal(summary.averageScore, locale) })
                : t("map.emptySelection")}
          </span>
        </div>

        {isLoading && properties.length === 0 && (
          <EmptyState className={styles.statusOverlay} role="status">{t("map.loading")}</EmptyState>
        )}
        {error && (
          <EmptyState className={styles.statusOverlay} role="alert">
            <div className={styles.stateContent}>
              <strong>{t("map.errorProperties")}</strong>
              <Button onClick={() => void refetch()}>{t("common.retry")}</Button>
            </div>
          </EmptyState>
        )}
        {!error && !isFilterUpdatePending && properties.length === 0 && (
          <EmptyState className={styles.statusOverlay}>
            <div className={styles.stateContent}>
              <strong>{t("map.emptySelection")}</strong>
              <Button onClick={resetFilters}>{t("common.reset")}</Button>
            </div>
          </EmptyState>
        )}

        <div className={styles.legend}>
          <div className={styles.sectionHeader}>
            <SectionLabel>{t(scoreMessageIds.overall)}</SectionLabel>
            <span>0–10</span>
          </div>
          <div className={styles.gradientBar} />
          <div className={styles.legendLabels}>
            <span>{t("map.legend.low")}</span>
            <span>{t("map.legend.high")}</span>
          </div>
          <div className={styles.legendMeta}>{t("map.legendMeta")}</div>
        </div>
      </div>

      <aside className={styles.detailPanel} aria-label={t("map.detailAria")} aria-busy={isFilterUpdatePending}>
        {isLoading && !selectedProperty && <EmptyState role="status">{t("map.loading")}</EmptyState>}
        {!error && !isLoading && !selectedProperty && <EmptyState>{t("map.emptySelection")}</EmptyState>}
        {!error && selectedProperty && (
          <>
            <PropertyVisual property={selectedProperty} size="lg" />
            <div className={styles.detailBody}>
              <div className={styles.detailTop}>
                <div>
                  <strong className={styles.price}>{formatPrice(selectedProperty.price, locale)}</strong>
                  <h2>{getPropertyTitle(selectedProperty, locale)}</h2>
                  <p>{selectedProperty.address}</p>
                </div>
                <ScoreBadge
                  value={selectedProperty.scores.overall}
                  displayValue={formatDecimal(selectedProperty.scores.overall, locale)}
                  label={t("score.valueAria", {
                    name: t("score.overall"),
                    value: formatDecimal(selectedProperty.scores.overall, locale),
                  })}
                />
              </div>

              <div className={styles.metaRow}>
                <span>{formatInteger(selectedProperty.surfaceM2, locale)}&nbsp;m²</span>
                <span>{formatRooms(selectedProperty.rooms, locale)}</span>
                <span>{formatPricePerM2(selectedProperty.price, selectedProperty.surfaceM2, locale)}</span>
                <span>{t("property.dpe")} {selectedProperty.dpe}</span>
              </div>

              <div className={styles.scoreStack}>
                <div className={styles.sectionHeader}>
                  <SectionLabel>{t("map.scoring")}</SectionLabel>
                  <span>{t("map.scoringRecipe")}</span>
                </div>
                {detailScoreKeys.map((key) => {
                  const value = key === "overall" ? selectedProperty.scores.overall : selectedProperty.scores[key];
                  return (
                  <div key={key} className={styles.scoreRow}>
                    <div>
                      <span>{t(scoreMessageIds[key])}</span>
                      <b>{formatDecimal(value, locale)}</b>
                    </div>
                    <Meter value={value} />
                  </div>
                  );
                })}
              </div>

              <div className={styles.explain}>
                <SectionLabel>{t("map.why")}</SectionLabel>
                <p>{t("map.whyCoast", {
                  score: formatDecimal(selectedProperty.scores.coast, locale),
                  distance: formatDistanceKm(selectedProperty.diagnostics.coastalDistanceKm, locale),
                })}</p>
                <p>{t("map.whyTransit", { minutes: formatInteger(selectedProperty.diagnostics.transitMinutes, locale) })}</p>
                <p>{t("map.whyNoise", { db: formatInteger(selectedProperty.diagnostics.noiseDbNight, locale) })}</p>
              </div>

              <div className={styles.actions}>
                <Button className={styles.actionButton} onClick={() => toggleShortlist(selectedProperty.id)}>
                  {shortlisted.includes(selectedProperty.id) ? t("properties.shortlisted") : t("properties.shortlist")}
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

function sameMembers<T extends string>(left: T[], right: T[]) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function boundedNumberUrlOptions(min: number, max: number, defaultValue: number) {
  return {
    parse: (value: string | null) => {
      const parsed = numberUrlCodec.parse(value);
      return parsed === undefined ? undefined : Math.min(max, Math.max(min, parsed));
    },
    serialize: numberUrlCodec.serialize,
    isDefault: (value: number) => value === defaultValue,
  };
}

function useDebouncedValue<T>(value: T, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debouncedValue;
}

type RgbColor = readonly [red: number, green: number, blue: number];

function getMapPalette() {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);

  const readToken = (token: string): RgbColor => {
    if (!context) return [0, 0, 0];
    probe.style.color = `var(${token})`;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = window.getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue];
  };

  const palette = {
    low: readToken("--score-low"),
    mid: readToken("--score-mid"),
    warning: readToken("--color-warning"),
    high: readToken("--score-high"),
    accent: readToken("--cta"),
    surface: readToken("--color-surface"),
  };
  probe.remove();
  return palette;
}

function rgb([red, green, blue]: RgbColor) {
  return `rgb(${red} ${green} ${blue})`;
}

function rgba([red, green, blue]: RgbColor, alpha: number) {
  return `rgba(${red} ${green} ${blue} / ${alpha})`;
}
