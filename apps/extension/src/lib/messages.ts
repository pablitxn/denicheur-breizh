import type {
  LeboncoinCategory,
  LeboncoinOrder,
  LeboncoinOwnerType,
  LeboncoinSort,
  ListingDetail,
  ListingSummary,
  LocalizedText,
  SiteChallenge,
} from "./types";
import { MAX_LISTINGS_PER_PAGE } from "./leboncoinSearch";

export interface NativeSearchFilters {
  category: LeboncoinCategory;
  text: string;
  locationQuery: string;
  propertyTypes: string[];
  ownerType: LeboncoinOwnerType;
  priceMin?: number;
  priceMax?: number;
  roomsMin?: number;
  roomsMax?: number;
  bedroomsMin?: number;
  bedroomsMax?: number;
  squareMin?: number;
  squareMax?: number;
  sort: LeboncoinSort;
  order: LeboncoinOrder;
}

export interface FilterWarning {
  field: string;
  message: LocalizedText;
}

export type NativeSearchPhase =
  | "home-prepared"
  | "home-submitted"
  | "results-prepared"
  | "results-applied"
  | "pagination-prepared"
  | "pagination-advanced";

export type NativeResultsStep =
  | "location"
  | "category"
  | "property-types"
  | "rooms-min"
  | "rooms-max"
  | "bedrooms-min"
  | "bedrooms-max"
  | "filters"
  | "complete";

export type NativeSearchRequest =
  | {
      type: "LBC_PREPARE_HOME_SEARCH";
      filters: NativeSearchFilters;
    }
  | {
      type: "LBC_SUBMIT_HOME_SEARCH";
    }
  | {
      type: "LBC_PREPARE_RESULTS_FILTERS";
      filters: NativeSearchFilters;
    }
  | {
      type: "LBC_APPLY_RESULTS_FILTERS";
    }
  | {
      type: "LBC_PREPARE_NEXT_RESULTS_PAGE";
    }
  | {
      type: "LBC_GO_NEXT_RESULTS_PAGE";
    };

export type ContentRequest =
  | NativeSearchRequest
  | {
      type: "LBC_COLLECT_SEARCH_RESULTS";
      limit: number;
    }
  | {
      type: "LBC_COLLECT_DETAIL";
    };

export type ContentResponse =
  | NativeSearchResponse
  | {
      type: "LBC_SEARCH_RESULTS";
      captcha: boolean;
      ready: boolean;
      challenge?: SiteChallenge;
      listings: ListingSummary[];
    }
  | {
      type: "LBC_DETAIL";
      captcha: boolean;
      ready: boolean;
      challenge?: SiteChallenge;
      detail?: ListingDetail;
    };

export interface NativeSearchResponse {
  type: "LBC_NATIVE_SEARCH_RESULT";
  phase: NativeSearchPhase;
  ok: boolean;
  applied: string[];
  omitted: string[];
  warnings: FilterWarning[];
  /**
   * Results configuration is intentionally staged because choosing a
   * location or category can navigate and replace Leboncoin's React tree.
   * The runner re-handshakes and prepares the next step after every commit.
   */
  step?: NativeResultsStep;
  navigationExpected?: boolean;
  /** Whether the current native results pagination exposes an enabled next-page control. */
  hasNextPage?: boolean;
  /**
   * Present on a queued post-ACK action failure. `false` means the native
   * click never happened, so the runner may re-arm that same action once
   * after a manually-resolved CAPTCHA. It is never used to retry an action
   * whose click may already have reached the site.
   */
  actionExecuted?: boolean;
  challenge?: SiteChallenge;
  error?: LocalizedText;
}

export function isContentRequest(message: unknown): message is ContentRequest {
  if (!message || typeof message !== "object" || !("type" in message)) return false;

  if (
    message.type === "LBC_COLLECT_DETAIL" ||
    message.type === "LBC_SUBMIT_HOME_SEARCH" ||
    message.type === "LBC_APPLY_RESULTS_FILTERS" ||
    message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE" ||
    message.type === "LBC_GO_NEXT_RESULTS_PAGE"
  ) {
    return true;
  }

  if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
    return (
      "limit" in message &&
      typeof message.limit === "number" &&
      Number.isInteger(message.limit) &&
      message.limit >= 1 &&
      message.limit <= MAX_LISTINGS_PER_PAGE
    );
  }

  return (
    (message.type === "LBC_PREPARE_HOME_SEARCH" ||
      message.type === "LBC_PREPARE_RESULTS_FILTERS") &&
    "filters" in message &&
    isNativeSearchFilters(message.filters)
  );
}

function isNativeSearchFilters(value: unknown): value is NativeSearchFilters {
  if (!value || typeof value !== "object") return false;

  const filters = value as Record<string, unknown>;
  return (
    isOneOf(filters.category, ["9", "10", "11", "13", "2001"]) &&
    typeof filters.text === "string" &&
    typeof filters.locationQuery === "string" &&
    Array.isArray(filters.propertyTypes) &&
    filters.propertyTypes.every((propertyType) => typeof propertyType === "string") &&
    isOneOf(filters.ownerType, ["all", "private", "pro"]) &&
    isOptionalFiniteNumber(filters.priceMin) &&
    isOptionalFiniteNumber(filters.priceMax) &&
    isOptionalFiniteNumber(filters.roomsMin) &&
    isOptionalFiniteNumber(filters.roomsMax) &&
    isOptionalFiniteNumber(filters.bedroomsMin) &&
    isOptionalFiniteNumber(filters.bedroomsMax) &&
    isOptionalFiniteNumber(filters.squareMin) &&
    isOptionalFiniteNumber(filters.squareMax) &&
    isOneOf(filters.sort, ["time", "relevance"]) &&
    isOneOf(filters.order, ["asc", "desc"])
  );
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}
