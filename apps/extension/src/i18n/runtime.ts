import type { LocaleCode, MessageValues } from "@denicheur-breizh/i18n";
import type { FilterValidationIssue } from "../lib/leboncoinSearch";
import type { SearchFilters } from "../lib/types";
import type {
  ExtensionMessageId,
  ExtensionTranslate,
} from "./messages";
import { isExtensionMessageId } from "./messages";

export interface LocalizedTextDescriptor {
  id: string;
  values?: MessageValues;
  technicalDetail?: string;
}

export interface ResolvedLocalizedText {
  text: string;
  technicalDetail?: string;
}

export function resolveLocalizedText(
  value: unknown,
  t: ExtensionTranslate,
  fallbackId?: ExtensionMessageId,
): ResolvedLocalizedText {
  if (typeof value === "string") {
    return { text: translateLegacyText(value, t) };
  }

  if (isLocalizedTextDescriptor(value)) {
    if (isExtensionMessageId(value.id)) {
      return {
        text: t(value.id, value.values),
        technicalDetail: value.technicalDetail,
      };
    }

    return {
      text: t(fallbackId ?? "error.unknownDiagnostic"),
      technicalDetail: value.technicalDetail ?? value.id,
    };
  }

  if (fallbackId) return { text: t(fallbackId) };
  return { text: value === undefined || value === null ? "" : String(value) };
}

export function isLocalizedTextDescriptor(value: unknown): value is LocalizedTextDescriptor {
  if (typeof value !== "object" || value === null || !("id" in value)) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    typeof descriptor.id === "string" &&
    (descriptor.values === undefined || isMessageValues(descriptor.values)) &&
    (descriptor.technicalDetail === undefined || typeof descriptor.technicalDetail === "string")
  );
}

export function translateFilterValidationIssue(
  issue: FilterValidationIssue,
  filters: SearchFilters,
  t: ExtensionTranslate,
): string {
  const field = filterFieldLabel(issue.field, t);

  if (issue.field === "maxDelaySeconds" && filters.minDelaySeconds > filters.maxDelaySeconds) {
    return t("validation.delayOrder");
  }

  if (isRangeMaximum(issue.field) && rangeIsReversed(issue.field, filters)) {
    return t("validation.rangeOrder", { field: rangeGroupLabel(issue.field, t) });
  }

  if (isOneToEightField(issue.field)) {
    return t("validation.oneToEight", { field });
  }

  if (isNonNegativeField(issue.field)) {
    return t("validation.nonNegativeInteger", { field });
  }

  const limits = FILTER_LIMITS[issue.field as keyof typeof FILTER_LIMITS];
  if (limits) {
    return t("validation.boundedInteger", { field, min: limits.min, max: limits.max });
  }

  return translateLegacyText(issue.message, t);
}

export function missingFieldLabel(field: string, t: ExtensionTranslate): string {
  const normalized = field.trim();
  const id = MISSING_FIELD_IDS[normalized] ?? MISSING_FIELD_IDS[normalizeMissingAlias(normalized)];
  return id ? t(id) : field;
}

export function localeDisplayName(locale: LocaleCode, t: ExtensionTranslate): string {
  return t(`locale.name.${locale}`);
}

export function filterWarningFieldLabel(field: string, t: ExtensionTranslate): string {
  if (field.startsWith("detail:")) {
    return t("warning.detailField", { id: field.slice("detail:".length) });
  }

  const id = WARNING_FIELD_LABEL_IDS[field] ?? FIELD_LABEL_IDS[field as keyof SearchFilters];
  return id ? t(id) : t("warning.otherField");
}

