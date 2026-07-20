import type { LocaleCode, MessageDescriptor } from "@denicheur-breizh/i18n";
import type { VerifiedCoordinates } from "@denicheur-breizh/contracts";

export type SourceSite = "leboncoin";

/**
 * Stable coordinate evidence read from a source page. The observation time is
 * added only when the crawler persists a record so repeated DOM polls keep the
 * same fingerprint.
 */
export type CoordinateEvidence = Omit<VerifiedCoordinates, "verifiedAt">;

/**
 * New runtime state stores stable message descriptors. Strings remain accepted
 * so installations can load crawler records written by older extension builds.
 */
export type LocalizedText = string | MessageDescriptor<string>;

export type LeboncoinCategory = "9" | "10" | "11" | "13" | "2001";
export type LeboncoinOwnerType = "all" | "private" | "pro";
export type LeboncoinSort = "time" | "relevance";
export type LeboncoinOrder = "asc" | "desc";

export interface SearchFilters {
  source: SourceSite;
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
  maxListings: number;
  collectDetailPages: boolean;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  pauseAfterDetails: number;
  cooldownSeconds: number;
}

export interface FilterApplicationWarning {
  field: string;
  message: LocalizedText;
}

export interface SiteChallenge {
  type: "captcha" | "unusual-activity";
  title: LocalizedText;
  message: LocalizedText;
  /** Short, non-sensitive detector evidence suitable for the visible run log. */
  evidence?: string;
}

export interface ListingSummary {
  source: SourceSite;
  id: string;
  url: string;
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
  coordinateEvidence?: CoordinateEvidence;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrl?: string;
  imageUrls?: string[];
  features: string[];
  rawTextSample: string;
}

export interface ListingDetail {
  id?: string;
  url?: string;
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
  coordinateEvidence?: CoordinateEvidence;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  description?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrl?: string;
  imageUrls?: string[];
  features: string[];
  rawTextSample: string;
}

export interface ScrapedPropertyRecord {
  id: string;
  source: SourceSite;
  listingUrl: string;
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
  coordinates?: VerifiedCoordinates;
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  description?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrl?: string;
  imageUrls?: string[];
  features: string[];
  scrapedAt: string;
  searchRunId: string;
  status: "listing" | "detailed" | "failed";
  error?: LocalizedText;
  rawTextSample: string;
  evaluation?: ListingEvaluation;
  /** The last technical evaluation failure. A previous valid evaluation may coexist with it. */
  evaluationFailure?: ListingEvaluationFailure;
  /** Aggregate result from a durable, versioned evaluation plan. Legacy recipe results stay untouched. */
  planEvaluation?: PlanEvaluation;
}

export type CriterionVerdict = "pass" | "fail" | "unknown";
export type ListingDecision = "relevant" | "not-relevant" | "review";

export interface IntelligenceCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  required: boolean;
  /** Older cached recipes omitted this flag; omission keeps the historical evidence-required behavior. */
  evidenceRequired?: boolean;
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
  /** Missing on evaluations persisted by extension builds before locale support. */
  locale?: LocaleCode;
}

export interface ListingEvaluationFailure {
  listingId: string;
  code: string;
  stage: string;
  retryable: boolean;
  requestId?: string;
  attemptId?: string;
  criterionId?: string;
}

export interface ListingEvaluationOutcome {
  evaluations: ListingEvaluation[];
  failures: ListingEvaluationFailure[];
}

export type EvaluationPlanOperator = "all" | "any";

export interface EvaluationPlanRecipe {
  recipeId: string;
  recipeVersion: number;
  recipe: IntelligenceRecipe;
}

export interface EvaluationPlan {
  id: string;
  version: number;
  name: string;
  operator: EvaluationPlanOperator;
  recipes: EvaluationPlanRecipe[];
  isDefault: boolean;
  combinerVersion: "tri-state-v1";
  createdAt: string;
}

export interface EvaluationExecution {
  id: string;
  runId: string;
  planId: string;
  planVersion: number;
  locale: LocaleCode;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface PlanEvaluationStep {
  recipeId: string;
  recipeVersion: number;
  status: "succeeded" | "cached" | "failed" | "skipped";
  evaluation?: PlanRecipeEvaluation;
  evaluator?: ListingEvaluation["evaluator"];
  error?: {
    code: string;
    message?: string;
    retryable?: boolean;
  };
}

export interface PlanRecipeEvaluation {
  listingId: string;
  decision: ListingDecision;
  score: number | null;
  summary: string;
  criteria: CriterionEvaluation[];
  missingData: string[];
  evaluatedAt: string;
}

export interface PlanEvaluation {
  executionId: string;
  listingId: string;
  planId: string;
  planVersion: number;
  decision: ListingDecision;
  score: number | null;
  summary: string;
  locale?: LocaleCode;
  evaluatedAt?: string;
  steps: PlanEvaluationStep[];
}

export type ScrapeRunStatus =
  | "idle"
  | "opening-search"
  | "configuring-search"
  | "collecting-search"
  | "collecting-details"
  | "evaluating"
  | "blocked-captcha"
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
  pagesVisited: number;
  collected: number;
  currentUrl?: string;
  message?: LocalizedText;
  error?: LocalizedText;
  intelligenceStatus?: "idle" | "evaluating" | "completed" | "partial" | "failed";
  intelligenceError?: LocalizedText;
  evaluated: number;
  relevant: number;
  notRelevant: number;
  review: number;
  filterWarnings: FilterApplicationWarning[];
}

export interface StoredCrawlerState {
  filters: SearchFilters;
  recipe: IntelligenceRecipe;
  run: ScrapeRun;
  records: ScrapedPropertyRecord[];
}
