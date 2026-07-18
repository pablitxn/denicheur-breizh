import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Button, Chip, EmptyState, SectionLabel, Select } from "@denicheur-breizh/design-system";
import { ExternalLink } from "lucide-react";
import { useListings } from "../../api/hooks";
import { PropertyVisual } from "../../components/PropertyVisual";
import { useAppIntl } from "../../intl/IntlContext";
import type { PropertyListing } from "../../types";
import { formatDecimal, formatInteger, formatPrice, formatRooms } from "../../utils/format";
import { propertiesToGeoJson, summarizeMapCoverage } from "../../utils/mapData";
import { stringUrlCodec, useUrlState } from "../../utils/useUrlState";
import styles from "./MapView.module.css";

export function MapView() {
  const { t } = useAppIntl();
  const query = useListings({ limit: 100 });
  const listings = query.data?.items ?? [];
  const [activeSource, setActiveSource] = useState("all");
  const [activeType, setActiveType] = useState("all");
  const [selectedKey, setSelectedKey] = useUrlState("pid", "", stringUrlCodec);
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const listingsRef = useRef<PropertyListing[]>([]);

  const sources = useMemo(() => Array.from(new Set(listings.map((listing) => listing.source))).sort(), [listings]);
  const propertyTypes = useMemo(() => Array.from(new Set(listings.map((listing) => listing.propertyType).filter((value): value is string => Boolean(value)))).sort(), [listings]);
  const filtered = useMemo(() => listings.filter((listing) =>
    (activeSource === "all" || listing.source === activeSource) &&
    (activeType === "all" || listing.propertyType === activeType)
  ), [activeSource, activeType, listings]);
  const coverage = useMemo(() => summarizeMapCoverage(filtered), [filtered]);
  const mapped = coverage.mapped;
  const selected = mapped.find((listing) => listing.key === selectedKey) ?? mapped[0];

  useEffect(() => { listingsRef.current = mapped; }, [mapped]);
  useEffect(() => {
    if (selected && selected.key !== selectedKey) setSelectedKey(selected.key);
    if (!selected && selectedKey) setSelectedKey("");
  }, [selected, selectedKey, setSelectedKey]);

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

  useEffect(() => {
    let disposed = false;
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
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      mapRef.current = map;
      map.on("load", () => {
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
      });
    }
    void initialiseMap();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [selectListing]);

  useEffect(() => {
    const source = mapRef.current?.getSource("properties") as GeoJSONSource | undefined;
    source?.setData(propertiesToGeoJson(mapped));
  }, [mapped]);

  return (
    <section className={styles.view} aria-labelledby="map-view-title">
      <aside className={styles.filterPanel} aria-label={t("map.filtersAria")}>
        <div className={styles.panelSection}>
          <div className={styles.sectionHeader}>
            <div><SectionLabel>{t("map.withProvenance")}</SectionLabel><h1 id="map-view-title" className={styles.panelTitle}>{t("map.title")}</h1></div>
            <Button variant="ghost" size="sm" onClick={() => { setActiveSource("all"); setActiveType("all"); }}>{t("map.reset")}</Button>
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
              {propertyTypes.map((propertyType) => <option key={propertyType} value={propertyType}>{propertyType}</option>)}
            </Select>
          </label>
        </div>
        <div className={styles.panelSection}>
          <SectionLabel>{t("map.coverage")}</SectionLabel>
          <p>{t("map.mappedCount", { mapped: mapped.length, total: filtered.length })}</p>
          <p className={styles.unmappedNotice}>{t("map.positionBreakdown", {
            property: coverage.sourcePropertyCount,
            approximate: coverage.approximateCount,
          })}</p>
          <p className={styles.unmappedNotice}>{t("map.unmappedCount", { count: coverage.unmappedCount })}</p>
        </div>
        <div className={styles.panelSection}>
          <label className={styles.resultPicker}>
            <SectionLabel>{t("map.results")}</SectionLabel>
            <Select value={selected?.key ?? ""} onChange={(event) => selectListing(event.target.value)} disabled={mapped.length === 0}>
              {mapped.length === 0 && <option value="">{t("map.emptySelection")}</option>}
              {mapped.map((listing) => <option key={listing.key} value={listing.key}>{listing.title ?? listing.externalId}</option>)}
            </Select>
          </label>
        </div>
      </aside>

      <div className={styles.mapStage}>
        <div ref={mapEl} className={styles.mapCanvas} role="region" aria-label={t("map.canvasAria")} />
        <div className={styles.mapNotice} role="status" aria-live="polite">
          {query.error ? t("map.errorProperties") : query.isFetching ? t("map.refreshing") : t("map.mappedCount", { mapped: mapped.length, total: filtered.length })}
        </div>
        {query.isLoading && <EmptyState className={styles.statusOverlay} role="status">{t("map.loading")}</EmptyState>}
        {query.error && <EmptyState className={styles.statusOverlay} role="alert"><div className={styles.stateContent}><strong>{t("map.errorProperties")}</strong><Button onClick={() => void query.refetch()}>{t("common.retry")}</Button></div></EmptyState>}
        {!query.error && !query.isLoading && mapped.length === 0 && <EmptyState className={styles.statusOverlay}>{t("map.noCoordinatesWithProvenance")}</EmptyState>}
        <div className={styles.legend}>
          <SectionLabel>{t("map.legendDecision")}</SectionLabel>
          <div className={styles.decisionLegend}><Chip tone="good">{t("decision.relevant")}</Chip><Chip tone="sunset">{t("decision.review")}</Chip><Chip tone="danger">{t("decision.not-relevant")}</Chip></div>
          <SectionLabel>{t("map.legendPosition")}</SectionLabel>
          <div className={styles.decisionLegend}><Chip>{t("map.positionProperty")}</Chip><Chip tone="sunset">{t("map.positionApproximate")}</Chip></div>
        </div>
      </div>

      <aside className={styles.detailPanel} aria-label={t("map.detailAria")}>
        {selected ? <MapListingDetail listing={selected} /> : <EmptyState>{t("map.emptySelection")}</EmptyState>}
      </aside>
    </section>
  );
}

