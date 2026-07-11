export type SourceSite = "leboncoin";

export type LeboncoinCategory = "9" | "10" | "11" | "13" | "2001";
export type LeboncoinOwnerType = "all" | "private" | "pro";
export type LeboncoinSort = "time" | "relevance";
export type LeboncoinOrder = "asc" | "desc";

export interface SearchFilters {
  source: SourceSite;
  rawSearchUrl: string;
  category: LeboncoinCategory;
  text: string;
  locationToken: string;
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
  maxListings: number;
  collectDetailPages: boolean;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  pauseAfterDetails: number;
  cooldownSeconds: number;
  closeDetailTabs: boolean;
}

export interface SiteChallenge {
  type: "captcha" | "unusual-activity";
  title: string;
  message: string;
}

export interface ListingSummary {
  source: SourceSite;
  id: string;
  url: string;
  title: string;
  priceText?: string;
  priceEuros?: number;
  pricePerSquareMeterText?: string;
  propertyType?: string;
  rooms?: number;
  surfaceM2?: number;
  landSurfaceM2?: number;
  location?: string;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  imageUrl?: string;
  features: string[];
  rawTextSample: string;
}

export interface ListingDetail {
  title?: string;
  priceText?: string;
  priceEuros?: number;
  pricePerSquareMeterText?: string;
  propertyType?: string;
  rooms?: number;
  bedrooms?: number;
  surfaceM2?: number;
  landSurfaceM2?: number;
  location?: string;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  description?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrl?: string;
  features: string[];
  rawTextSample: string;
}

export interface ScrapedPropertyRecord {
  id: string;
  source: SourceSite;
  listingUrl: string;
  title: string;
  priceText?: string;
  priceEuros?: number;
  pricePerSquareMeterText?: string;
  propertyType?: string;
  rooms?: number;
  bedrooms?: number;
  surfaceM2?: number;
  landSurfaceM2?: number;
  location?: string;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  description?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrl?: string;
  features: string[];
  scrapedAt: string;
  searchRunId: string;
  status: "listing" | "detailed" | "failed";
  error?: string;
  rawTextSample: string;
}

export type ScrapeRunStatus =
  | "idle"
  | "opening-search"
  | "collecting-search"
  | "collecting-details"
  | "paused-captcha"
  | "blocked-activity"
  | "completed"
  | "cancelled"
  | "failed";

export interface ScrapeRun {
  id: string;
  status: ScrapeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  searchUrl?: string;
  target: number;
  found: number;
  collected: number;
  currentUrl?: string;
  message?: string;
  error?: string;
}

export interface StoredCrawlerState {
  filters: SearchFilters;
  run: ScrapeRun;
  records: ScrapedPropertyRecord[];
}
