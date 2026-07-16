import type {
  LeboncoinCategory,
  LeboncoinOrder,
  LeboncoinOwnerType,
  LeboncoinSort,
  SearchFilters,
} from "./types";

export const DEFAULT_MAX_LISTINGS = 20;
export const MAX_LISTINGS_LIMIT = 100;
export const MAX_LISTINGS_PER_PAGE = 100;
export const DEFAULT_MIN_DELAY_SECONDS = 25;
export const DEFAULT_MAX_DELAY_SECONDS = 55;
export const DEFAULT_PAUSE_AFTER_DETAILS = 5;
export const DEFAULT_COOLDOWN_SECONDS = 180;

export const SEARCH_FILTER_LIMITS = {
  maxListings: { min: 1, max: MAX_LISTINGS_LIMIT },
  minDelaySeconds: { min: 5, max: 300 },
  maxDelaySeconds: { min: 5, max: 600 },
  pauseAfterDetails: { min: 1, max: 20 },
  cooldownSeconds: { min: 30, max: 1800 },
} as const;

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

type SearchFilterInput = { [Key in keyof SearchFilters]?: unknown };

export interface FilterValidationIssue {
  field: keyof SearchFilters;
  message: string;
}

export function createDefaultSearchFilters(): SearchFilters {
  return {
    source: "leboncoin",
    category: "9",
    text: "",
    locationQuery: "",
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
  };
}

export function clampMaxListings(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_LISTINGS;
  }

  return Math.max(
    SEARCH_FILTER_LIMITS.maxListings.min,
    Math.min(MAX_LISTINGS_LIMIT, Math.trunc(value ?? DEFAULT_MAX_LISTINGS)),
  );
}

export function normalizeSearchFilters(filters: SearchFilterInput = {}): SearchFilters {
  const defaults = createDefaultSearchFilters();
  const minDelaySeconds = clampInteger(
    filters.minDelaySeconds,
    SEARCH_FILTER_LIMITS.minDelaySeconds.min,
    SEARCH_FILTER_LIMITS.minDelaySeconds.max,
    defaults.minDelaySeconds,
  );
  const maxDelaySeconds = Math.max(
    minDelaySeconds,
    clampInteger(
      filters.maxDelaySeconds,
      SEARCH_FILTER_LIMITS.maxDelaySeconds.min,
      SEARCH_FILTER_LIMITS.maxDelaySeconds.max,
      defaults.maxDelaySeconds,
    ),
  );

  return {
    source: "leboncoin",
    category: isLeboncoinCategory(filters.category) ? filters.category : defaults.category,
    text: normalizeText(filters.text),
    locationQuery: normalizeText(filters.locationQuery),
    propertyTypes: normalizePropertyTypes(filters.propertyTypes, defaults.propertyTypes),
    ownerType: isLeboncoinOwnerType(filters.ownerType) ? filters.ownerType : defaults.ownerType,
    priceMin: normalizeOptionalRangeValue(filters.priceMin),
    priceMax: normalizeOptionalRangeValue(filters.priceMax),
    roomsMin: normalizeOptionalRangeValue(filters.roomsMin),
    roomsMax: normalizeOptionalRangeValue(filters.roomsMax),
    bedroomsMin: normalizeOptionalRangeValue(filters.bedroomsMin),
    bedroomsMax: normalizeOptionalRangeValue(filters.bedroomsMax),
    squareMin: normalizeOptionalRangeValue(filters.squareMin),
    squareMax: normalizeOptionalRangeValue(filters.squareMax),
    sort: isLeboncoinSort(filters.sort) ? filters.sort : defaults.sort,
    order: isLeboncoinOrder(filters.order) ? filters.order : defaults.order,
    maxListings: clampMaxListings(numberOrUndefined(filters.maxListings)),
    collectDetailPages:
      typeof filters.collectDetailPages === "boolean"
        ? filters.collectDetailPages
        : defaults.collectDetailPages,
    minDelaySeconds,
    maxDelaySeconds,
    pauseAfterDetails: clampInteger(
      filters.pauseAfterDetails,
      SEARCH_FILTER_LIMITS.pauseAfterDetails.min,
      SEARCH_FILTER_LIMITS.pauseAfterDetails.max,
      defaults.pauseAfterDetails,
    ),
    cooldownSeconds: clampInteger(
      filters.cooldownSeconds,
      SEARCH_FILTER_LIMITS.cooldownSeconds.min,
      SEARCH_FILTER_LIMITS.cooldownSeconds.max,
      defaults.cooldownSeconds,
    ),
  };
}

export function migrateStoredSearchFilters(value: unknown): SearchFilters {
  const stored = isRecord(value) ? (value as SearchFilterInput) : {};
  const normalized = normalizeSearchFilters(stored);

  if (normalized.locationQuery) return normalized;

  const legacyLocationToken = isRecord(value) ? normalizeText(value.locationToken) : "";
  return {
    ...normalized,
    locationQuery: legacyLocationToken.split("__", 1)[0]?.trim() ?? "",
  };
}