function MapListingDetail({ listing }: { listing: PropertyListing }) {
  const { locale, t } = useAppIntl();
  const coordinates = listing.coordinates;
  return (
    <div className={styles.detailCard}>
      <PropertyVisual property={listing} size="lg" />
      <div className={styles.detailBody}>
        <div className={styles.detailHeading}><div><h2>{listing.title ?? t("common.unavailable")}</h2><p>{listing.location ?? t("common.unavailable")}</p></div><Chip>{listing.source}</Chip></div>
        <strong className={styles.detailPrice}>{listing.priceEuros === undefined ? t("common.unavailable") : formatPrice(listing.priceEuros, locale)}</strong>
        <div className={styles.detailFacts}>
          <span>{listing.surfaceM2 === undefined ? t("common.unavailable") : `${formatInteger(listing.surfaceM2, locale)} m²`}</span>
          <span>{listing.rooms === undefined ? t("common.unavailable") : formatRooms(listing.rooms, locale)}</span>
          <span>{listing.evaluation?.score === null || listing.evaluation?.score === undefined ? t("properties.notEvaluated") : `${formatDecimal(listing.evaluation.score, locale)} / 100`}</span>
        </div>
        {coordinates && (
          <div>
            <SectionLabel>{t("map.positionTitle")}</SectionLabel>
            <p><strong>{t(`map.locationKind.${coordinates.locationKind}`)}</strong></p>
            <p className={styles.unmappedNotice}>{t("map.coordinateProvenance")}: {coordinates.provenance}</p>
            <p className={styles.unmappedNotice}>{t("map.coordinateObservedAt")}: {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(coordinates.verifiedAt))}</p>
          </div>
        )}
        <a className={styles.sourceLink} href={listing.url} target="_blank" rel="noreferrer noopener">{t("properties.openSource")} <ExternalLink size={14} /></a>
      </div>
    </div>
  );
}
