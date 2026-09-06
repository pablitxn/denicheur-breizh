import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Button, Chip, EmptyState, SectionLabel, Select } from "@denicheur-breizh/design-system";
import { ExternalLink, MapPin, X } from "lucide-react";
import { useListing, useListings } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { useAppIntl } from "../../intl/IntlContext";
import type { LocaleCode } from "../../intl/locales";
import type { ListingDecision, PropertyListing } from "../../types";
import { formatDecimal, formatInteger, formatPrice, formatRooms } from "../../utils/format";
import {
  propertiesToGeoJson,
  propertiesWithinAdministrativeArea,
  propertiesWithinBounds,
  summarizeMapCoverage,
  type MapBounds,
} from "../../utils/mapData";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import {
  BRETAGNE,
  BRETAGNE_CAMERA,
  FINISTERE,
  INTEREST_PLACES,
  MAP_CONTEXT_LAYER_IDS,
  MAP_CONTEXT_PALETTE,
  MAP_CONTEXT_STYLE,
  QUIMPER,
  createOutsideBretagneMask,
  nearestInterestPlaces,
  type InterestPlace,
} from "./mapGeography";
import styles from "./MapView.module.css";

const emptyListings: PropertyListing[] = [];

export function MapView() {
  const { locale, t } = useAppIntl();
  const listingsQuery = useListings({ limit: 100 });
  const listings = listingsQuery.data?.items ?? emptyListings;
  const [activeSource, setActiveSource] = useUrlState("msource", "all", stringUrlCodec);
  const [activeType, setActiveType] = useUrlState("mtype", "all", stringUrlCodec);
  const [selectedKey, setSelectedKey] = useUrlState("pid", "", stringUrlCodec);
  const [selectedInterestId, setSelectedInterestId] = useState<string | null>(null);
  const [viewportBounds, setViewportBounds] = useState<MapBounds | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerConstructorRef = useRef<typeof import("maplibre-gl").Marker | null>(null);
  const selectedMarkerRef = useRef<MapLibreMarker | null>(null);
  const interestMarkersRef = useRef<MapLibreMarker[]>([]);
  const listingsRef = useRef<PropertyListing[]>(emptyListings);

  const sources = useMemo(
    () => Array.from(new Set(listings.map((listing) => listing.source))).sort(),
    [listings],
  );
  const propertyTypes = useMemo(
    () => Array.from(new Set(
      listings
        .map((listing) => listing.propertyType)
        .filter((value): value is string => Boolean(value)),
    )).sort(),
    [listings],
  );
  const filtered = useMemo(
    () => listings.filter((listing) =>
      (activeSource === "all" || listing.source === activeSource)
      && (activeType === "all" || listing.propertyType === activeType)),
    [activeSource, activeType, listings],
  );
  const coverage = useMemo(() => summarizeMapCoverage(filtered), [filtered]);
  const mapped = useMemo(
    () => propertiesWithinAdministrativeArea(coverage.mapped, BRETAGNE),
    [coverage.mapped],
  );
  const outsideBretagneCount = coverage.mapped.length - mapped.length;
  const visibleMapped = useMemo(
    () => viewportBounds ? propertiesWithinBounds(mapped, viewportBounds) : mapped,
    [mapped, viewportBounds],
  );
  const selectedSummary = selectedKey
    ? mapped.find((listing) => listing.key === selectedKey)
    : undefined;
  const detailQuery = useListing(selectedSummary?.source, selectedSummary?.externalId);
  const selected = detailQuery.data ?? selectedSummary;
  const selectedInterest = selectedInterestId
    ? INTEREST_PLACES.find((place) => place.id === selectedInterestId)
    : undefined;

  useEffect(() => {
    listingsRef.current = mapped;
  }, [mapped]);

  useEffect(() => {
    if (listingsQuery.isSuccess && selectedKey && !selectedSummary) setSelectedKey("");
  }, [listingsQuery.isSuccess, selectedKey, selectedSummary, setSelectedKey]);

  const syncViewportBounds = useCallback((map: MapLibreMap) => {
    const bounds = map.getBounds();
    const center = map.getCenter();
    if (mapEl.current) {
      mapEl.current.dataset.mapZoom = map.getZoom().toFixed(3);
      mapEl.current.dataset.mapCenterLongitude = center.lng.toFixed(6);
      mapEl.current.dataset.mapCenterLatitude = center.lat.toFixed(6);
    }
    setViewportBounds({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
  }, []);

  const selectListing = useCallback((key: string, center = true) => {
    setSelectedInterestId(null);
    setSelectedKey(key);
    const listing = listingsRef.current.find((item) => item.key === key);
    if (!center || !listing?.coordinates || !mapRef.current) return;
    const camera = {
      center: [listing.coordinates.longitude, listing.coordinates.latitude] as [number, number],
      zoom: Math.max(mapRef.current.getZoom(), 11),
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) mapRef.current.jumpTo(camera);
    else mapRef.current.easeTo(camera);
  }, [setSelectedKey]);

  const clearSelection = useCallback(() => setSelectedKey(""), [setSelectedKey]);
  const selectInterest = useCallback((id: string) => {
    setSelectedKey("");
    setSelectedInterestId(id);
  }, [setSelectedKey]);
  const clearInterest = useCallback(() => setSelectedInterestId(null), []);

  useEffect(() => {
    let disposed = false;
    setMapReady(false);
    setMapFailed(false);

    async function initialiseMap() {
      if (!mapEl.current || mapRef.current) return;
      const maplibregl = await import("maplibre-gl");
      if (disposed || !mapEl.current) return;
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
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        },
        center: BRETAGNE_CAMERA.center,
        zoom: BRETAGNE_CAMERA.zoom,
        minZoom: BRETAGNE_CAMERA.minZoom,
        renderWorldCopies: BRETAGNE_CAMERA.renderWorldCopies,
        attributionControl: { compact: true },
        locale: {
          "NavigationControl.ZoomIn": t("map.control.zoomIn"),
          "NavigationControl.ZoomOut": t("map.control.zoomOut"),
          "AttributionControl.ToggleAttribution": t("map.control.toggleAttribution"),
        },
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      markerConstructorRef.current = maplibregl.Marker;
      syncViewportBounds(map);
      map.on("moveend", () => syncViewportBounds(map));
      map.on("load", () => {
        if (disposed) return;
        map.addSource("outside-bretagne", {
          type: "geojson",
          data: createOutsideBretagneMask(),
        });
        map.addSource("bretagne", {
          type: "geojson",
          data: BRETAGNE,
          attribution: "Limites administratives : data.gouv.fr / Etalab · Licence Ouverte 2.0",
        });
        map.addSource("finistere", { type: "geojson", data: FINISTERE });
        map.addSource("quimper", { type: "geojson", data: QUIMPER });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.outsideMask,
          type: "fill",
          source: "outside-bretagne",
          paint: {
            "fill-color": MAP_CONTEXT_PALETTE.outside,
            "fill-opacity": MAP_CONTEXT_STYLE.outsideOpacity,
          },
        });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.finistereFill,
          type: "fill",
          source: "finistere",
          paint: {
            "fill-color": MAP_CONTEXT_PALETTE.finistere,
            "fill-opacity": MAP_CONTEXT_STYLE.finistereFillOpacity,
          },
        });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.finistereOutline,
          type: "line",
          source: "finistere",
          paint: {
            "line-color": MAP_CONTEXT_PALETTE.finistereOutline,
            "line-opacity": MAP_CONTEXT_STYLE.finistereOutlineOpacity,
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 11, 2],
          },
        });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.quimperFill,
          type: "fill",
          source: "quimper",
          paint: {
            "fill-color": MAP_CONTEXT_PALETTE.quimper,
            "fill-opacity": MAP_CONTEXT_STYLE.quimperFillOpacity,
          },
        });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.quimperOutline,
          type: "line",
          source: "quimper",
          paint: {
            "line-color": MAP_CONTEXT_PALETTE.quimperOutline,
            "line-opacity": MAP_CONTEXT_STYLE.quimperOutlineOpacity,
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.5, 11, 3],
          },
        });
        map.addLayer({
          id: MAP_CONTEXT_LAYER_IDS.bretagneOutline,
          type: "line",
          source: "bretagne",
          paint: {
            "line-color": MAP_CONTEXT_PALETTE.bretagneOutline,
            "line-opacity": MAP_CONTEXT_STYLE.bretagneOutlineOpacity,
            "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1, 11, 2],
          },
        });
        map.addSource("properties", { type: "geojson", data: propertiesToGeoJson(listingsRef.current) });
        map.addLayer({
          id: "properties-point",
          type: "circle",
          source: "properties",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 5, 12, 9],
            "circle-color": [
              "match", ["get", "decision"],
              "relevant", "#5fbf86",
              "not-relevant", "#df6d76",
              "review", "#e5a958",
              "#8b82a8",
            ],
            "circle-opacity": ["match", ["get", "locationKind"], "source-property", 0.95, 0.58],
            "circle-stroke-color": ["match", ["get", "locationKind"], "source-property", "#ffffff", "#f3c969"],
            "circle-stroke-width": ["match", ["get", "locationKind"], "source-property", 1.5, 3],
          },
        });
        map.on("click", "properties-point", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") selectListing(id, false);
        });
        map.on("mouseenter", "properties-point", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "properties-point", () => { map.getCanvas().style.cursor = ""; });
        interestMarkersRef.current = INTEREST_PLACES.map((place) => new maplibregl.Marker({
          element: createInterestMarkerElement(place, t, selectInterest),
          anchor: "center",
        }).setLngLat([...place.coordinates]).addTo(map));
        setMapReady(true);
      });
    }

    void initialiseMap().catch(() => {
      if (!disposed) setMapFailed(true);
    });
    return () => {
      disposed = true;
      selectedMarkerRef.current?.remove();
      selectedMarkerRef.current = null;
      interestMarkersRef.current.forEach((marker) => marker.remove());
      interestMarkersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      markerConstructorRef.current = null;
    };
  }, [mapAttempt, selectInterest, selectListing, syncViewportBounds, t]);

  useEffect(() => {
    const source = mapRef.current?.getSource("properties") as GeoJSONSource | undefined;
    source?.setData(propertiesToGeoJson(mapped));
  }, [mapped]);

  useEffect(() => {
    selectedMarkerRef.current?.remove();
    selectedMarkerRef.current = null;
    const coordinates = selected?.coordinates;
    const map = mapRef.current;
    const Marker = markerConstructorRef.current;
    if (!mapReady || !coordinates || !map || !Marker || !selected) return;

    const markerElement = document.createElement("div");
    const markerTitle = selected.title ?? selected.location ?? selected.externalId;
    markerElement.className = styles.selectedMarker;
    markerElement.setAttribute("role", "img");
    markerElement.setAttribute("aria-label", t("map.selectedMarker", { title: markerTitle }));
    markerElement.dataset.listingKey = selected.key;

    const marker = new Marker({ element: markerElement, anchor: "center" })
      .setLngLat([coordinates.longitude, coordinates.latitude])
      .addTo(map);
    selectedMarkerRef.current = marker;

    return () => {
      marker.remove();
      if (selectedMarkerRef.current === marker) selectedMarkerRef.current = null;
    };
  }, [mapReady, selected, t]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const map = mapRef.current;
      if (!map) return;
      map.resize();
      if (!map.isMoving()) syncViewportBounds(map);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedKey, syncViewportBounds]);

  return (
    <section
      className={[styles.view, selected ? styles.viewWithDetail : ""].join(" ")}
      aria-labelledby="map-view-title"
    >
      <aside className={styles.filterPanel} aria-label={t("map.filtersAria")}>
        <div className={styles.panelSection}>
          <div className={styles.sectionHeader}>
            <div>
              <SectionLabel>{t("map.withProvenance")}</SectionLabel>
              <h1 id="map-view-title" className={styles.panelTitle}>{t("map.title")}</h1>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActiveSource("all");
                setActiveType("all");
              }}
            >
              {t("map.reset")}
            </Button>
          </div>
          <label className={styles.resultPicker}>
            <SectionLabel>{t("common.source")}</SectionLabel>
            <Select value={activeSource} onChange={(event) => setActiveSource(event.target.value)}>
              <option value="all">{t("scorings.all")}</option>
              {sources.map((source) => <option key={source} value={source}>{source}</option>)}
            </Select>
          </label>
          <label className={styles.resultPicker}>
            <SectionLabel>{t("map.propertyType")}</SectionLabel>
            <Select value={activeType} onChange={(event) => setActiveType(event.target.value)}>
              <option value="all">{t("scorings.all")}</option>
              {propertyTypes.map((propertyType) => (
                <option key={propertyType} value={propertyType}>{propertyType}</option>
              ))}
            </Select>
          </label>
          {coverage.unmappedCount > 0 && (
            <p className={styles.unmappedNotice}>
              {t("map.unmappedCount", { count: coverage.unmappedCount })}
            </p>
          )}
          {outsideBretagneCount > 0 && (
            <p className={styles.unmappedNotice}>
              {t("map.outsideBretagneCount", { count: outsideBretagneCount })}
            </p>
          )}
        </div>

        <div className={[styles.panelSection, styles.mapKeySection].join(" ")}>
          <div>
            <SectionLabel>{t("map.legendTerritory")}</SectionLabel>
            <p className={styles.scopeNote}>{t("map.bretagneScope")}</p>
            <div className={[styles.contextLegend, styles.contextLegendThree].join(" ")}>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.outsideSwatch].join(" ")} aria-hidden="true" />
                {t("map.outsideBretagne")}
              </span>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.finistereSwatch].join(" ")} aria-hidden="true" />
                {t("map.finistere")}
              </span>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.quimperSwatch].join(" ")} aria-hidden="true" />
                {t("map.quimper")}
              </span>
            </div>
          </div>
          <div>
            <SectionLabel>{t("map.interests")}</SectionLabel>
            <div className={styles.contextLegend}>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.naturalSwatch].join(" ")} aria-hidden="true" />
                {t("map.interest.category.natural")}
              </span>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.heritageSwatch].join(" ")} aria-hidden="true" />
                {t("map.interest.category.heritage")}
              </span>
            </div>
          </div>
          <div>
            <SectionLabel>{t("map.legendDecision")}</SectionLabel>
            <div className={[styles.contextLegend, styles.contextLegendThree].join(" ")}>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.naturalSwatch].join(" ")} aria-hidden="true" />
                {t("decision.relevant")}
              </span>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.heritageSwatch].join(" ")} aria-hidden="true" />
                {t("decision.review")}
              </span>
              <span className={styles.legendItem}>
                <i className={[styles.legendSwatch, styles.dangerSwatch].join(" ")} aria-hidden="true" />
                {t("decision.not-relevant")}
              </span>
            </div>
          </div>
        </div>

        <div className={[styles.panelSection, styles.resultsSection].join(" ")}>
          <div className={styles.resultsHeader}>
            <SectionLabel>{t("map.results")}</SectionLabel>
            <span aria-live="polite">{t("map.visibleResults", { count: visibleMapped.length })}</span>
          </div>
          <p className={styles.resultsHint}>{t("map.resultsHint")}</p>
          <MapResultsList
            listings={visibleMapped}
            selectedKey={selected?.key}
            locale={locale}
            onSelect={selectListing}
          />
        </div>
      </aside>

      <div className={styles.mapStage}>
        <div key={`${locale}-${mapAttempt}`} ref={mapEl} className={styles.mapCanvas} role="region" aria-label={t("map.canvasAria")} aria-busy={!mapReady && !mapFailed} />
        <div className={styles.mapNotice} role="status" aria-live="polite">
          {listingsQuery.error
            ? t("map.errorProperties")
            : listingsQuery.isFetching
              ? t("map.refreshing")
              : t("map.visibleResults", { count: visibleMapped.length })}
        </div>
        {selectedInterest && (
          <aside className={styles.interestDetail} aria-label={t("map.interest.detailAria")}>
            <div className={styles.interestDetailHeader}>
              <div>
                <SectionLabel>{t("map.interests")}</SectionLabel>
                <h2>{selectedInterest.name}</h2>
              </div>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={clearInterest}
                aria-label={t("map.interest.close")}
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </div>
            <Chip tone={selectedInterest.category === "natural" ? "good" : "sunset"}>
              {t(`map.interest.category.${selectedInterest.category}`)}
            </Chip>
            <p>{t(selectedInterest.descriptionId)}</p>
            <p className={styles.interestProvenance}>
              {t("map.interest.representativePoint")} · {selectedInterest.sourceUpdatedAt
                ? t("map.interest.sourceUpdated", {
                    date: formatDateOnly(selectedInterest.sourceUpdatedAt, locale),
                  })
                : t("map.interest.sourceChecked", {
                    date: formatDateOnly(selectedInterest.sourceCheckedAt, locale),
                  })}
            </p>
            <div className={styles.interestSources}>
              <a
                className={styles.interestSource}
                href={selectedInterest.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t("map.interest.openSource", { source: selectedInterest.sourceLabel })}
                <ExternalLink size={14} aria-hidden="true" />
              </a>
              {selectedInterest.coordinateSource && (
                <a
                  className={styles.interestSource}
                  href={selectedInterest.coordinateSource.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("map.interest.openCoordinateSource", {
                    source: selectedInterest.coordinateSource.label,
                  })}
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              )}
            </div>
          </aside>
        )}
        {mapFailed && (
          <EmptyState className={styles.statusOverlay} role="alert">
            <div className={styles.stateContent}>
              <strong>{t("map.errorMap")}</strong>
              <Button onClick={() => setMapAttempt((attempt) => attempt + 1)}>{t("common.retry")}</Button>
            </div>
          </EmptyState>
        )}
        {!mapFailed && (listingsQuery.isLoading || !mapReady) && !listingsQuery.error && (
          <EmptyState className={styles.statusOverlay} role="status">{t("map.loading")}</EmptyState>
        )}
        {listingsQuery.error && !mapFailed && (
          <EmptyState className={styles.statusOverlay} role="alert">
            <div className={styles.stateContent}>
              <strong>{t("map.errorProperties")}</strong>
              <Button onClick={() => void listingsQuery.refetch()}>{t("common.retry")}</Button>
            </div>
          </EmptyState>
        )}
      </div>

      {selected && (
        <aside
          className={styles.detailPanel}
          aria-label={t("map.detailAria")}
          aria-busy={detailQuery.isFetching}
        >
          <MapListingDetail
            listing={selected}
            onClose={clearSelection}
            onSelectInterest={selectInterest}
          />
        </aside>
      )}
    </section>
  );
}

