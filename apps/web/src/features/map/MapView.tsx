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
  propertiesWithinBounds,
  summarizeMapCoverage,
  type MapBounds,
} from "../../utils/mapData";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./MapView.module.css";

const emptyListings: PropertyListing[] = [];

export function MapView() {
  const { locale, t } = useAppIntl();
  const listingsQuery = useListings({ limit: 100 });
  const listings = listingsQuery.data?.items ?? emptyListings;
  const [activeSource, setActiveSource] = useState("all");
  const [activeType, setActiveType] = useState("all");
  const [selectedKey, setSelectedKey] = useUrlState("pid", "", stringUrlCodec);
  const [viewportBounds, setViewportBounds] = useState<MapBounds | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerConstructorRef = useRef<typeof import("maplibre-gl").Marker | null>(null);
  const selectedMarkerRef = useRef<MapLibreMarker | null>(null);
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
  const mapped = coverage.mapped;
  const visibleMapped = useMemo(
    () => viewportBounds ? propertiesWithinBounds(mapped, viewportBounds) : mapped,
    [mapped, viewportBounds],
  );
  const selectedSummary = selectedKey
    ? mapped.find((listing) => listing.key === selectedKey)
    : undefined;
  const detailQuery = useListing(selectedSummary?.source, selectedSummary?.externalId);
  const selected = detailQuery.data ?? selectedSummary;

  useEffect(() => {
    listingsRef.current = mapped;
  }, [mapped]);

  useEffect(() => {
    if (listingsQuery.isSuccess && selectedKey && !selectedSummary) setSelectedKey("");
  }, [listingsQuery.isSuccess, selectedKey, selectedSummary, setSelectedKey]);

  const syncViewportBounds = useCallback((map: MapLibreMap) => {
    const bounds = map.getBounds();
    setViewportBounds({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
  }, []);

  const selectListing = useCallback((key: string, center = true) => {
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

  useEffect(() => {
    let disposed = false;
    setMapReady(false);

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
        center: [-2.45, 48.2],
        zoom: 7.2,
        attributionControl: { compact: true },
        locale: {
          "NavigationControl.ZoomIn": t("map.control.zoomIn"),
          "NavigationControl.ZoomOut": t("map.control.zoomOut"),
          "AttributionControl.ToggleAttribution": t("map.control.toggleAttribution"),
        },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;
      markerConstructorRef.current = maplibregl.Marker;
      syncViewportBounds(map);
      map.on("moveend", () => syncViewportBounds(map));
      map.on("load", () => {
        if (disposed) return;
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
        setMapReady(true);
      });
    }

    void initialiseMap();
    return () => {
      disposed = true;
      selectedMarkerRef.current?.remove();
      selectedMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      markerConstructorRef.current = null;
    };
  }, [selectListing, syncViewportBounds, t]);

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
        <div ref={mapEl} className={styles.mapCanvas} role="region" aria-label={t("map.canvasAria")} />
        <div className={styles.mapNotice} role="status" aria-live="polite">
          {listingsQuery.error
            ? t("map.errorProperties")
            : listingsQuery.isFetching
              ? t("map.refreshing")
              : t("map.visibleResults", { count: visibleMapped.length })}
        </div>
        {listingsQuery.isLoading && (
          <EmptyState className={styles.statusOverlay} role="status">{t("map.loading")}</EmptyState>
        )}
        {listingsQuery.error && (
          <EmptyState className={styles.statusOverlay} role="alert">
            <div className={styles.stateContent}>
              <strong>{t("map.errorProperties")}</strong>
              <Button onClick={() => void listingsQuery.refetch()}>{t("common.retry")}</Button>
            </div>
          </EmptyState>
        )}
        {!listingsQuery.error && !listingsQuery.isLoading && mapped.length === 0 && (
          <EmptyState className={styles.statusOverlay}>{t("map.noCoordinatesWithProvenance")}</EmptyState>
        )}
        <div className={styles.legend}>
          <SectionLabel>{t("map.legendDecision")}</SectionLabel>
          <div className={styles.decisionLegend}>
            <Chip tone="good">{t("decision.relevant")}</Chip>
            <Chip tone="sunset">{t("decision.review")}</Chip>
            <Chip tone="danger">{t("decision.not-relevant")}</Chip>
          </div>
          <SectionLabel>{t("map.legendPosition")}</SectionLabel>
          <div className={styles.decisionLegend}>
            <Chip>{t("map.positionProperty")}</Chip>
            <Chip tone="sunset">{t("map.positionApproximate")}</Chip>
          </div>
        </div>
      </div>

      {selected && (
        <aside
          className={styles.detailPanel}
          aria-label={t("map.detailAria")}
          aria-busy={detailQuery.isFetching}
        >
          <MapListingDetail listing={selected} onClose={clearSelection} />
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
}

function MapListingDetail({ listing, onClose }: MapListingDetailProps) {
  const { locale, t } = useAppIntl();
  const coordinates = listing.coordinates;
  const evaluation = listing.evaluation;
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
        <PropertyVisual property={listing} size="lg" />
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
