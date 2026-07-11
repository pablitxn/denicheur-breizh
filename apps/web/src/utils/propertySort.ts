import type { PropertyListing, ScoreKey } from "../types";

export type PropertySortKey =
  | "title"
  | "price"
  | "surfaceM2"
  | "dpe"
  | "provider"
  | "postedDaysAgo"
  | "overall"
  | ScoreKey;

const scoreSortKeys = new Set<ScoreKey>(["coast", "quiet", "value", "family", "transit", "flood"]);

export function getPropertySortValue(property: PropertyListing, sortKey: PropertySortKey): string | number {
  if (sortKey === "overall") return property.scores.overall;
  if (scoreSortKeys.has(sortKey as ScoreKey)) return property.scores[sortKey as ScoreKey];
  return property[sortKey as keyof PropertyListing] as string | number;
}