interface MapResultsListProps {
  listings: PropertyListing[];
  selectedKey?: string;
  locale: LocaleCode;
  onSelect: (key: string) => void;
}

function MapResultsList({ listings, selectedKey, locale, onSelect }: MapResultsListProps) {
  const { t } = useAppIntl();

  return (
    <>
      <ul className={styles.resultsList} aria-label={t("map.results")}>
        {listings.map((listing) => {
          const title = listing.title ?? listing.externalId;
          const active = listing.key === selectedKey;
          return (
            <li key={listing.key} className={styles.resultItem}>
              <button
                type="button"
                className={[styles.resultButton, active ? styles.resultActive : ""].join(" ")}
                onClick={() => onSelect(listing.key)}
                aria-label={t("properties.select", { title })}
                aria-pressed={active}
              >
                <PropertyVisual property={listing} size="sm" />
                <span className={styles.resultCopy}>
                  <span className={styles.resultTitleRow}>
                    <strong>{title}</strong>
                    <span className={styles.resultPrice}>
                      {listing.priceEuros === undefined
                        ? t("common.unavailable")
                        : formatPrice(listing.priceEuros, locale)}
                    </span>
                  </span>
                  <span className={styles.resultLocation}>
                    {listing.location ?? t("common.unavailable")}
                  </span>
                  <span className={styles.resultMeta}>
                    {formatResultMeta(listing, locale, t("common.unavailable"))}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {listings.length === 0 && (
        <EmptyState className={styles.resultsEmpty}>{t("map.noVisibleResults")}</EmptyState>
      )}
    </>
  );
}

interface MapListingDetailProps {
  listing: PropertyListing;
  onClose: () => void;
  onSelectInterest: (id: string) => void;
}

function MapListingDetail({ listing, onClose, onSelectInterest }: MapListingDetailProps) {
  const { locale, t } = useAppIntl();
  const coordinates = listing.coordinates;
  const evaluation = listing.evaluation;
  const nearbyInterests = coordinates
    ? nearestInterestPlaces([coordinates.longitude, coordinates.latitude])
    : [];
  const facts = [
    listing.surfaceM2 === undefined
      ? undefined
      : { label: t("map.fact.surface"), value: `${formatInteger(listing.surfaceM2, locale)}\u00a0m²` },
    listing.rooms === undefined
      ? undefined
      : { label: t("map.fact.rooms"), value: formatInteger(listing.rooms, locale) },
    listing.bedrooms === undefined
      ? undefined
      : { label: t("map.fact.bedrooms"), value: formatInteger(listing.bedrooms, locale) },
    listing.landSurfaceM2 === undefined
      ? undefined
      : { label: t("map.fact.land"), value: `${formatInteger(listing.landSurfaceM2, locale)}\u00a0m²` },
    listing.energyClass
      ? { label: t("property.dpe"), value: listing.energyClass }
      : undefined,
    listing.gesClass
      ? { label: t("properties.ges"), value: listing.gesClass }
      : undefined,
  ].filter((fact): fact is { label: string; value: string } => fact !== undefined);
  const observedAt = coordinates
    ? formatOptionalDate(coordinates.verifiedAt, locale, t("common.unavailable"))
    : undefined;

  return (
    <article className={styles.detailCard}>
      <div className={styles.detailVisual}>
        <PropertyVisual key={listing.key} property={listing} size="lg" navigation />
        <Button
          className={styles.closeDetail}
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onClose}
          aria-label={t("map.closeDetail")}
        >
          <X size={18} aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.detailBody}>
        <header className={styles.detailHeading}>
          <div>
            <h2>{listing.title ?? t("common.unavailable")}</h2>
            <p><MapPin size={15} aria-hidden="true" /> {listing.location ?? t("common.unavailable")}</p>
          </div>
          <Chip><span translate="no">{listing.source}</span></Chip>
        </header>

        <strong className={styles.detailPrice}>
          {listing.priceEuros === undefined
            ? t("common.unavailable")
            : formatPrice(listing.priceEuros, locale)}
        </strong>

        {facts.length > 0 && (
          <dl className={styles.detailFacts}>
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {coordinates && (
          <section className={styles.detailSection}>
            <SectionLabel>{t("map.positionTitle")}</SectionLabel>
            <div className={styles.locationCard}>
              <MapPin size={18} aria-hidden="true" />
              <div>
                <strong>{t(`map.locationKind.${coordinates.locationKind}`)}</strong>
                <span>{t("map.coordinateObservedAt")}: {observedAt}</span>
              </div>
            </div>
          </section>
        )}

        {nearbyInterests.length > 0 && (
          <section className={styles.detailSection}>
            <SectionLabel>{t("map.nearbyInterests")}</SectionLabel>
            <p className={styles.nearbyHint}>{t("map.nearbyInterestsHint")}</p>
            <ul className={styles.nearbyList}>
              {nearbyInterests.map(({ place, distanceKm }) => (
                <li key={place.id}>
                  <button
                    type="button"
                    className={styles.nearbyButton}
                    onClick={() => onSelectInterest(place.id)}
                    aria-label={t("map.interest.select", { name: place.name })}
                  >
                    <span>
                      <i
                        className={[
                          styles.nearbyDot,
                          place.category === "natural" ? styles.naturalSwatch : styles.heritageSwatch,
                        ].join(" ")}
                        aria-hidden="true"
                      />
                      {place.name}
                    </span>
                    <strong>{t("map.interest.distanceKm", {
                      distance: formatInteger(Math.max(1, Math.round(distanceKm)), locale),
                    })}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.detailSection}>
          <SectionLabel>{t("properties.evaluation")}</SectionLabel>
          {evaluation ? (
            <>
              <div className={styles.evaluationHeader}>
                <DecisionChip decision={evaluation.decision} />
                {evaluation.score !== null && (
                  <strong>{formatDecimal(evaluation.score, locale)} / 100</strong>
                )}
              </div>
              {evaluation.summary.trim() && <p className={styles.detailText}>{evaluation.summary}</p>}
            </>
          ) : (
            <p className={styles.detailText}>{t("properties.notEvaluated")}</p>
          )}
        </section>

        {listing.description?.trim() && (
          <section className={styles.detailSection}>
            <SectionLabel>{t("properties.description")}</SectionLabel>
            <p className={[styles.detailText, styles.detailDescription].join(" ")}>
              {listing.description}
            </p>
          </section>
        )}

        {(listing.sellerName || listing.sellerType || listing.postedAt) && (
          <dl className={styles.detailMetaList}>
            {(listing.sellerName || listing.sellerType) && (
              <div>
                <dt>{t("properties.seller")}</dt>
                <dd>{listing.sellerName ?? listing.sellerType}</dd>
              </div>
            )}
            {listing.postedAt && (
              <div>
                <dt>{t("properties.column.posted")}</dt>
                <dd>{listing.postedAt}</dd>
              </div>
            )}
          </dl>
        )}

        {listing.features.length > 0 && (
          <div className={styles.featureList}>
            {listing.features.map((feature, index) => (
              <Chip key={`${feature}-${index}`}>{feature}</Chip>
            ))}
          </div>
        )}

        <a className={styles.sourceLink} href={listing.url} target="_blank" rel="noreferrer noopener">
          {t("properties.openSource")} <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </article>
  );
}

function DecisionChip({ decision }: { decision: ListingDecision }) {
  const { t } = useAppIntl();
  const tone = decision === "relevant" ? "good" : decision === "not-relevant" ? "danger" : "sunset";
  const messageId = `decision.${decision}` as Parameters<typeof t>[0];
  return <Chip active tone={tone}>{t(messageId)}</Chip>;
}

function formatResultMeta(listing: PropertyListing, locale: LocaleCode, unavailable: string): string {
  const values = [
    listing.surfaceM2 === undefined ? undefined : `${formatInteger(listing.surfaceM2, locale)}\u00a0m²`,
    listing.rooms === undefined ? undefined : formatRooms(listing.rooms, locale),
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? values.join(" · ") : unavailable;
}

function formatOptionalDate(value: string | undefined, locale: LocaleCode, unavailable: string): string {
  if (!value) return unavailable;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? unavailable
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function formatDateOnly(value: string, locale: LocaleCode): string {
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

function createInterestMarkerElement(
  place: InterestPlace,
  translate: ReturnType<typeof useAppIntl>["t"],
  onSelect: (id: string) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = [
    styles.interestMarker,
    place.category === "natural" ? styles.interestMarkerNatural : styles.interestMarkerHeritage,
  ].join(" ");
  button.dataset.interestId = place.id;
  button.setAttribute("aria-label", translate("map.interest.select", { name: place.name }));

  const dot = document.createElement("span");
  dot.className = styles.interestMarkerDot;
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = styles.interestMarkerLabel;
  label.textContent = place.name;
  label.setAttribute("aria-hidden", "true");
  button.append(dot, label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect(place.id);
  });

  return button;
}
