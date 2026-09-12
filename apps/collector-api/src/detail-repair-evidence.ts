import { type DataField, type Evidence, type FieldState, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import { detailFieldStates, explicitFieldAbsence, fieldLabels, sameListingEvidenceUrl, validFieldValue } from "./capture-quality.js";
import { asRecord } from "./providers/http.js";
import { normalizeScrapeDescription, scrapeDescription } from "./providers/scrape-quality.js";

const normalized = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const criterionNames: Record<string, DataField> = {
  "type de bien": "propertyType", "surface habitable": "surfaceM2", "surface du bien": "surfaceM2",
  "surface totale du terrain": "landSurfaceM2", "surface du terrain": "landSurfaceM2", "terrain": "landSurfaceM2",
  "nombre de pieces": "rooms", "nombre de chambres": "bedrooms", "classe energie": "energyClass", "classe energetique": "energyClass", "dpe": "energyClass", "ges": "gesClass", "classe climat": "gesClass",
  "caracteristiques": "features", "equipements": "features", "exterieur": "features", "atouts": "features",
  "nom du vendeur": "sellerName", "type de vendeur": "sellerType", "date de publication": "postedAt",
  "prix du bien": "priceEuros", "prix du bien(honoraires inclus)": "priceEuros", "localisation": "location",
};
const numericFields = new Set<DataField>(["surfaceM2", "landSurfaceM2", "rooms", "bedrooms", "priceEuros"]);
const numericAmenityCriteria = new Set(["nombre de salles de bain", "nombre de salles de bains", "nombre de salles d'eau", "nombre de salles d’eau", "nombre de toilettes", "nombre d'etages dans l'immeuble", "nombre d’etages dans l’immeuble", "etage de votre bien", "places de parking"]);
const amenityCriteria = new Set([...numericAmenityCriteria, "type de chauffage", "mode de chauffage", "ascenseur"]);
const narrativeAmenity = /\b(?:plain[- ]pied|garage|parking|cave|balcon|terrasse|loggia|jardin|piscine|ascenseur|arriere[- ]cuisine|cuisine (?:ouverte|equipee|amenagee|separee)|salle de bains?|salle d['’]eau|douche|baignoire|cheminee|insert (?:bois|a bois)|double vitrage|pompe a chaleur)\b/u;
const uncertainNarrative = /\b(?:sans|pas|aucun[es]?|ni|non|ne|jamais|absence|manque|anciennement|ancien(?:ne)?s?|supprim(?:e|ee|es|ees)|transform(?:e|ee|es|ees|ation)|projets?|potentiel|possibilite|possibles?|pourrait|pourra|pourrez|pourront|permettrait|permettra|prevoir|envisag(?:e|ee|es|ees|eable|eables)|construire|creer|creations?|amenager|amenageables?|options?|futur(?:e)?s?|prevu(?:e)?s?)\b/u;
const nonFeatureNarrative = /\b(?:contact|contactez|telephone|appelez|visite|visitez|rendez-vous|reference annonce|honoraires|consommation|energetique|emission|diagnostic|dpe|ges|depenses|energie|abonnement|assurance|reserve|disponibilite|contractuel|contractuelle|illustration|photos? de|georisques|risques|charges|taxe|prix|vendeur|acquereur)\b/u;

/** Keep complete source sentences; never turn a negated or hypothetical amenity into a positive label. */
function narrativeFeatures(description: string): string[] {
  return description.split(/\n\s*\n/u).flatMap(paragraph => paragraph.trim().split(/(?<=[.!?])\s+/u))
    .map(sentence => sentence.trim())
    .filter(sentence => {
      const text = normalized(sentence);
      return !/^[-*+]\s/u.test(sentence) && !/^#{1,6}\s/u.test(sentence) && narrativeAmenity.test(text) && !uncertainNarrative.test(text) && !nonFeatureNarrative.test(text) && !/https?:\/\/|www\.|\[.*\]\(/iu.test(sentence);
    });
}
function numeric(value: string): number | undefined {
  const match = /^\s*(\d[\d\s\u00a0\u202f]*(?:[,.]\d+)?)\s*(?:m[²2]|ch\.?|chambres?|pieces?|pièces?|€|euros?)?\s*$/iu.exec(value);
  if (!match) return undefined;
  const result = Number(match[1]!.replace(/\s/gu, "").replace(",", "."));
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}
function withoutCode(markdown: string): string {
  let fence: string | undefined, html = false;
  return markdown.replace(/\r\n?/gu, "\n").split("\n").map(line => {
    if (/^\s*<(?:pre|code|script|style)\b/iu.test(line)) html = true;
    if (html) { if (/<\/(?:pre|code|script|style)>/iu.test(line)) html = false; return ""; }
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (fence === marker[0]) fence = undefined; return ""; }
    return fence || /^(?: {4}|\t)/u.test(line) ? "" : line;
  }).join("\n");
}
function nativeMain(markdown: string): string {
  return withoutCode(markdown).split(/^#{1,3}\s+(?:Les annonces de|Ces annonces peuvent|Annonces similaires|Vous aimerez aussi|Nos recommandations)/imu)[0]!;
}
function section(markdown: string, name: string): string {
  const lines = markdown.split("\n"), start = lines.findIndex(line => normalized(line.replace(/^#{1,6}\s*/u, "")) === name);
  if (start < 0) return "";
  let end = start + 1; while (end < lines.length && !/^#{1,2}\s/u.test(lines[end]!)) end++;
  return lines.slice(start + 1, end).join("\n");
}

/** Repairs only facts explicitly observable in this same listing's saved source response. */
export function repairObservationFromEvidence(observation: ObservationInput, raw: unknown, requestedUrl: string): ObservationInput {
  if (!sameListingEvidenceUrl(observation.url, requestedUrl)) return observation;
  const data = asRecord(asRecord(raw)?.data);
  if (!data) return observation;
  const javascript = asRecord(data.actions)?.javascriptReturns;
  const scripts = (Array.isArray(javascript) ? javascript : []).flatMap(item => {
    let payload = asRecord(item)?.value;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return []; } }
    const value = asRecord(payload);
    return value?.preparation === "leboncoin-detail-repair-v4" && value.phase === "observe" && value.blocked !== true && typeof value.url === "string" && sameListingEvidenceUrl(value.url, requestedUrl) ? [value] : [];
  });
  const sourceUrl = asRecord(data.metadata)?.sourceURL;
  if (typeof sourceUrl === "string" ? !sameListingEvidenceUrl(sourceUrl, requestedUrl) : !scripts.length) return observation;
  let result: ObservationInput = { ...observation, data: { ...observation.data }, missingFields: [...observation.missingFields], absentFields: [...observation.absentFields], evidence: [...observation.evidence], fieldStates: { ...observation.fieldStates } };
  const proof = (text: string): Evidence => ({ url: requestedUrl, kind: "page", text });
  const assertions = new Map<DataField, string>();
  const conflicts = new Set<DataField>();
  const recordState = (field: DataField, status: FieldState["status"], reason: string, text: string, value?: unknown) => {
    const evidence = proof(text);
    if (status !== "unresolved") {
      const signature = JSON.stringify([status, value]);
      if (assertions.has(field) && assertions.get(field) !== signature) conflicts.add(field);
      assertions.set(field, signature);
      if (conflicts.has(field)) { status = "unresolved"; reason = "The saved source contains conflicting explicit values for this field."; }
    }
    result.fieldStates![field] = { status, reason, evidence: [evidence] };
    result.evidence.push(evidence);
    if (status === "unresolved") { result.missingFields = [...new Set([...result.missingFields, field])]; return; }
    result.missingFields = result.missingFields.filter(item => item !== field);
    result.absentFields = result.absentFields.filter(item => item !== field);
    delete result.data[field];
    if (status === "observed") Object.assign(result.data, { [field]: value });
    else if (status === "absent") result.absentFields.push(field);
  };
  const features: string[] = [], featureEvidence: string[] = [];
  const priorFeatures = observation.fieldStates?.features;
  if (priorFeatures && detailFieldStates(observation).features.status === "observed" && Array.isArray(observation.data.features)) {
    features.push(...observation.data.features);
    featureEvidence.push(...priorFeatures.evidence.filter(item => sameListingEvidenceUrl(item.url, requestedUrl)).map(item => item.text));
  }
  const criterion = (label: string, value: string, sourceText = `${label}: ${value}`) => {
    const name = normalized(label), field = criterionNames[name];
    if (!field && amenityCriteria.has(name)) {
      const valid = numericAmenityCriteria.has(name) ? numeric(value) !== undefined : /^(?:individuel|collectif|gaz|fioul|electrique|bois|solaire|pompe a chaleur|aerothermie|geothermie|oui|non)$/u.test(normalized(value));
      if (valid) { features.push(`${label}: ${value}`); featureEvidence.push(sourceText); }
      return;
    }
    if (!field) return;
    if (criterionNames[normalized(value)] || /^(?:voir\b|en savoir plus\b|#{1,6}\s)/iu.test(value.trim())) return;
    const text = `${label}: ${value}`;
    if (explicitFieldAbsence(field, text, "not_applicable")) { recordState(field, "not_applicable", "The source explicitly declares that this field does not apply.", text); return; }
    if (explicitFieldAbsence(field, text, "absent")) { recordState(field, "absent", "The source explicitly declares that this field is not provided.", text); return; }
    if (field === "features") {
      const values = value.split(/[,;\n]/u).map(item => item.replace(/^[-*+]\s+/u, "").trim()).filter(Boolean);
      if (values.length && !values.some(item => /^(?:null|undefined|non renseigne|aucun|en savoir plus)$/iu.test(normalized(item)))) { features.push(...values); featureEvidence.push(sourceText); }
      return;
    }
    const parsed = numericFields.has(field) ? numeric(value) : value.trim();
    if (validFieldValue(field, parsed)) recordState(field, "observed", "Value read from an explicitly labeled source criterion.", `${text}\n${sourceText}`, parsed);
  };

  const description = scrapeDescription(raw);
  result = normalizeScrapeDescription(result, raw, requestedUrl);
  if ((description.state === "expanded" || description.state === "bounded") && description.description) recordState("description", "observed", "The complete bounded Description block was observed in source markdown.", `Description:\n${description.description}`, description.description);
  else if (description.state === "collapsed") recordState("description", "unresolved", "The source Description disclosure is still collapsed.", `Description:\n${description.description ?? ""}\nVoir plus`);

  const markdown = nativeMain(typeof data.markdown === "string" ? data.markdown : "");
  // Read native criterion blocks only; recommendation cards and narrative approximations are excluded.
  for (const block of [section(markdown, "les informations cles"), section(markdown, "diagnostics"), section(markdown, "criteres supplementaires")]) {
    const lines = block.split("\n").map(line => line.trim()).filter(Boolean);
    for (let index = 0; index < lines.length; index++) {
      const label = lines[index]!.replace(/^(?:[-*]\s*)?(?:\*\*)?|\*\*$/gu, "").trim();
      const inline = /^([^:]+):\s*(.+)$/u.exec(label);
      if (inline) { criterion(inline[1]!, inline[2]!); continue; }
      const field = criterionNames[normalized(label)];
      if ((field === "energyClass" || field === "gesClass") && /^[A-G]$/iu.test(lines[index + 1] ?? "") && /^[A-G]$/iu.test(lines[index + 2] ?? "")) { recordState(field, "unresolved", "The raw page lists a diagnostic scale without identifying its selected class.", `${label}\n${lines.slice(index + 1, index + 8).join("\n")}`); continue; }
      if ((field || amenityCriteria.has(normalized(label))) && lines[index + 1]) criterion(label, lines[index + 1]!);
    }
  }
  const sourceDescription = description.state === "expanded" || description.state === "bounded" ? withoutCode(description.description ?? "") : "";
  for (const sentence of narrativeFeatures(sourceDescription)) { features.push(sentence); featureEvidence.push(sentence); }
  for (const line of sourceDescription.split("\n")) {
    const bullet = /^\s*[-*+]\s+(.+)$/u.exec(line);
    if (bullet) { features.push(bullet[1]!.trim()); featureEvidence.push(line.trim()); }
    for (const field of ["energyClass", "gesClass"] as const) {
      if (explicitFieldAbsence(field, line, "not_applicable")) recordState(field, "not_applicable", "The source explicitly declares an exemption for this diagnostic.", line.trim());
      else if (explicitFieldAbsence(field, line, "absent")) recordState(field, "absent", "The source explicitly declares this diagnostic is not provided.", line.trim());
      const label = field === "energyClass" ? "(?:DPE|classe énerg(?:ie|étique))" : "(?:GES|classe climat)";
      const rating = new RegExp(`\\b${label}\\s*[:=–-]?\\s*([A-G])\\b`, "iu").exec(line);
      if (rating && !/\b[A-G](?:\s+[A-G]){1,6}\b/iu.test(line)) criterion(field === "energyClass" ? "DPE" : "GES", rating[1]!.toUpperCase(), line.trim());
    }
  }
  for (const script of scripts) {
    for (const item of Array.isArray(script.criteria) ? script.criteria : []) {
      const entry = asRecord(item);
      if (typeof entry?.label === "string" && typeof entry.value === "string" && (typeof entry.evidence !== "string" || normalized(entry.evidence).includes(normalized(entry.value)))) criterion(entry.label, entry.value, typeof entry.evidence === "string" ? entry.evidence : `${entry.label}: ${entry.value}`);
    }
    const fields = asRecord(script.fields);
    for (const field of ["energyClass", "gesClass"] as const) {
      const entry = asRecord(fields?.[field]);
      if (typeof entry?.evidence !== "string" || typeof entry.selector !== "string" || !entry.selector.trim()) continue;
      if (explicitFieldAbsence(field, entry.evidence, "not_applicable")) recordState(field, "not_applicable", "An explicit diagnostic exemption was observed in the selected source element.", entry.evidence);
      else if (explicitFieldAbsence(field, entry.evidence, "absent")) recordState(field, "absent", "The selected source element explicitly states that the diagnostic is not provided.", entry.evidence);
      else if (entry.selected === true && typeof entry.value === "string" && /^[A-G]$/i.test(entry.value) && fieldLabels[field].test(normalized(entry.evidence)) && new RegExp(`\\b${entry.value}\\b`, "i").test(entry.evidence)) criterion(field === "energyClass" ? "DPE" : "GES", entry.value.toUpperCase(), entry.evidence);
    }
    for (const item of Array.isArray(script.features) ? script.features : []) {
      const entry = asRecord(item);
      if (typeof entry?.value === "string" && entry.value.trim() && typeof entry.evidence === "string" && normalized(entry.evidence).includes(normalized(entry.value))) { features.push(entry.value.trim()); featureEvidence.push(entry.evidence); }
    }
  }
  if (features.length) recordState("features", "observed", "These features retain literal source criteria, authored bullets, or complete amenity sentences; prior proven features are preserved.", `Caractéristiques:\n${featureEvidence.join("\n")}`, [...new Set(features)]);
  result.evidence = [...new Map(result.evidence.map(item => [JSON.stringify(item), item])).values()];
  return result;
}
