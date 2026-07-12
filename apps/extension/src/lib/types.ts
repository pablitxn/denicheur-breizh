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
  evaluation?: ListingEvaluation;
}

export type CriterionVerdict = "pass" | "fail" | "unknown";
export type ListingDecision = "relevant" | "not-relevant" | "review";

export interface IntelligenceCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  required: boolean;
}

export interface IntelligenceRecipe {
  id: string;
  version: number;
  name: string;
  threshold: number;
  enabled: boolean;
  criteria: IntelligenceCriterion[];
}

export interface CriterionEvaluation {
  criterionId: string;
  verdict: CriterionVerdict;
  reason: string;
  evidence: string[];
}

export interface ListingEvaluation {
  listingId: string;
  decision: ListingDecision;
  score: number | null;
  summary: string;
  criteria: CriterionEvaluation[];
  missingData: string[];
  evaluatedAt: string;
  evaluator: {
    provider: "openai";
    model: string;
    version: string;
  };
  recipeId: string;
  recipeVersion: number;
}

export type ScrapeRunStatus =
  | "idle"
  | "opening-search"
  | "collecting-search"
  | "collecting-details"
  | "evaluating"
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
  intelligenceStatus?: "idle" | "evaluating" | "completed" | "failed";
  intelligenceError?: string;
  evaluated: number;
  relevant: number;
  notRelevant: number;
  review: number;
}

export interface StoredCrawlerState {
  filters: SearchFilters;
  recipe: IntelligenceRecipe;
  run: ScrapeRun;
  records: ScrapedPropertyRecord[];
}
