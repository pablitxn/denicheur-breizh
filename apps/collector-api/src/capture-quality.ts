import { dataFields, type DataField, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import { hasCollapsedDescription } from "./providers/scrape-quality.js";

const hasValue = (value: unknown) => value !== null && value !== undefined && (typeof value !== "string" || value.trim().length > 0) && (!Array.isArray(value) || value.length > 0);

/** Completeness is a field presence/absence assertion, not merely a successful page request. */
export function detailGaps(observation: ObservationInput, fields: readonly DataField[] = dataFields, warnings: readonly string[] = []): DataField[] {
  const missing = new Set(observation.missingFields);
  for (const field of fields) {
    const present = hasValue(observation.data[field]);
    if ((!present && !observation.absentFields.includes(field)) || (present && observation.absentFields.includes(field))) missing.add(field);
  }
  for (const field of ["energyClass", "gesClass"] as const) {
    const value = observation.data[field];
    if (hasValue(value) && !/^[A-G]$/i.test(String(value).trim())) missing.add(field);
  }
  const description = observation.data.description;
  if (hasCollapsedDescription(warnings, observation.url)) missing.add("description");
  if (description && (/\b(?:voir plus|show more|read more)\s*$/iu.test(description) || (warnings.some(warning => /(?:description.*truncat|truncat.*description)/iu.test(warning)) && /(?:…|\.{3})\s*$/u.test(description)))) missing.add("description");
  return [...missing];
}
