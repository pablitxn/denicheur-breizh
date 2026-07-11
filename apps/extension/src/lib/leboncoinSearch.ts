import type {
  LeboncoinCategory,
  LeboncoinOwnerType,
  LeboncoinSort,
  SearchFilters,
} from "./types";

export const DEFAULT_MAX_LISTINGS = 20;
export const MAX_LISTINGS_LIMIT = 20;
export const DEFAULT_MIN_DELAY_SECONDS = 25;
export const DEFAULT_MAX_DELAY_SECONDS = 55;
export const DEFAULT_PAUSE_AFTER_DETAILS = 5;
export const DEFAULT_COOLDOWN_SECONDS = 180;

export const CATEGORY_OPTIONS: Array<{ value: LeboncoinCategory; label: string }> = [
  { value: "9", label: "Vente" },
  { value: "10", label: "Location" },
  { value: "11", label: "Colocation" },
  { value: "13", label: "Bureaux" },
  { value: "2001", label: "Neuf" },
];

export const PROPERTY_TYPE_OPTIONS = [
  { value: "1", label: "Maison" },
  { value: "2", label: "Appartement" },
  { value: "3", label: "Terrain" },
  { value: "4", label: "Parking" },
  { value: "5", label: "Autre" },
];

export const OWNER_TYPE_OPTIONS: Array<{ value: LeboncoinOwnerType; label: string }> = [
  { value: "all", label: "Tous" },
  { value: "private", label: "Particulier" },
  { value: "pro", label: "Pro" },
];

export const SORT_OPTIONS: Array<{ value: LeboncoinSort; label: string }> = [
  { value: "time", label: "Recent" },
  { value: "relevance", label: "Pertinence" },
];

export function createDefaultSearchFilters(): SearchFilters {
  return {
    source: "leboncoin",
    rawSearchUrl: "",
    category: "9",
    text: "",
    locationToken: "",
    propertyTypes: ["1", "2"],
    ownerType: "all",
    priceMin: undefined,
    priceMax: undefined,
    roomsMin: undefined,
    roomsMax: undefined,
    bedroomsMin: undefined,
    bedroomsMax: undefined,
    squareMin: undefined,
    squareMax: undefined,
    sort: "time",
    order: "desc",
    maxListings: DEFAULT_MAX_LISTINGS,
    collectDetailPages: false,
    minDelaySeconds: DEFAULT_MIN_DELAY_SECONDS,
    maxDelaySeconds: DEFAULT_MAX_DELAY_SECONDS,
    pauseAfterDetails: DEFAULT_PAUSE_AFTER_DETAILS,
    cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
    closeDetailTabs: true,
  };
}

export function clampMaxListings(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_LISTINGS;
  }

  return Math.max(1, Math.min(MAX_LISTINGS_LIMIT, Math.trunc(value ?? DEFAULT_MAX_LISTINGS)));
}

export function normalizeSearchFilters(filters: SearchFilters): SearchFilters {
  const defaults = createDefaultSearchFilters();
  const minDelaySeconds = clampSeconds(filters.minDelaySeconds, 5, 300, defaults.minDelaySeconds);
  const maxDelaySeconds = Math.max(
    minDelaySeconds,
    clampSeconds(filters.maxDelaySeconds, minDelaySeconds, 600, defaults.maxDelaySeconds),
  );

  return {
    ...defaults,
    ...filters,
    maxListings: clampMaxListings(filters.maxListings),
    minDelaySeconds,
    maxDelaySeconds,
    pauseAfterDetails: clampPositiveInt(filters.pauseAfterDetails, 1, 20, defaults.pauseAfterDetails),
    cooldownSeconds: clampSeconds(filters.cooldownSeconds, 30, 1800, defaults.cooldownSeconds),
  };
}

export function buildLeboncoinSearchUrl(filters: SearchFilters): string {
  const rawSearchUrl = filters.rawSearchUrl.trim();

  if (rawSearchUrl) {
    const url = new URL(rawSearchUrl);

    if (!isLeboncoinSearchUrl(url)) {
      throw new Error("Search URL must be an HTTPS leboncoin.fr search URL.");
    }

    return url.toString();
  }

  const url = new URL("https://www.leboncoin.fr/recherche");
  url.searchParams.set("category", filters.category);
  url.searchParams.set("sort", filters.sort);
  url.searchParams.set("order", filters.order);

  appendTextParam(url, "text", filters.text);
  appendTextParam(url, "locations", filters.locationToken);
  appendListParam(url, "real_estate_type", filters.propertyTypes);
  appendRangeParam(url, "price", filters.priceMin, filters.priceMax);
  appendRangeParam(url, "rooms", filters.roomsMin, filters.roomsMax);
  appendRangeParam(url, "bedrooms", filters.bedroomsMin, filters.bedroomsMax);
  appendRangeParam(url, "square", filters.squareMin, filters.squareMax);

  if (filters.ownerType !== "all") {
    url.searchParams.set("owner_type", filters.ownerType);
  }

  return url.toString();
}

export function isLeboncoinUrl(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "leboncoin.fr" || url.hostname === "www.leboncoin.fr");
}

export function isLeboncoinSearchUrl(url: URL): boolean {
  return isLeboncoinUrl(url) && url.pathname === "/recherche";
}

function appendTextParam(url: URL, key: string, value: string) {
  const trimmed = value.trim();

  if (trimmed) {
    url.searchParams.set(key, trimmed);
  }
}

function appendListParam(url: URL, key: string, values: string[]) {
  const selected = values.map((value) => value.trim()).filter(Boolean);

  if (selected.length > 0) {
    url.searchParams.set(key, selected.join(","));
  }
}

function appendRangeParam(url: URL, key: string, min?: number, max?: number) {
  const cleanMin = cleanPositiveInt(min);
  const cleanMax = cleanPositiveInt(max);

  if (cleanMin === undefined && cleanMax === undefined) {
    return;
  }

  url.searchParams.set(key, `${cleanMin ?? "min"}-${cleanMax ?? "max"}`);
}

function cleanPositiveInt(value?: number): number | undefined {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function clampPositiveInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(value ?? fallback)));
}

function clampSeconds(value: number | undefined, min: number, max: number, fallback: number): number {
  return clampPositiveInt(value, min, max, fallback);
}
