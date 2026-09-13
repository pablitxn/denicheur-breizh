import type {
  EvaluationExecutionCreateRequest as SharedEvaluationExecutionCreateRequest,
  EvaluationExecutionListingResult as SharedEvaluationExecutionListingResult,
  EvaluationExecutionRecord as SharedEvaluationExecutionRecord,
  EvaluationExecutionResults as SharedEvaluationExecutionResults,
  EvaluationExecutionStatus as SharedEvaluationExecutionStatus,
  EvaluationExecutionStepResult as SharedEvaluationExecutionStepResult,
  EvaluationPlanDraft as SharedEvaluationPlanDraft,
  EvaluationPlanOperator as SharedEvaluationPlanOperator,
  EvaluationPlanRecipeReference as SharedEvaluationPlanRecipeReference,
  EvaluationPlanVersion as SharedEvaluationPlanVersion,
  ListingImageAssetStatus as SharedListingImageAssetStatus,
} from "@denicheur-breizh/contracts";

export type ListingDecision = "relevant" | "not-relevant" | "review";
export type CriterionVerdict = "pass" | "fail" | "unknown";

export interface ListingCriterionEvaluation {
  criterionId: string;
  verdict: CriterionVerdict;
  reason: string;
  evidence: string[];
}

export interface ListingEvaluation {
  listingId: string;
  runId: string;
  decision: ListingDecision;
  score: number | null;
  summary: string;
  criteria: ListingCriterionEvaluation[];
  missingData: string[];
  evaluatedAt: string;
  recipeId: string;
  recipeVersion: number;
  locale?: "fr" | "es" | "en";
  evaluator?: {
    provider: "openai";
    model: string;
    version: string;
  };
}

export interface ListingRunReference {
  id: string;
  status?: string;
  observedAt?: string;
}

export type CoordinateLocationKind =
  | "source-property"
  | "source-locality"
  | "locality-centroid"
  | "postal-code-centroid";

export interface PropertyCoordinates {
  latitude: number;
  longitude: number;
  verifiedAt: string;
  provenance: string;
  locationKind: CoordinateLocationKind;
}

export type PropertyImageAssetStatus = SharedListingImageAssetStatus;

export interface PropertyImageAsset {
  id: string;
  sourceUrl: string;
  status: PropertyImageAssetStatus;
  thumbnailUrl?: string;
  galleryUrl?: string;
}

export interface PropertyListing {
  source: string;
  externalId: string;
  key: string;
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
  sellerName?: string;
  sellerType?: string;
  postedAt?: string;
  description?: string;
  energyClass?: string;
  gesClass?: string;
  imageUrls: string[];
  imageAssets?: PropertyImageAsset[];
  features: string[];
  status?: string;
  scrapedAt?: string;
  updatedAt?: string;
  coordinates?: PropertyCoordinates;
  latestRun?: ListingRunReference;
  runs: ListingRunReference[];
  evaluation?: ListingEvaluation;
  evaluations: ListingEvaluation[];
}

/** Lightweight catalog projection. Evaluation evidence is available from the detail endpoint. */
export type PropertyMapListing = Omit<PropertyListing, "evaluation"> & {
  evaluation?: Pick<ListingEvaluation, "decision" | "score" | "evaluatedAt"> & { summary?: string };
};

export interface IntelligenceCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  required: boolean;
  evidenceRequired?: boolean;
}

export interface IntelligenceRecipe {
  id: string;
  version: number;
  name: string;
  threshold: number;
  criteria: IntelligenceCriterion[];
  active: boolean;
  createdAt?: string;
}

export interface RecipeDraft {
  id: string;
  name: string;
  threshold: number;
  criteria: IntelligenceCriterion[];
}

export type EvaluationPlanOperator = SharedEvaluationPlanOperator;
export type EvaluationPlanRecipeRef = SharedEvaluationPlanRecipeReference;
export type EvaluationPlan = SharedEvaluationPlanVersion;
export interface EvaluationPlanDraft extends SharedEvaluationPlanDraft { id: string }
export type EvaluationExecutionStatus = SharedEvaluationExecutionStatus;
export type EvaluationExecution = SharedEvaluationExecutionRecord;
export type EvaluationExecutionStepResult = SharedEvaluationExecutionStepResult;
export type EvaluationExecutionResult = SharedEvaluationExecutionListingResult;
export type EvaluationExecutionDetail = SharedEvaluationExecutionRecord;
export type EvaluationExecutionResults = SharedEvaluationExecutionResults;

export interface StartEvaluationExecutionInput extends SharedEvaluationExecutionCreateRequest {
  runId: string;
  idempotencyKey: string;
}

export interface ListingFilters {
  q?: string;
  sources?: string[];
  runId?: string;
  status?: string;
  decision?: ListingDecision;
  propertyType?: string;
  priceMin?: number;
  priceMax?: number;
  surfaceMin?: number;
  energyClassMax?: string;
  cursor?: string;
  limit?: number;
  sort?: "title" | "priceEuros" | "surfaceM2" | "score" | "source" | "updatedAt";
  order?: "asc" | "desc";
}

export interface PaginatedListings {
  items: PropertyListing[];
  nextCursor: string | null;
  total: number;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  database: "ok" | "unavailable";
  media: {
    status: "disabled" | "ok" | "degraded";
    pending: number;
    processing: number;
    ready: number;
    failed: number;
  };
  openAiConfigured: boolean;
}

export type WorkspaceView = "map" | "properties" | "scorings" | "builder" | "realtime";
export type ThemeMode = "system" | "dark" | "light";
export type AccentMode = "lavender" | "sunset" | "sea";
export type DensityMode = "comfortable" | "compact";

export function propertyKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}
