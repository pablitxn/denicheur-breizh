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
const nativeAttributeLabels: Record<string, string> = { square: "Surface habitable", land_plot_surface: "Surface totale du terrain", rooms: "Nombre de pièces", bedrooms: "Nombre de chambres", real_estate_type: "Type de bien", energy_rate: "DPE", ges: "GES", specificities: "Caractéristiques", outside_access: "Extérieur", nb_bathrooms: "Nombre de salles de bain", nb_shower_room: "Nombre de salles d'eau", nb_floors_building: "Nombre d’étages dans l’immeuble", floor_number: "Étage de votre bien", nb_parkings: "Places de parking", heating_type: "Type de chauffage", heating_mode: "Mode de chauffage", elevator: "Ascenseur" };
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

function htmlText(fragment: string): string {
  return fragment.replace(/<[^>]*>/gu, " ").replace(/&(?:nbsp|euro|amp|lt|gt|quot);|&#(?:x[0-9a-f]+|[0-9]+);/giu, entity => {
    const named: Record<string, string> = { "&nbsp;": " ", "&euro;": "€", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const code = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/gu, " ").trim();
}

/** Read only the listing's exact price selector, between its sole title and Description. */
function nativeHeaderPrices(html: string): number[] {
  const clean = html.replace(/<!--[\s\S]*?-->|<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, "");
  const headings = [...clean.matchAll(/<h1\b[^>]*>[\s\S]*?<\/h1>/giu)];
  if (headings.length !== 1) return [];
  const start = headings[0]!.index! + headings[0]![0].length;
  const afterTitle = clean.slice(start), boundary = [...afterTitle.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/giu)].find(match => /^(?:description|ces annonces peuvent vous interesser|annonces similaires|vous aimerez aussi|nos recommandations)$/u.test(normalized(htmlText(match[1]!))));
  if (!boundary || normalized(htmlText(boundary[1]!)) !== "description") return [];
  const header = afterTitle.slice(0, boundary.index), prices: number[] = [];
  for (const opening of header.matchAll(/<(div|section|p)\b[^>]*\bdata-qa-id\s*=\s*(["'])adview_price\2[^>]*>/giu)) {
    const contentStart = opening.index! + opening[0].length, tail = header.slice(contentStart);
    const tags = new RegExp(`<\\/?${opening[1]}\\b[^>]*>`, "giu");
    let depth = 1, end: number | undefined;
    for (const tag of tail.matchAll(tags)) { depth += tag[0].startsWith("</") ? -1 : 1; if (!depth) { end = tag.index; break; } }
    if (end === undefined) continue;
    const block = tail.slice(0, end), text = normalized(htmlText(block));
    if (/\b(?:financement|mensualite|par mois|honoraires|frais|acompte)\b|\/mois/u.test(text)) continue;
    const amounts = opening[1]!.toLowerCase() === "p" ? [block] : [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)].map(match => match[1]!);
    for (const amount of amounts) { const text = htmlText(amount); if (/^[\d\s.,]+\s*€$/u.test(text)) { const value = numeric(text); if (value !== undefined) prices.push(value); } }
  }
  return [...new Set(prices)];
}

const validImageUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
};
const imageIdentity = (value: string): string => {
  const url = new URL(value);
  return url.hostname === "img.leboncoin.fr" && /^\/api\/v1\/lbcpb1\/images\//u.test(url.pathname) ? `${url.origin}${url.pathname}` : url.href;
};
const wholeCount = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const inventoryMarkers = ["leboncoin-native-inventory-v5", "leboncoin-gallery-audit-v6", "leboncoin-gallery-walk-v7"];
function unresolvedInventory(observation: ObservationInput): ObservationInput {
  const evidence: Evidence = { url: observation.url, kind: "trace", text: "Collector inventory audit: no valid matching native image inventory was observed in this response. No gallery completeness or source absence is asserted." };
  return { ...observation, data: { ...observation.data }, missingFields: [...new Set([...observation.missingFields, "imageUrls" as const])], absentFields: observation.absentFields.filter(field => field !== "imageUrls"),
    evidence: [...observation.evidence, evidence], fieldStates: { ...observation.fieldStates, imageUrls: { status: "unresolved", reason: "The requested native gallery audit produced no matching image inventory; model URLs are retained as partial observations, not a complete gallery.", evidence: [evidence] } } };
}

/** Native active state is authoritative even when missing CSS breaks layout; unmarked slides require viewport proof. */
function matchingActiveSlide(value: unknown, position: number | null): boolean {
  const evidence = asRecord(value), viewport = asRecord(evidence?.viewport), slide = asRecord(evidence?.slide);
  const rectangle = (rect: Record<string, unknown> | null | undefined) => rect && [rect.left, rect.top, rect.right, rect.bottom].every(value => typeof value === "number" && Number.isFinite(value)) && Number(rect.right) > Number(rect.left) && Number(rect.bottom) > Number(rect.top);
  if (position === null || !evidence || evidence.position !== position || evidence.dataIndex !== position - 1 || evidence.matchedSlides !== 1 || evidence.inert !== false || ![null, "false"].includes(evidence.ariaHidden as null | string) || evidence.ariaCurrent === "false" || evidence.dataState === "inactive") return false;
  if (evidence.ariaHidden === "false" || evidence.ariaCurrent === "true" || evidence.dataState === "active") return true;
  if (!rectangle(viewport) || !rectangle(slide)) return false;
  const centerX = (Number(slide!.left) + Number(slide!.right)) / 2, centerY = (Number(slide!.top) + Number(slide!.bottom)) / 2;
  return centerX >= Number(viewport!.left) && centerX <= Number(viewport!.right) && centerY >= Number(viewport!.top) && centerY <= Number(viewport!.bottom);
}

/** Recognize the native agency card from intact saved HTML, never from a modal-wide contact label. */
function savedBusinessCard(value: unknown, position: number | null, listingId: unknown) {
  const active = asRecord(value);
  if (!matchingActiveSlide(active, position) || active?.htmlTruncated !== false || typeof active.html !== "string" || typeof active.selector !== "string" || typeof listingId !== "string" || !/^\d+$/u.test(listingId)) return null;
  const html = active.html.replace(/<!--[\s\S]*?-->|<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu, "");
  const attribute = (tag: string, name: string) => { const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "iu").exec(tag); return match ? htmlText(match[2]!) : null; };
  const outer = /^\s*<div\b[^>]*>/iu.exec(html)?.[0];
  if (!outer || attribute(outer, "data-index") !== String(position! - 1) || attribute(outer, "aria-hidden") === "true" || /\s(?:inert|hidden)(?:\s|=|>)/iu.test(outer)) return null;
  const cards = [...html.matchAll(/<div\b[^>]*>/giu)].filter(match => attribute(match[0], "data-qa-id") === "business-card-slide");
  if (cards.length !== 1) return null;
  const start = cards[0]!.index! + cards[0]![0].length, tail = html.slice(start);
  let depth = 1, end: number | undefined;
  for (const tag of tail.matchAll(/<\/?div\b[^>]*>/giu)) { depth += tag[0].startsWith("</") ? -1 : 1; if (!depth) { end = tag.index; break; } }
  if (end === undefined) return null;
  const card = tail.slice(0, end);
  // Inactive descendants or other media cannot prove that the current slot is a contact card only.
  for (const tag of html.matchAll(/<([a-z][\w-]*)\b[^>]*>/giu)) {
    if (["video", "iframe", "picture", "source", "canvas"].includes(tag[1]!.toLowerCase())) return null;
    if (tag[1]!.toLowerCase() !== "img" && (attribute(tag[0], "aria-hidden") === "true" || /\s(?:inert|hidden)(?:\s|=|>)/iu.test(tag[0]) || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attribute(tag[0], "style") ?? ""))) return null;
  }
  const base = "https://www.leboncoin.fr";
  const logo = (value: string) => {
    try {
      let url = new URL(value, base);
      if (url.origin === base && url.pathname === "/_next/image") url = new URL(url.searchParams.get("url") ?? "");
      return url.protocol === "https:" && !url.username && !url.password && url.hostname === "img.leboncoin.fr" && url.searchParams.get("rule") === "bo-logo";
    } catch { return false; }
  };
  for (const image of html.matchAll(/<img\b[^>]*>/giu)) {
    const src = attribute(image[0], "src"), srcset = attribute(image[0], "srcset");
    const candidates = [src, attribute(image[0], "data-src"), ...(srcset ? srcset.split(",").map(item => item.trim().split(/\s/u)[0]!) : [])].filter((item): item is string => item !== null);
    if (!src || !candidates.every(logo)) return null;
  }
  for (const background of htmlText(html.replace(/<[^>]*>/gu, match => attribute(match, "style") ?? "")).matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    try { const url = new URL(background[1]!, base); if (url.origin !== base || !url.pathname.startsWith("/_next/static/media/")) return null; } catch { return null; }
  }
  const links = [...card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)];
  if (links.length !== 1 || normalized(htmlText(links[0]![2]!)) !== "contacter" || attribute(links[0]![1]!, "aria-disabled") === "true") return null;
  try {
    const href = attribute(links[0]![1]!, "href"); if (!href) return null;
    const reply = new URL(href, base);
    if (reply.origin !== base || reply.username || reply.password || reply.pathname !== `/reply/${listingId}` || reply.search || reply.hash) return null;
    return { kind: "contact", text: "Contacter", selector: active.selector, businessCard: { selector: '[data-qa-id="business-card-slide"]', replyUrl: reply.href, linkText: "Contacter" }, origin: "Collector audit of this active slide's intact saved native HTML" };
  } catch { return null; }
}