export function validateSearchFilters(filters: SearchFilters): FilterValidationIssue[] {
  const issues: FilterValidationIssue[] = [];

  for (const field of [
    "priceMin",
    "priceMax",
    "squareMin",
    "squareMax",
  ] as const) {
    const value = filters[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      issues.push({
        field,
        message: `${RANGE_FIELD_LABELS[field]} must be a non-negative integer.`,
      });
    }
  }

  for (const field of ["roomsMin", "roomsMax", "bedroomsMin", "bedroomsMax"] as const) {
    const value = filters[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 8)) {
      issues.push({
        field,
        message: `${RANGE_FIELD_LABELS[field]} must be an integer between 1 and 8.`,
      });
    }
  }

  validateRangeOrder(issues, filters, "priceMin", "priceMax", "Price");
  validateRangeOrder(issues, filters, "roomsMin", "roomsMax", "Rooms");
  validateRangeOrder(issues, filters, "bedroomsMin", "bedroomsMax", "Bedrooms");
  validateRangeOrder(issues, filters, "squareMin", "squareMax", "Surface");

  validateBoundedInteger(
    issues,
    "maxListings",
    filters.maxListings,
    SEARCH_FILTER_LIMITS.maxListings,
    "Max listings",
  );
  validateBoundedInteger(
    issues,
    "minDelaySeconds",
    filters.minDelaySeconds,
    SEARCH_FILTER_LIMITS.minDelaySeconds,
    "Minimum delay",
  );
  validateBoundedInteger(
    issues,
    "maxDelaySeconds",
    filters.maxDelaySeconds,
    SEARCH_FILTER_LIMITS.maxDelaySeconds,
    "Maximum delay",
  );
  validateBoundedInteger(
    issues,
    "pauseAfterDetails",
    filters.pauseAfterDetails,
    SEARCH_FILTER_LIMITS.pauseAfterDetails,
    "Pause interval",
  );
  validateBoundedInteger(
    issues,
    "cooldownSeconds",
    filters.cooldownSeconds,
    SEARCH_FILTER_LIMITS.cooldownSeconds,
    "Cooldown",
  );

  if (
    isIntegerWithin(filters.minDelaySeconds, SEARCH_FILTER_LIMITS.minDelaySeconds) &&
    isIntegerWithin(filters.maxDelaySeconds, SEARCH_FILTER_LIMITS.maxDelaySeconds) &&
    filters.minDelaySeconds > filters.maxDelaySeconds
  ) {
    issues.push({
      field: "maxDelaySeconds",
      message: "Maximum delay must be greater than or equal to minimum delay.",
    });
  }

  return issues;
}

export function isLeboncoinUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    (url.hostname === "leboncoin.fr" || url.hostname === "www.leboncoin.fr")
  );
}

export function isLeboncoinSearchUrl(url: URL): boolean {
  return isLeboncoinUrl(url) && url.pathname === "/recherche";
}

const RANGE_FIELD_LABELS: Record<
  | "priceMin"
  | "priceMax"
  | "roomsMin"
  | "roomsMax"
  | "bedroomsMin"
  | "bedroomsMax"
  | "squareMin"
  | "squareMax",
  string
> = {
  priceMin: "Minimum price",
  priceMax: "Maximum price",
  roomsMin: "Minimum rooms",
  roomsMax: "Maximum rooms",
  bedroomsMin: "Minimum bedrooms",
  bedroomsMax: "Maximum bedrooms",
  squareMin: "Minimum surface",
  squareMax: "Maximum surface",
};

function validateRangeOrder(
  issues: FilterValidationIssue[],
  filters: SearchFilters,
  minField:
    | "priceMin"
    | "roomsMin"
    | "bedroomsMin"
    | "squareMin",
  maxField:
    | "priceMax"
    | "roomsMax"
    | "bedroomsMax"
    | "squareMax",
  label: string,
) {
  const min = filters[minField];
  const max = filters[maxField];

  if (
    min !== undefined &&
    max !== undefined &&
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min >= 0 &&
    max >= 0 &&
    min > max
  ) {
    issues.push({
      field: maxField,
      message: `${label} maximum must be greater than or equal to its minimum.`,
    });
  }
}

function validateBoundedInteger(
  issues: FilterValidationIssue[],
  field: keyof SearchFilters,
  value: number,
  limits: { readonly min: number; readonly max: number },
  label: string,
) {
  if (!isIntegerWithin(value, limits)) {
    issues.push({
      field,
      message: `${label} must be an integer between ${limits.min} and ${limits.max}.`,
    });
  }
}

function isIntegerWithin(
  value: number,
  limits: { readonly min: number; readonly max: number },
): boolean {
  return Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePropertyTypes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];

  const supported = new Set(PROPERTY_TYPE_OPTIONS.map((option) => option.value));
  return Array.from(
    new Set(value.filter((entry): entry is string => typeof entry === "string" && supported.has(entry))),
  );
}

function normalizeOptionalRangeValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isLeboncoinCategory(value: unknown): value is LeboncoinCategory {
  return CATEGORY_OPTIONS.some((option) => option.value === value);
}

function isLeboncoinOwnerType(value: unknown): value is LeboncoinOwnerType {
  return OWNER_TYPE_OPTIONS.some((option) => option.value === value);
}

function isLeboncoinSort(value: unknown): value is LeboncoinSort {
  return SORT_OPTIONS.some((option) => option.value === value);
}

function isLeboncoinOrder(value: unknown): value is LeboncoinOrder {
  return value === "asc" || value === "desc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
