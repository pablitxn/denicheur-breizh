import { dataFields, type DataField, type Evidence, type FieldState, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import { hasCollapsedDescription } from "./providers/scrape-quality.js";
import { canonicalIdentity } from "./sources.js";

const hasValue = (value: unknown) => value !== null && value !== undefined && (typeof value !== "string" || value.trim().length > 0) && (!Array.isArray(value) || value.length > 0);
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
export const fieldLabels: Record<DataField, RegExp> = {
  title: /\b(?:titre|title)\b/i, priceEuros: /\b(?:prix(?: du bien)?|price)\b/i, propertyType: /\b(?:type de bien|type de propriete|property type)\b/i,
  location: /\b(?:localisation|localite|adresse|location)\b/i, surfaceM2: /\b(?:surface habitable|surface du bien|living area)\b/i,
  landSurfaceM2: /\b(?:surface (?:totale )?du terrain|terrain|land area|land surface)\b/i, rooms: /\b(?:nombre de pieces|pieces|rooms)\b/i,
  bedrooms: /\b(?:nombre de chambres|chambres?|bedrooms?)\b/i, description: /\b(?:description)\b/i,
  energyClass: /\b(?:dpe|classe energie|classe energetique|energy class|diagnostic de performance energetique)\b/i,
  gesClass: /\b(?:ges|classe climat|emissions? de gaz a effet de serre|gas emission class)\b/i,
  sellerName: /\b(?:nom du vendeur|vendeur|seller name)\b/i, sellerType: /\b(?:type de vendeur|vendeur|seller type)\b/i,
  postedAt: /\b(?:date de publication|publie|publication date)\b/i, features: /\b(?:caracteristiques?|equipements?|features|atouts?)\b/i,
  imageUrls: /\b(?:photos?|images?|galerie|gallery)\b/i,
};

export function sameListingEvidenceUrl(left: string, right: string): boolean {
  try { return canonicalIdentity("leboncoin", left).id === canonicalIdentity("leboncoin", right).id; }
  catch { try { const a = new URL(left), b = new URL(right); return a.protocol === "https:" && b.protocol === "https:" && !a.username && !b.username && a.origin === b.origin && a.pathname === b.pathname; } catch { return false; } }
}
function ownEvidence(observation: ObservationInput, evidence: readonly Evidence[]): Evidence[] { return evidence.filter(item => item.text.trim() && sameListingEvidenceUrl(observation.url, item.url)); }
export function validFieldValue(field: DataField, value: unknown): boolean {
  if (!hasValue(value)) return false;
  if (typeof value === "string" && /^(?:null|undefined|unknown|inconnu|n\/a|na|non renseigne|non disponible|en savoir plus)$/iu.test(normalize(value))) return false;
  if (field === "energyClass" || field === "gesClass") return typeof value === "string" && /^[A-G]$/i.test(value.trim());
  if (["priceEuros", "surfaceM2", "landSurfaceM2", "rooms", "bedrooms"].includes(field)) return typeof value === "number" && Number.isFinite(value) && value >= 0;
  return true;
}

/** Absence must be stated for this field; an empty page or a property type proves nothing. */
export function explicitFieldAbsence(field: DataField, text: string, status: "absent" | "not_applicable"): boolean {
  const marker = status === "not_applicable" ? /\b(?:non soumis|non assujetti|non applicable|pas applicable|exempte?|pas concerne|not applicable|not subject|exempt)\b/i : /\b(?:non renseigne|non communique|non disponible|non indique|non precise|aucun[e]?|pas de|sans|not provided|not specified|not disclosed|not available|absent)\b/i;
  return text.split(/[\r\n]+|[.;](?:\s|$)/u).some(clause => { const value = normalize(clause); return value.length <= 350 && fieldLabels[field].test(value) && marker.test(value); });
}
function observedProof(field: DataField, value: unknown, evidence: readonly Evidence[]): boolean {
  const text = normalize(evidence.map(item => item.text).join("\n"));
  if (field === "energyClass" || field === "gesClass") {
    const label = field === "energyClass" ? "(?:dpe|classe energie|classe energetique|energy class)" : "(?:ges|classe climat|gas emission class)";
    return new RegExp(`\\b${label}\\s*[:=–-]?\\s*${String(value).trim()}\\b`, "i").test(text);
  }
  if (typeof value === "number") return [...text.matchAll(new RegExp(fieldLabels[field].source, "gi"))].some(label => {
    const numeric = /^\s*[:=–-]?\s*(\d[\d \u00a0\u202f]*(?:[.,]\d+)?)/u.exec(text.slice(label.index! + label[0].length))?.[1];
    return numeric !== undefined && Number(numeric.replace(/\s/gu, "").replace(",", ".")) === value;
  });
  if (Array.isArray(value)) return value.every(item => typeof item === "string" && text.includes(normalize(item)));
  return typeof value === "string" && text.includes(normalize(value));
}

/** A complete, conservative view for the API/UI, including clearly labeled legacy assertions. */
export function detailFieldStates(observation: ObservationInput): Record<DataField, FieldState> {
  return Object.fromEntries(dataFields.map(field => {
    const declared = observation.fieldStates?.[field], value = observation.data[field], evidence = ownEvidence(observation, declared?.evidence ?? observation.evidence);
    const unresolved = (reason: string): FieldState => ({ status: "unresolved", reason, evidence, ...(declared?.observedAt ? { observedAt: declared.observedAt } : {}) });
    let state: FieldState;
    if (declared) {
      if (declared.status === "unresolved") state = { ...declared, evidence };
      else if (!declared.reason.trim() || !evidence.length) state = unresolved("The field declaration lacks a reason or same-listing source evidence.");
      else if (declared.status === "observed") state = validFieldValue(field, value) && !observation.absentFields.includes(field) && observedProof(field, value, evidence) ? { ...declared, evidence } : unresolved("The observed value is missing, invalid, contradicted or unsupported by its field evidence.");
      else state = !hasValue(value) && evidence.some(item => explicitFieldAbsence(field, item.text, declared.status as "absent" | "not_applicable")) ? { ...declared, evidence } : unresolved("Absence or inapplicability is not explicitly established for this field, or contradicts a value.");
    } else if (observation.missingFields.includes(field)) state = unresolved("The capture explicitly reports this field as unresolved.");
    else if (validFieldValue(field, value) && !observation.absentFields.includes(field) && evidence.length) state = { status: "observed", reason: "Value retained from a legacy observation with listing evidence; no dedicated field quotation was recorded.", evidence };
    else if (!hasValue(value) && observation.absentFields.includes(field) && evidence.length) state = { status: "absent", reason: "Explicit legacy source-absence assertion retained; no dedicated field quotation was recorded.", evidence };
    else state = unresolved("No valid observed value or evidenced source absence was established.");
    return [field, state];
  })) as Record<DataField, FieldState>;
}

/** Completeness is a field presence/absence assertion, not merely a successful page request. */
export function detailGaps(observation: ObservationInput, fields: readonly DataField[] = dataFields, warnings: readonly string[] = []): DataField[] {
  const missing = new Set(observation.missingFields);
  const states = detailFieldStates(observation);
  for (const field of fields) {
    if (states[field].status === "unresolved") missing.add(field);
    else if (observation.fieldStates?.[field]) missing.delete(field);
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