export function translateLegacyText(message: string, t: ExtensionTranslate): string {
  const exactId = LEGACY_MESSAGE_IDS[message];
  if (exactId) return t(exactId);

  const maximumCriteria = /^Use at most (\d+) criteria\.$/.exec(message);
  if (maximumCriteria) return t("error.criteriaLimit", { count: Number(maximumCriteria[1]) });

  const collectedSkipped = /^Collected (\d+) listing summaries across (\d+) pages?\. Detail tabs were skipped\.$/.exec(message);
  if (collectedSkipped) {
    return `${t("run.collectedSummaries", {
      count: Number(collectedSkipped[1]),
      pages: Number(collectedSkipped[2]),
    })} ${t("search.collectDetails")} : 0.`;
  }

  const patterns: Array<{
    expression: RegExp;
    id: ExtensionMessageId;
    values: (match: RegExpExecArray) => MessageValues;
  }> = [
    {
      expression: /^Waiting before listing (\d+) of (\d+)\.$/,
      id: "run.waitingListing",
      values: (match) => ({ current: Number(match[1]), total: Number(match[2]) }),
    },
    {
      expression: /^Opening listing (\d+) of (\d+)\.$/,
      id: "run.openingListing",
      values: (match) => ({ current: Number(match[1]), total: Number(match[2]) }),
    },
    {
      expression: /^Collected (\d+) of (\d+)\.$/,
      id: "run.collectedProgress",
      values: (match) => ({ count: Number(match[1]), total: Number(match[2]) }),
    },
    {
      expression: /^Listing (\d+) of (\d+) failed; continuing with the next listing\.$/,
      id: "run.listingFailed",
      values: (match) => ({ current: Number(match[1]), total: Number(match[2]) }),
    },
    {
      expression: /^Cooling down for (\d+) seconds\.$/,
      id: "run.cooldown",
      values: (match) => ({ seconds: Number(match[1]) }),
    },
    {
      expression: /^Collecting search results page (\d+); (\d+) of (\d+) unique listings found\.$/,
      id: "run.collectingPage",
      values: (match) => ({ page: Number(match[1]), count: Number(match[2]), target: Number(match[3]) }),
    },
    {
      expression: /^Collected page (\d+); (\d+) of (\d+) unique listings found\.$/,
      id: "run.collectedPage",
      values: (match) => ({ page: Number(match[1]), count: Number(match[2]), target: Number(match[3]) }),
    },
    {
      expression: /^Advancing to search results page (\d+)\.$/,
      id: "run.advancingPage",
      values: (match) => ({ page: Number(match[1]) }),
    },
    {
      expression: /^Evaluating (\d+) detailed listings\.$/,
      id: "run.evaluating",
      values: (match) => ({ count: Number(match[1]) }),
    },
    {
      expression: /^Evaluated (\d+) detailed listings\.$/,
      id: "run.evaluated",
      values: (match) => ({ count: Number(match[1]) }),
    },
    {
      expression: /^Reevaluating (\d+) stored listings\.$/,
      id: "run.reevaluating",
      values: (match) => ({ count: Number(match[1]) }),
    },
    {
      expression: /^Reevaluated (\d+) stored listings\.$/,
      id: "run.reevaluated",
      values: (match) => ({ count: Number(match[1]) }),
    },
    {
      expression: /^Collected (\d+) detailed listings\. Intelligence failed; retry from the dashboard\.$/,
      id: "run.intelligenceFailed",
      values: (match) => ({ count: Number(match[1]) }),
    },
  ];

  for (const pattern of patterns) {
    const match = pattern.expression.exec(message);
    if (match) return t(pattern.id, pattern.values(match));
  }

  const legacyCaptcha = /^Captcha detected during (.+?)\. Solve it manually in the focused tab, then press Resume once\.$/.exec(message);
  if (legacyCaptcha) {
    return t("run.captchaPaused", { checkpoint: legacyCaptcha[1] ?? "", facts: "" });
  }

  return message;
}

const LEGACY_MESSAGE_IDS: Record<string, ExtensionMessageId> = {
  "Previous crawl was cancelled because the dashboard closed.": "run.previousCancelled",
  "Opening a dedicated Leboncoin home tab.": "run.openingHome",
  "Opening a dedicated Leboncoin tab.": "run.openingHome",
  "Applying native filters on the Leboncoin home page.": "run.applyingHomeFilters",
  "Applying native filters on the search results page.": "run.applyingResultsFilters",
  "Collecting search results.": "run.collectingResults",
  "Rechecking the same Leboncoin tab after manual CAPTCHA resolution.": "run.recheckingCaptcha",
  "LeBonCoin unusual activity block detected. Automation stopped.": "run.activityBlocked",
  "Leboncoin unusual activity block detected. Automation stopped.": "run.activityBlocked",
  "Stored listings were preserved. Intelligence reevaluation failed.": "run.reevaluationFailed",
  "Enable the intelligence recipe before reevaluating.": "error.enableRecipe",
  "No detailed records are available for reevaluation.": "error.noDetailedRecords",
  "No detailed listings are available for reevaluation.": "error.noDetailedRecords",
  "Give the intelligence recipe a name.": "error.recipeNameRequired",
  "Keep the recipe name under 160 characters.": "error.recipeNameLength",
  "The relevance threshold must be between 0 and 100.": "error.thresholdRange",
  "Add at least one intelligence criterion.": "error.criterionRequired",
  "Every criterion needs a unique id under 128 characters.": "error.criterionId",
  "Every criterion needs a name.": "error.criterionNameRequired",
  "Keep criterion names under 160 characters.": "error.criterionNameLength",
  "Every criterion needs a description.": "error.criterionDescriptionRequired",
  "Keep criterion descriptions under 2,000 characters.": "error.criterionDescriptionLength",
  "Criterion weights must be between 0 and 100.": "error.criterionWeightRange",
  "At least one criterion must have a positive weight.": "error.positiveWeight",
  "Another dashboard already owns the crawler run.": "error.runnerOwned",
};