/** A counter enumerates slots, so each slot needs its own photo or explicit non-photo proof. */
function galleryWalk(audits: Record<string, unknown>[], nativeUrls: string[]) {
  const photos = new Map(nativeUrls.map(url => [imageIdentity(url), url]));
  const restored = audits.filter(audit => audit.stage === "restored" && audit.closed === true && audit.restoredDetail === true);
  let trustworthy = restored.length > 0;
  const notes: string[] = [];
  const signatures = new Set<string>();
  for (const audit of restored.length ? restored : audits) {
    const walk = asRecord(audit.walk), total = wholeCount(walk?.declaredTotal);
    const positions = Array.isArray(walk?.positions) ? walk.positions : [], visited = Array.isArray(walk?.visitedPositions) ? walk.visitedPositions : [];
    let valid = audit.openedByOwnControl === true && audit.dialogFound === true && audit.closed === true && audit.restoredDetail === true && audit.stage === "restored" && walk?.complete === true && walk.stopReason === "all_positions_observed" && total !== null && total > 0 && positions.length === total && visited.length === total && visited.every((position, index) => position === index + 1);
    const observedPhotos = new Set<string>();
    let nonPhotos = 0;
    for (const [index, item] of positions.entries()) {
      const position = asRecord(item), current = wholeCount(position?.position);
      const counter = typeof position?.counterText === "string" ? /^(?:(?:Photo|Image)\s*)?([0-9]+)\s*(?:\/|sur|of)\s*([0-9]+)$/iu.exec(position.counterText.trim()) : null;
      valid &&= current === index + 1 && position?.total === total && Boolean(counter && Number(counter[1]) === current && Number(counter[2]) === total);
      const active = Array.isArray(position?.activeImages) ? position.activeImages : [];
      const values = active.map(image => asRecord(image)?.url);
      const urls = values.filter(validImageUrl);
      const identities = new Set(urls.map(imageIdentity));
      const activeSlide = position?.activeSlideEvidence;
      const businessCard = active.length === 0 ? savedBusinessCard(activeSlide, current, audit.listingId) : null;
      const kinds = Array.isArray(position?.mediaKinds) ? [...position.mediaKinds] : [];
      if (businessCard && !kinds.includes("contact")) kinds.push("contact");
      const proof = businessCard ?? asRecord(position?.nonPhotoEvidence);
      const indexedSlide = matchingActiveSlide(activeSlide, current);
      const scopeValid = activeSlide === undefined || indexedSlide;
      const selector = typeof proof?.selector === "string" ? proof.selector : "";
      const explicitActive = /\[(?:aria-current\s*=\s*["']?true|data-state\s*=\s*["']?active|aria-hidden\s*=\s*["']?false)["']?\]/u.test(selector);
      const selectorIndex = /\[data-index\s*=\s*["']?([0-9]+)["']?\]/u.exec(selector);
      const indexedActive = indexedSlide && selectorIndex !== null && Number(selectorIndex[1]) === current! - 1;
      valid &&= scopeValid;
      const contact = active.length === 0 && kinds.includes("contact") && kinds.every(kind => kind === "contact") && proof?.kind === "contact" && typeof proof.text === "string" && (businessCard !== null || /\b(?:contacter le vendeur|envoyer un message|cette annonce vous interesse)\b/u.test(normalized(proof.text))) && (explicitActive || indexedActive);
      if (contact) nonPhotos++;
      else if (active.length && identities.size === 1 && values.every(validImageUrl) && kinds.every(kind => kind === "photo") && kinds.includes("photo")) {
        const identity = [...identities][0]!;
        valid &&= !observedPhotos.has(identity) && active.every(image => {
          const value = asRecord(image), alt = typeof value?.alt === "string" ? value.alt : "";
          const labeled = /\b(?:image|photo)\s*([0-9]+)/iu.exec(alt);
          return !/[?&]rule=(?:ad-thumb|bo-thumb)/iu.test(String(value?.url)) && (!labeled || Number(labeled[1]) === current);
        });
        observedPhotos.add(identity);
      } else valid = false;
      for (const url of urls) if (!photos.has(imageIdentity(url))) photos.set(imageIdentity(url), url);
      notes.push(`Position ${current ?? "unknown"}/${position?.total ?? "unknown"}: counter=${JSON.stringify(position?.counterText)}; media=${JSON.stringify(kinds)}; active-slide proof=${JSON.stringify(activeSlide ?? null)}; non-photo proof=${JSON.stringify(proof ?? null)}. Active image URLs:\n${urls.join("\n")}`);
    }
    valid &&= observedPhotos.size > 0 && observedPhotos.size + nonPhotos === total && nativeUrls.every(url => observedPhotos.has(imageIdentity(url)));
    trustworthy &&= valid;
    signatures.add(JSON.stringify([...observedPhotos].sort()));
    notes.push(`Collector gallery walk audit: stop=${String(walk?.stopReason)}; observed positions=${positions.length}; declared slots=${total ?? "unknown"}; distinct photos=${observedPhotos.size}; explicit non-photo slots=${nonPhotos}; identity/position/closure checks=${valid}.`);
  }
  if (!audits.length) notes.push("Collector gallery walk audit: no matching saved traversal; completeness remains unresolved.");
  return { complete: trustworthy && signatures.size === 1, urls: [...photos.values()], text: notes.join("\n") };
}

/** Repairs only facts explicitly observable in this same listing's saved source response. */
export function repairObservationFromEvidence(observation: ObservationInput, raw: unknown, requestedUrl: string, options: { nativeInventory?: boolean } = {}): ObservationInput {
  if (!sameListingEvidenceUrl(observation.url, requestedUrl)) return observation;
  const data = asRecord(asRecord(raw)?.data);
  if (!data) return options.nativeInventory === true ? unresolvedInventory(observation) : observation;
  const javascript = asRecord(data.actions)?.javascriptReturns;
  const sourceScripts = (Array.isArray(javascript) ? javascript : []).flatMap(item => {
    let payload = asRecord(item)?.value;
    if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { return []; } }
    const value = asRecord(payload);
    return value ? [value] : [];
  });
  const ownScript = (value: Record<string, unknown>) => value.blocked !== true && typeof value.url === "string" && sameListingEvidenceUrl(value.url, requestedUrl);
  const requiresInventory = options.nativeInventory === true || (options.nativeInventory !== false && sourceScripts.some(value => inventoryMarkers.includes(String(value.preparation)) && value.phase === "observe" && typeof value.url === "string" && sameListingEvidenceUrl(value.url, requestedUrl)));
  const scripts = sourceScripts.filter(value => ["leboncoin-detail-repair-v4", ...(options.nativeInventory === false ? [] : inventoryMarkers)].includes(String(value.preparation)) && value.phase === "observe" && ownScript(value));
  const sourceUrl = asRecord(data.metadata)?.sourceURL;
  if (typeof sourceUrl === "string" ? !sameListingEvidenceUrl(sourceUrl, requestedUrl) : !scripts.length) return requiresInventory ? unresolvedInventory(observation) : observation;
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
  const nativeImages: Array<{ urls: string[]; complete: boolean; expected: number | null; text: string; version: string; headerCount: number | null }> = [];
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
  const headerPrices = nativeHeaderPrices(typeof data.html === "string" ? data.html : "");
  for (const price of headerPrices) recordState("priceEuros", "observed", "Price read from the listing header's exact adview_price element, before Description.", `Prix: ${price} €; source selector [data-qa-id="adview_price"] beneath this listing's H1.`, price);

  const markdown = nativeMain(typeof data.markdown === "string" ? data.markdown : "");
  const sourceTitles = [...markdown.matchAll(/^#\s+(.+)$/gmu)];
  if (sourceTitles.length === 1) {
    const heading = sourceTitles[0]!, tail = markdown.slice(heading.index! + heading[0].length), descriptionStart = /^##\s+Description\s*$/imu.exec(tail);
    if (descriptionStart) for (const link of tail.slice(0, descriptionStart.index).matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/gu)) {
      if (!/\b\d{5}\b/u.test(link[1]!)) continue;
      try { if (new URL(link[2]!).hash === "#map" && sameListingEvidenceUrl(link[2]!, requestedUrl)) recordState("location", "observed", "Location read from this listing header's own map link.", `Localisation: ${link[1]}; source link ${link[2]}`, link[1]); } catch { /* A malformed link proves no location. */ }
    }
  }
  const sellerBlock = section(markdown, "vendu par");
  for (const link of sellerBlock.matchAll(/^\[([^\[\]\n]+)\]\((https:\/\/[^\s)]+)\)\s*$/gmu)) {
    try {
      const target = new URL(link[2]!);
      if (["leboncoin.fr", "www.leboncoin.fr"].includes(target.hostname) && /^\/boutique\/\d+\//u.test(target.pathname) && !target.username && !target.password && validFieldValue("sellerName", link[1])) recordState("sellerName", "observed", "Seller name read from the bounded native Vendu par section.", `Nom du vendeur: ${link[1]}; Vendu par source link ${link[2]}`, link[1]);
    } catch { /* Unrelated profile links cannot identify this seller. */ }
  }
  for (const badge of sellerBlock.matchAll(/^(Pro)(?=N[°º]\s*SIRET|\s*$)|^(Particulier)\s*$/gmu)) {
    const value = badge[1] ?? badge[2]!;
    recordState("sellerType", "observed", "Seller type read from the explicit badge in the bounded Vendu par section.", `Type de vendeur: ${value}; source Vendu par badge: ${badge[0]}`, value);
  }
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
    if (inventoryMarkers.includes(String(script.preparation))) {
      const inventory = asRecord(script.inventory);
      const id = /\/([0-9]+)(?:\.htm)?\/?$/u.exec(new URL(requestedUrl).pathname)?.[1];
      if (id && String(script.listingId) === id && String(inventory?.listingId) === id) {
        if (typeof inventory?.title === "string" && validFieldValue("title", inventory.title)) recordState("title", "observed", "Title read from the matching current listing's public native inventory.", `Titre: ${inventory.title}; current listing ${id}, __NEXT_DATA__.props.pageProps.ad.subject.`, inventory.title);
        for (const item of Array.isArray(inventory?.attributes) ? inventory.attributes : []) {
          const attribute = asRecord(item);
          if (typeof attribute?.key !== "string") continue;
          const value = typeof attribute.value_label === "string" && attribute.value_label.trim() ? attribute.value_label : attribute.value;
          if (attribute.key === "store_name" && typeof value === "string" && validFieldValue("sellerName", value)) recordState("sellerName", "observed", "Seller name read from the current listing's explicit store_name attribute.", `Nom du vendeur: ${value}; current listing ${id}, native attribute store_name.`, value);
          const label = nativeAttributeLabels[attribute.key];
          if (label && typeof value === "string") {
            if (attribute.key === "real_estate_type" && !["Maison", "Appartement", "Terrain", "Autre"].includes(value)) continue;
            criterion(label, ["energy_rate", "ges"].includes(attribute.key) ? value.toUpperCase() : value, `${label}: ${value}; current listing ${id}, native attribute ${attribute.key}.`);
          }
        }
        const price = inventory?.price;
        const prices = Array.isArray(price) ? price : [price];
        const unique = [...new Set(prices)];
        if (unique.length === 1 && typeof unique[0] === "number" && Number.isFinite(unique[0]) && unique[0] >= 0) recordState("priceEuros", "observed", "Price read from the matching current listing's public native inventory.", `Prix: ${unique[0]} €; current listing ${id}, __NEXT_DATA__.props.pageProps.ad.price.`, unique[0]);
        const images = asRecord(inventory?.images), gallery = asRecord(inventory?.galleryControl);
        if (Array.isArray(images?.urls)) {
          const urls = [...new Set(images.urls.filter(validImageUrl))];
          const expected = wholeCount(images.declaredCount), galleryCount = wholeCount(gallery?.declaredCount);
          const complete = images.inventoryComplete === true && images.urls.every(validImageUrl) && expected !== null && expected > 0 && urls.length === expected && images.observedCount === urls.length && (gallery?.observed !== true || galleryCount === expected);
          nativeImages.push({ urls, complete, expected, version: String(script.preparation), headerCount: galleryCount, text: `Images: current listing ${id}; complete native inventory=${complete}; declared=${expected ?? "unknown"}; recovered unique URLs=${urls.length}; gallery button=${galleryCount ?? "unknown"}.\n${urls.join("\n")}` });
        }
      }
    }
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
  if (nativeImages.length) {
    let urls = [...new Set(nativeImages.flatMap(item => item.urls))];
    const expected = new Set(nativeImages.map(item => item.expected));
    let complete = nativeImages.every(item => item.complete) && expected.size === 1 && nativeImages[0]!.expected === urls.length;
    let text = nativeImages.map(item => item.text).join("\n"), reason = "Every image in the matching listing's complete native gallery inventory was recovered and its declared count matched.";
    const id = /\/([0-9]+)(?:\.htm)?\/?$/u.exec(new URL(requestedUrl).pathname)?.[1];
    if (nativeImages.some(item => item.version === "leboncoin-gallery-walk-v7")) {
      complete &&= new Set(urls.map(imageIdentity)).size === urls.length;
      const audits = sourceScripts.filter(value => value.preparation === "leboncoin-gallery-walk-v7" && value.phase === "gallery" && ownScript(value) && String(value.listingId) === id);
      // Complete native inventories need no modal; an actual traversal still takes precedence over that earlier claim.
      if (!complete || audits.some(audit => audit.openedByOwnControl === true)) {
        const walk = galleryWalk(audits, urls);
        complete = walk.complete; urls = walk.urls; text += `\n${walk.text}`;
        reason = "Every gallery position was observed with a stable counter and matching listing identity; all distinct photos were recovered, and any non-photo slot has its own explicit source evidence. The detail page was restored.";
      }
    } else if (nativeImages.some(item => item.version === "leboncoin-gallery-audit-v6")) {
      complete = false;
      const savedAudits = sourceScripts.filter(value => value.preparation === "leboncoin-gallery-audit-v6" && value.phase === "gallery" && ownScript(value) && String(value.listingId) === id);
      const restored = savedAudits.filter(value => value.stage === "restored" && value.closed === true && value.restoredDetail === true);
      const audits = restored.length ? restored : savedAudits;
      if (audits.length) {
        const counts = new Set<number>(), auditUrls: string[] = [];
        let trustworthy = true;
        for (const audit of audits) {
          const counters = Array.isArray(audit.counters) ? audit.counters : [];
          const localCounts = new Set<number>();
          const mixedMedia = Array.isArray(audit.mediaKinds) && audit.mediaKinds.some(kind => typeof kind === "string" && /video|iframe|map|plan/iu.test(kind));
          for (const item of counters) {
            const counter = asRecord(item), total = wholeCount(counter?.total), current = wholeCount(counter?.current);
            if (total !== null && total > 0 && (counter?.kind === "photo-count" || (!mixedMedia && counter?.kind === "position" && current !== null && current > 0 && current <= total))) localCounts.add(total);
          }
          const images = Array.isArray(audit.images) ? audit.images : [], values = images.map(item => asRecord(item)?.url);
          const valid = values.filter(validImageUrl); auditUrls.push(...valid);
          trustworthy &&= audit.openedByOwnControl === true && audit.dialogFound === true && audit.stage === "restored" && audit.closed === true && audit.restoredDetail === true && values.every(validImageUrl) && localCounts.size === 1;
          for (const count of localCounts) counts.add(count);
          text += `\nCollector gallery audit: opened by this listing's control=${audit.openedByOwnControl === true}; dialog found=${audit.dialogFound === true}; closed=${audit.closed === true}; counters=${JSON.stringify(counters)}; media kinds=${JSON.stringify(audit.mediaKinds ?? [])}.\n${valid.join("\n")}`;
        }
        const photos = new Map<string, string>();
        for (const value of [...urls, ...auditUrls]) if (!photos.has(imageIdentity(value))) photos.set(imageIdentity(value), value);
        urls = [...photos.values()];
        const modalTotal = counts.size === 1 ? [...counts][0]! : null;
        complete = trustworthy && modalTotal !== null && modalTotal === urls.length && nativeImages.every(item => item.expected === null || item.expected <= modalTotal);
        reason = "Every distinct photo was recovered from the matching native inventory and the explicitly opened gallery; its actual dialog count matches. Original header-counter differences remain recorded in evidence.";
        text += `\nGallery reconciliation: ${urls.length} distinct photo identities; dialog total=${modalTotal ?? "ambiguous"}; original header counts=${JSON.stringify(nativeImages.map(item => item.headerCount))}; no inferred extra image. URL delivery variants are retained above.`;
      } else text += "\nCollector gallery audit: no matching saved modal observation; completeness remains unresolved.";
    }
    if (complete) recordState("imageUrls", "observed", reason, text, urls);
    else {
      result.data.imageUrls = urls;
      result.absentFields = result.absentFields.filter(field => field !== "imageUrls");
      recordState("imageUrls", "unresolved", "The native image inventory is incomplete, invalid, or disagrees with its declared gallery count; recovered URLs are retained.", text);
    }
  } else if (requiresInventory) {
    result = unresolvedInventory(result);
  }
  if (features.length) recordState("features", "observed", "These features retain literal source criteria, authored bullets, or complete amenity sentences; prior proven features are preserved.", `Caractéristiques:\n${featureEvidence.join("\n")}`, [...new Set(features)]);
  result.evidence = [...new Map(result.evidence.map(item => [JSON.stringify(item), item])).values()];
  return result;
}
