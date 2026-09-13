import type { PropertyListing } from "../../types";

export type MissingPropertyFact = "price" | "surface" | "location" | "energy" | "ges";

export interface EvaluationSummary {
  total: number;
  known: number;
  pass: number;
  fail: number;
  unknown: number;
}

export function summarizeEvaluation(
  criteria: readonly { readonly verdict: "pass" | "fail" | "unknown" }[],
): EvaluationSummary {
  const summary: EvaluationSummary = { total: criteria.length, known: 0, pass: 0, fail: 0, unknown: 0 };
  for (const criterion of criteria) summary[criterion.verdict] += 1;
  summary.known = summary.pass + summary.fail;
  return summary;
}

export function missingPropertyFacts(listing: PropertyListing): MissingPropertyFact[] {
  const missing: MissingPropertyFact[] = [];
  if (listing.priceEuros === undefined) missing.push("price");
  if (listing.surfaceM2 === undefined) missing.push("surface");
  if (!listing.location?.trim()) missing.push("location");
  if (!listing.energyClass?.trim()) missing.push("energy");
  if (!listing.gesClass?.trim()) missing.push("ges");
  return missing;
}