const FILTER_LIMITS = {
  maxListings: { min: 1, max: 100 },
  minDelaySeconds: { min: 5, max: 300 },
  maxDelaySeconds: { min: 5, max: 600 },
  pauseAfterDetails: { min: 1, max: 20 },
  cooldownSeconds: { min: 30, max: 1800 },
} as const;

const FIELD_LABEL_IDS: Partial<Record<keyof SearchFilters, ExtensionMessageId>> = {
  priceMin: "search.priceMin",
  priceMax: "search.priceMax",
  roomsMin: "search.roomsMin",
  roomsMax: "search.roomsMax",
  bedroomsMin: "search.bedsMin",
  bedroomsMax: "search.bedsMax",
  squareMin: "search.surfaceMin",
  squareMax: "search.surfaceMax",
  maxListings: "search.maxListings",
  minDelaySeconds: "search.delayMin",
  maxDelaySeconds: "search.delayMax",
  pauseAfterDetails: "search.pauseEvery",
  cooldownSeconds: "search.cooldown",
};

const MISSING_FIELD_IDS: Record<string, ExtensionMessageId> = {
  title: "missing.title",
  price: "missing.priceEuros",
  priceEuros: "missing.priceEuros",
  propertyType: "missing.propertyType",
  rooms: "missing.rooms",
  bedrooms: "missing.bedrooms",
  surface: "missing.surfaceM2",
  surfaceM2: "missing.surfaceM2",
  landSurface: "missing.landSurfaceM2",
  landSurfaceM2: "missing.landSurfaceM2",
  location: "missing.location",
  sellerName: "missing.sellerName",
  sellerType: "missing.sellerType",
  energyClass: "missing.energyClass",
  gesClass: "missing.gesClass",
  description: "missing.description",
  features: "missing.features",
};

const WARNING_FIELD_LABEL_IDS: Record<string, ExtensionMessageId> = {
  source: "search.mode",
  category: "search.mode",
  text: "search.keywords",
  locationQuery: "search.location",
  propertyTypes: "search.types",
  ownerType: "search.seller",
  sort: "search.sort",
  order: "search.sort",
  collectDetailPages: "search.collectDetails",
  detailTabs: "search.collectDetails",
};

function filterFieldLabel(field: keyof SearchFilters, t: ExtensionTranslate): string {
  const id = FIELD_LABEL_IDS[field];
  return id ? t(id) : String(field);
}

function rangeGroupLabel(field: keyof SearchFilters, t: ExtensionTranslate): string {
  if (field === "priceMax") return t("search.priceMin").replace(/\s+[^\s]+$/, "");
  if (field === "roomsMax") return t("record.rooms").toLocaleLowerCase();
  if (field === "bedroomsMax") return t("record.beds").toLocaleLowerCase();
  return t("record.surface").toLocaleLowerCase();
}

function isRangeMaximum(field: keyof SearchFilters): field is "priceMax" | "roomsMax" | "bedroomsMax" | "squareMax" {
  return field === "priceMax" || field === "roomsMax" || field === "bedroomsMax" || field === "squareMax";
}

function rangeIsReversed(
  field: "priceMax" | "roomsMax" | "bedroomsMax" | "squareMax",
  filters: SearchFilters,
): boolean {
  const minimumField = {
    priceMax: "priceMin",
    roomsMax: "roomsMin",
    bedroomsMax: "bedroomsMin",
    squareMax: "squareMin",
  } as const;
  const minimum = filters[minimumField[field]];
  const maximum = filters[field];
  return minimum !== undefined && maximum !== undefined && minimum > maximum;
}

function isOneToEightField(field: keyof SearchFilters): boolean {
  return field === "roomsMin" || field === "roomsMax" || field === "bedroomsMin" || field === "bedroomsMax";
}

function isNonNegativeField(field: keyof SearchFilters): boolean {
  return field === "priceMin" || field === "priceMax" || field === "squareMin" || field === "squareMax";
}

function normalizeMissingAlias(field: string): string {
  return field.toLocaleLowerCase().replace(/[\s_-]+(.)/g, (_, character: string) => character.toLocaleUpperCase());
}

function isMessageValues(value: unknown): value is MessageValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number");
}
