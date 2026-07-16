import { MAX_LISTINGS_PER_PAGE } from "./leboncoinSearch";
import type { ListingDetail, ListingSummary, SiteChallenge } from "./types";

const LISTING_PATH_PATTERN =
  /^\/(?:ad\/)?(ventes_immobilieres|locations|colocations|bureaux_commerces|immobilier_neuf)\/(\d{6,20})\/?$/i;
const FRENCH_NUMBER_SOURCE = String.raw`(?<!\d)(?:\d{1,3}(?:[ \u00A0\u202F.]\d{3})+|\d+)(?:,\d+)?`;
const LABEL_VALUE_GAP_SOURCE = String.raw`\s*:?\s*(?:[·|]\s*)?`;
const PRICE_TEXT_PATTERN = new RegExp(`(${FRENCH_NUMBER_SOURCE}\\s*€)`, "iu");
const PRICE_CANDIDATE_PATTERN = new RegExp(`(${FRENCH_NUMBER_SOURCE}\\s*€)`, "giu");
const PRICE_PER_SQUARE_METER_PATTERN = new RegExp(
  `(${FRENCH_NUMBER_SOURCE}\\s*€\\s*(?:par|\\/)\\s*(?:m²|m2|mètres carrés))`,
  "iu",
);
const LAND_SURFACE_PATTERN = new RegExp(
  `(?:Terrain|Surface(?: totale)? du terrain)${LABEL_VALUE_GAP_SOURCE}(${FRENCH_NUMBER_SOURCE})\\s*(?:m²|m2|mètres carrés)`,
  "iu",
);
const SURFACE_PATTERN = new RegExp(
  `(${FRENCH_NUMBER_SOURCE})\\s*(?:m²|m2|mètres carrés)`,
  "giu",
);
const LISTING_LINK_SELECTOR = [
  'a[href*="/ad/"]',
  'a[href*="/ventes_immobilieres/"]',
  'a[href*="/locations/"]',
  'a[href*="/colocations/"]',
  'a[href*="/bureaux_commerces/"]',
  'a[href*="/immobilier_neuf/"]',
].join(",");

const FEATURE_DEFINITIONS: Array<{ label: string; aliases: string[] }> = [
  { label: "Balcon", aliases: ["balcon"] },
  { label: "Terrasse", aliases: ["terrasse"] },
  { label: "Jardin", aliases: ["jardin"] },
  { label: "Parking", aliases: ["parking"] },
  { label: "Garage", aliases: ["garage"] },
  { label: "Cave", aliases: ["cave"] },
  { label: "Ascenseur", aliases: ["ascenseur"] },
  { label: "Piscine", aliases: ["piscine"] },
  { label: "Dernier étage", aliases: ["dernier etage"] },
  { label: "Visite virtuelle", aliases: ["visite virtuelle"] },
  { label: "Plain-pied", aliases: ["plain-pied", "plain pied"] },
  { label: "Meublé", aliases: ["meuble"] },
  { label: "Neuf", aliases: ["neuf"] },
];

export function detectCaptcha(doc: Document = document): boolean {
  return detectSiteChallenge(doc)?.type === "captcha";
}

export function detectSiteChallenge(doc: Document = document): SiteChallenge | undefined {
  const bodyText = doc.body ? extractionText(doc.body).toLowerCase() : "";
  const challengeCopy = visibleChallengeCopy(doc).toLowerCase();
  const visibleDataDomeElement = findVisibleElement(doc,
    [
      'iframe[src*="captcha-delivery" i]',
      'iframe[src*="datadome" i]',
      'iframe[title*="captcha-delivery" i]',
      'iframe[title*="datadome" i]',
    ].join(","),
  );
  const dataDomeScript = doc.querySelector(
    'script[src*="captcha-delivery" i], script[src*="datadome" i]',
  );
  const isolatedDataDomeBootstrap = Boolean(dataDomeScript) &&
    (bodyText.includes("please enable js") || isStandaloneInterstitialFrame(doc, bodyText));
  const restrictionCandidate = RESTRICTION_COPY.find((phrase) => bodyText.includes(phrase));
  const humanVerificationCandidate = HUMAN_VERIFICATION_COPY.find((phrase) => bodyText.includes(phrase));
  const restrictionCopy = restrictionCandidate
    ? findRenderedTextMatch(doc, [restrictionCandidate])
    : undefined;
  const humanVerificationCopy = humanVerificationCandidate
    ? findRenderedTextMatch(doc, [humanVerificationCandidate])
    : undefined;
  const unusualEvidence = challengeCopy.includes("datadome")
    ? "visible-datadome-copy"
    : visibleDataDomeElement
      ? "visible-datadome-frame"
      : isolatedDataDomeBootstrap
        ? "datadome-bootstrap"
        : restrictionCopy
          ? "restriction-copy"
          : undefined;

  if (unusualEvidence) {
    return {
      type: "unusual-activity",
      title: "Unusual activity block",
      message: "LeBonCoin flagged this browser or network. Stop automation and wait before trying again manually.",
      evidence: unusualEvidence,
    };
  }

  if (
    challengeCopy.includes("please enable js") ||
    challengeCopy.includes("captcha") ||
    humanVerificationCopy
  ) {
    return {
      type: "captcha",
      title: "Captcha challenge",
      message: "Captcha detected. Solve it manually, then return to the dashboard and press Resume once.",
      evidence: challengeCopy.includes("captcha") || challengeCopy.includes("please enable js")
        ? "visible-captcha-copy"
        : "human-verification-copy",
    };
  }

  const challengeElement = Array.from(doc.querySelectorAll(
    [
      'iframe[src*="captcha"]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
    ].join(","),
  )).find((element) =>
    isRenderedChallengeElement(element) && isSubstantiveCaptchaSurface(element),
  );

  if (challengeElement) {
    return {
      type: "captcha",
      title: "Captcha challenge",
      message: "Captcha detected. Solve it manually, then return to the dashboard and press Resume once.",
      evidence: challengeElement instanceof HTMLIFrameElement
        ? "visible-captcha-frame"
        : "visible-captcha-element",
    };
  }

  if (isStandaloneInterstitialFrame(doc, bodyText)) {
    return {
      type: "unusual-activity",
      title: "Isolated access interstitial",
      message: "LeBonCoin returned an isolated interstitial. Automation stopped for manual review.",
      evidence: "isolated-interstitial",
    };
  }

  return undefined;
}

function visibleChallengeCopy(doc: Document): string {
  return Array.from(doc.querySelectorAll<HTMLElement>(
    "h1, h2, [role='alert'], [role='dialog'], [aria-live='assertive']",
  ))
    .filter(isRenderedChallengeElement)
    .map((element) => extractionText(element))
    .join(" ");
}

const HUMAN_VERIFICATION_COPY = [
  "vérifiez que vous êtes humain",
  "verifiez que vous etes humain",
] as const;

const RESTRICTION_COPY = [
  "we detected unusual activity",
  "unusual activity from your device or network",
  "access is temporarily restricted",
  "something about the behavior of your browser",
  "accès temporairement restreint",
  "acces temporairement restreint",
  "comportement du navigateur nous a intrigué",
  "comportement du navigateur nous a intrigue",
  "el acceso está restringido temporalmente",
  "el acceso esta restringido temporalmente",
  "comportamiento del navegador nos ha intrigado",
  "automated (bot) activity",
  "rapid taps or clicks",
  "use of developer or inspection tools",
] as const;

function findRenderedTextMatch(
  doc: Document,
  phrases: readonly string[],
): string | undefined {
  if (!doc.body) return undefined;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(doc.body, showText);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !isRenderedChallengeElement(parent)) continue;
    const text = cleanText(parent.textContent ?? "").toLowerCase();
    const phrase = phrases.find((candidate) => text.includes(candidate));
    if (phrase) return phrase;
  }
  return undefined;
}

function isSubstantiveCaptchaSurface(element: Element): boolean {
  if (element instanceof HTMLIFrameElement) return true;

  const accessibleCopy = cleanText([
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    extractionText(element),
  ].filter(Boolean).join(" ")).toLowerCase();
  if (
    accessibleCopy.includes("captcha") ||
    HUMAN_VERIFICATION_COPY.some((phrase) => accessibleCopy.includes(phrase)) ||
    /(?:verify|verification|v[ée]rification).*(?:human|humain)/iu.test(accessibleCopy)
  ) return true;

  return Array.from(element.querySelectorAll(
    'iframe, input, button, [role="checkbox"], [role="dialog"]',
  )).some(isRenderedChallengeElement);
}

function findVisibleElement(doc: Document, selector: string): Element | undefined {
  return Array.from(doc.querySelectorAll(selector)).find((element) =>
    isRenderedChallengeElement(element),
  );
}

function isRenderedChallengeElement(element: Element): boolean {
  return !isHidden(element) &&
    !isCollapsedChallengeElement(element) &&
    intersectsRenderedViewport(element);
}

function intersectsRenderedViewport(element: Element): boolean {
  const viewport = renderedViewport(element.ownerDocument);

  // DOMParser/jsdom do not perform layout, so retain the semantic marker
  // behavior used by deterministic fixtures when the root has no geometry.
  if (!viewport) return true;

  const rect = element.getBoundingClientRect();
  if (
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 1 ||
    rect.height <= 1
  ) return false;

  return rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewport.width &&
    rect.top < viewport.height;
}

function renderedViewport(doc: Document): { width: number; height: number } | undefined {
  const root = doc.documentElement;
  if (!root) return undefined;

  const rootRect = root.getBoundingClientRect();
  if (
    !Number.isFinite(rootRect.width) ||
    !Number.isFinite(rootRect.height) ||
    rootRect.width <= 1 ||
    rootRect.height <= 1
  ) return undefined;

  const view = doc.defaultView;
  const width = view?.innerWidth;
  const height = view?.innerHeight;

  return {
    width: width && width > 1 ? width : rootRect.width,
    height: height && height > 1 ? height : rootRect.height,
  };
}

function isCollapsedChallengeElement(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLIFrameElement) {
    const width = element.getAttribute("width")?.trim();
    const height = element.getAttribute("height")?.trim();
    if (isTinyDimension(width) || isTinyDimension(height)) return true;
  }
  const inlineStyle = element.style;
  if (isTinyDimension(inlineStyle.width) || isTinyDimension(inlineStyle.height)) return true;

  const view = element.ownerDocument.defaultView;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const inline = current.style;
    const style = view?.getComputedStyle(current);
    const tinyWidth = isTinyDimension(inline.width) || isTinyDimension(style?.width);
    const tinyHeight = isTinyDimension(inline.height) || isTinyDimension(style?.height);
    const clipped = isClippedStyle(inline) || (style ? isClippedStyle(style) : false);
    const collapsedOverflow = (tinyWidth || tinyHeight) &&
      [inline.overflow, inline.overflowX, inline.overflowY, style?.overflow, style?.overflowX, style?.overflowY]
        .some((value) => value === "hidden" || value === "clip");
    const offscreen = [inline, style].some((candidate) =>
      Boolean(candidate) &&
      (candidate!.position === "absolute" || candidate!.position === "fixed") &&
      [candidate!.left, candidate!.top].some((value) => Number.parseFloat(value) <= -1_000)
    );
    if (clipped || collapsedOverflow || offscreen) return true;
    if (current === element && (tinyWidth || tinyHeight)) return true;
  }
  return false;
}

function isClippedStyle(style: CSSStyleDeclaration): boolean {
  return (Boolean(style.clipPath) && style.clipPath !== "none") ||
    /rect\(\s*0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?\s*\)/iu.test(style.clip);
}

function isTinyDimension(value: string | undefined): boolean {
  if (!value || value === "auto") return false;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed <= 1;
}

function isStandaloneInterstitialFrame(doc: Document, bodyText: string): boolean {
  const body = doc.body;
  if (!body || bodyText.length > 30) return false;

  return (
    Array.from(body.querySelectorAll("iframe")).filter((frame) =>
      isRenderedChallengeElement(frame)
    ).length === 1 &&
    !body.querySelector('main, article, a[href*="/ad/"]')
  );
}

export function collectListingSummaries(
  doc: Document = document,
  limit = MAX_LISTINGS_PER_PAGE,
): ListingSummary[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_LISTINGS_PER_PAGE, Math.trunc(limit)))
    : MAX_LISTINGS_PER_PAGE;
  const anchors = findSearchRoots(doc).flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(
      (anchor) => isCollectibleListingAnchor(anchor) && !isWithinExcludedRegion(anchor, root),
    ),
  );
  const listingsById = new Map<string, ListingSummary>();
  const baseUrl = safeDocumentUrl(doc);

  for (const anchor of anchors) {
    const url = normalizeListingUrl(anchor.getAttribute("href") ?? anchor.href, baseUrl);
    const id = url ? listingIdFromUrl(url) : undefined;

    if (!url || !id) {
      continue;
    }

    const listing = extractListingSummary(anchor, url, id);

    if (!listing) {
      continue;
    }

    const existing = listingsById.get(id);

    if (existing) {
      listingsById.set(id, mergeListingSummaries(existing, listing));
    } else if (listingsById.size < safeLimit) {
      listingsById.set(id, listing);
    }
  }

  return Array.from(listingsById.values());
}

export function collectListingDetail(doc: Document = document): ListingDetail {
  const root = findDetailRoot(doc);
  const text = extractionText(root);
  const url = normalizeListingUrl(safeDocumentUrl(doc));
  const title = firstCleanText(
    queryText(root, "h1"),
    queryText(doc, "h1"),
    queryText(root, '[data-qa-id*="title" i], [data-testid*="title" i]'),
  );
  const description = firstCleanText(
    queryText(
      root,
      [
        '[data-qa-id="adview_description_container"]',
        '[data-qa-id*="description" i]:not([data-qa-id*="spotlight" i])',
        '[data-testid*="description" i]:not([data-testid*="spotlight" i])',
        '[itemprop="description"]',
      ].join(","),
    ),
  );
  const common = extractCommonFields(text, root);
  const imageUrls = collectDetailImageUrls(root, [getMeta(doc, "og:image")]);

  return {
    id: url ? listingIdFromUrl(url) : undefined,
    url,
    ...common,
    title: title?.slice(0, 240),
    description: description?.slice(0, 5_000),
    imageUrl: imageUrls?.[0],
    imageUrls,
    features: extractFeatures(text),
    rawTextSample: sampleText(text),
  };
}

export function isSearchExtractionReady(
  doc: Document,
  listings: ListingSummary[],
): boolean {
  const roots = findSearchRoots(doc);
  if (listings.length > 0) return true;
  if (roots.some(hasActiveLoadingState)) return false;

  const visibleText = roots.map(extractionText).join(" ").toLowerCase();
  return /\b(?:aucune annonce|aucun résultat|0 annonce)\b/u.test(visibleText);
}

export function isDetailExtractionReady(
  detail: ListingDetail,
  doc: Document = document,
): boolean {
  if (hasActiveLoadingState(findDetailRoot(doc))) return false;

  const independentFacts = [
    detail.priceEuros,
    detail.rooms,
    detail.bedrooms,
    detail.surfaceM2,
    detail.landSurfaceM2,
    detail.location,
    detail.sellerName,
    detail.postedAt,
    detail.description,
  ];
  const independentFactCount = independentFacts.filter((value) => value !== undefined).length;

  return detail.title ? independentFactCount >= 1 : independentFactCount >= 2;
}

export function normalizeListingUrl(href: string, baseUrl?: string): string | undefined {
  let url: URL;

  try {
    url = new URL(href, baseUrl);
  } catch {
    return undefined;
  }

  const pathMatch = url.pathname.match(LISTING_PATH_PATTERN);

  if (
    url.protocol !== "https:" ||
    !isLeboncoinHost(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !pathMatch
  ) {
    return undefined;
  }

  const [, category, id] = pathMatch;
  return `https://www.leboncoin.fr/ad/${category.toLowerCase()}/${id}`;
}

function extractListingSummary(
  anchor: HTMLAnchorElement,
  url: string,
  id: string,
): ListingSummary | undefined {
  const card = findListingCard(anchor);
  const text = card ? extractionText(card) : extractionText(anchor);
  const title = extractTitle(anchor, card, text);

  const common = extractCommonFields(text, card);
  const imageUrls = collectImageUrls(card);

  return {
    source: "leboncoin",
    id,
    url,
    title: title?.slice(0, 240),
    ...common,
    imageUrl: imageUrls?.[0],
    imageUrls,
    features: extractFeatures(text),
    rawTextSample: sampleText(text),
  };
}

function extractCommonFields(text: string, root?: Element) {
  const propertyType = firstMatch(text, /\b(Maison|Appartement|Terrain|Parking|Autre|Loft|Villa|Immeuble)\b/i);
  const rooms = numberMatch(text, /(\d+)\s*pi[eè]ces?/i);
  const bedrooms = numberMatch(
    text,
    /(?:Nombre de chambres?)\s*:?(?:\s*[·|]\s*)?(\d+)(?:\s*ch\.)?/iu,
  ) ?? numberMatch(text, /(\d+)\s*(?:chambres?|ch\.)/i);
  const surfaceM2 = extractSurfaceM2(text);
  const landSurfaceM2 = numberMatch(text, LAND_SURFACE_PATTERN);
  const price = extractPrice(text);

  return {
    priceText: price?.text,
    priceEuros: price?.value,
    pricePerSquareMeterText: firstMatch(text, PRICE_PER_SQUARE_METER_PATTERN),
    propertyType,
    rooms,
    bedrooms,
    surfaceM2,
    landSurfaceM2,
    location: extractLocation(text, root),
    sellerName: extractSellerName(text, root),
    sellerType: firstMatch(text, /\b(Vendeur professionnel|Professionnel|Particulier|Pro)\b/i),
    postedAt: extractPostedAt(text),
    energyClass: extractEnergyGrade(text, root, "energy"),
    gesClass: extractEnergyGrade(text, root, "ges"),
  };
}

function extractTitle(
  anchor: HTMLAnchorElement,
  card: Element | undefined,
  text: string,
): string | undefined {
  const heading = card?.querySelector("h1, h2, h3, h4");
  const headingText = firstCleanText(heading?.textContent);

  if (isSemanticTitle(headingText)) {
    return headingText.replace(/\.$/, "");
  }

  const cardLabel = firstCleanText(
    card?.getAttribute("aria-label"),
    accessibleLabelledBy(card),
  );

  if (isSemanticTitle(cardLabel)) {
    return cardLabel.replace(/\.$/, "");
  }

  const anchorLabel = firstCleanText(
    anchor.getAttribute("aria-label"),
    anchor.getAttribute("title"),
  );

  if (isSemanticTitle(anchorLabel)) {
    return anchorLabel.replace(/\.$/, "");
  }

  const anchorText = firstCleanText(anchor.textContent);

  if (isFallbackTitle(anchorText)) {
    return anchorText.replace(/\.$/, "");
  }

  const lines = text
    .split(/(?<=\.)\s+|\n+/)
    .map(cleanText)
    .filter(Boolean);

  return lines.find(isFallbackTitle);
}

function isSemanticTitle(value: string | undefined): value is string {
  if (!value) return false;

  const title = cleanText(value);
  return (
    title.length >= 3 &&
    title.length <= 240 &&
    !/^(?:image|photo|annonce|annonce leboncoin|sponsoris[ée]e?|voir l['’]annonce|###)$/iu.test(title)
  );
}

function isFallbackTitle(value: string | undefined): value is string {
  return Boolean(
    isSemanticTitle(value) &&
    !PRICE_TEXT_PATTERN.test(value) &&
    !/\b\d+\s*pi[eè]ces?\b|\b\d[\d\s.,]*\s*m²\b/iu.test(value),
  );
}

function mergeListingSummaries(
  existing: ListingSummary,
  incoming: ListingSummary,
): ListingSummary {
  const [preferred, fallback] = summaryCompletenessScore(incoming) > summaryCompletenessScore(existing)
    ? [incoming, existing]
    : [existing, incoming];
  const imageUrls = mergeUniqueStrings(preferred.imageUrls, fallback.imageUrls);

  return {
    source: preferred.source,
    id: preferred.id,
    url: preferred.url,
    title: preferred.title ?? fallback.title,
    priceText: preferred.priceText ?? fallback.priceText,
    priceEuros: preferred.priceEuros ?? fallback.priceEuros,
    pricePerSquareMeterText:
      preferred.pricePerSquareMeterText ?? fallback.pricePerSquareMeterText,
    propertyType: preferred.propertyType ?? fallback.propertyType,
    rooms: preferred.rooms ?? fallback.rooms,
    bedrooms: preferred.bedrooms ?? fallback.bedrooms,
    surfaceM2: preferred.surfaceM2 ?? fallback.surfaceM2,
    landSurfaceM2: preferred.landSurfaceM2 ?? fallback.landSurfaceM2,
    location: preferred.location ?? fallback.location,
    sellerName: preferred.sellerName ?? fallback.sellerName,
    sellerType: preferred.sellerType ?? fallback.sellerType,
    postedAt: preferred.postedAt ?? fallback.postedAt,
    energyClass: preferred.energyClass ?? fallback.energyClass,
    gesClass: preferred.gesClass ?? fallback.gesClass,
    imageUrl: imageUrls?.[0],
    imageUrls,
    features: mergeUniqueStrings(preferred.features, fallback.features) ?? [],
    rawTextSample:
      preferred.rawTextSample.length >= fallback.rawTextSample.length
        ? preferred.rawTextSample
        : fallback.rawTextSample,
  };
}

function summaryCompletenessScore(summary: ListingSummary): number {
  const facts = [
    summary.title,
    summary.priceEuros,
    summary.propertyType,
    summary.rooms,
    summary.bedrooms,
    summary.surfaceM2,
    summary.landSurfaceM2,
    summary.location,
    summary.sellerName,
    summary.sellerType,
    summary.postedAt,
    summary.energyClass,
    summary.gesClass,
  ];

  const sponsoredPenalty = /\bsponsoris[ée]e?\b/iu.test(summary.rawTextSample) ? 1 : 0;
  return facts.filter((value) => value !== undefined).length * 3
    + Math.min(summary.features.length, 3)
    + (summary.imageUrls && summary.imageUrls.length > 0 ? 1 : 0)
    - sponsoredPenalty;
}

function findListingCard(anchor: HTMLAnchorElement): Element | undefined {
  const article = anchor.closest("article");
  if (article && extractionText(article).length > 40) {
    return article;
  }

  const structural = anchor.closest(
    [
      "li",
      '[role="listitem"]',
      '[data-qa-id*="ad" i]',
      '[data-testid*="ad" i]',
      '[data-test-id*="ad" i]',
      '[data-qa-id*="card" i]',
      '[data-testid*="card" i]',
      '[data-test-id*="card" i]',
    ].join(","),
  );

  if (structural && extractionText(structural).length > 40) {
    return structural;
  }

  let node: Element | null = anchor.parentElement;

  for (let depth = 0; node && depth < 16; depth += 1) {
    const text = extractionText(node);

    if (text.length > 60 && /€|pi[eè]ces?|m²|Située à/i.test(text)) {
      return node;
    }

    node = node.parentElement;
  }

  return anchor;
}

function isCollectibleListingAnchor(anchor: HTMLAnchorElement): boolean {
  if (!isHidden(anchor)) return true;

  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    if (isHidden(parent)) return false;
  }

  const rect = anchor.getBoundingClientRect();
  if (
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 1 &&
    rect.height > 1
  ) return true;

  const card = findListingCard(anchor);
  return Boolean(
    card &&
    card !== anchor &&
    !isHidden(card) &&
    extractionText(card).length > 40
  );
}

function extractLocation(text: string, root?: Element): string | undefined {
  if (root) {
    const candidates = root.querySelectorAll(
      [
        '[data-qa-id="adview_spotlight_description_container"] a[aria-label]',
        '[data-qa-id*="location" i][aria-label]',
        '[data-testid*="location" i][aria-label]',
      ].join(","),
    );

    for (const candidate of candidates) {
      if (isHidden(candidate) || isWithinExcludedRegion(candidate, root)) continue;
      const visibleValue = firstCleanText(elementText(candidate));
      const accessibleValue = firstCleanText(candidate.getAttribute("aria-label"));
      const value = visibleValue && /\b\d{5}\b/u.test(visibleValue)
        ? visibleValue
        : accessibleValue;

      if (value && /\b\d{5}\b/u.test(value)) return value;
    }
  }

  const located = firstMatch(
    text,
    /Situ[ée]e?\s+à\s+(?:[·|]\s*)?(.{2,120}?)(?=\s+(?:aujourd['’]hui|hier|publi[ée]e?|vendeur|professionnel|particulier|prix|dpe|ges)\b|[.·|]|$)/iu,
  );

  if (located) {
    return cleanText(located);
  }

  const postalLine = firstMatch(text, /([A-ZÀ-Ÿ][\p{L}'’ -]{1,60}\s+\d{5})\b/u);
  return postalLine ? cleanText(postalLine) : undefined;
}

function extractSellerName(text: string, root?: Element): string | undefined {
  const labelledSeller = firstMatch(
    text,
    /(?:Nom du vendeur|Vendeur)\s*:?\s*(?:[·|]\s*)?([^·|]{2,80}?)(?=\s+(?:[·|]\s*)?(?:Vendeur professionnel|Professionnel|Particulier|Pro)\b|$)/iu,
  );

  if (labelledSeller && !/^(?:professionnel|particulier|pro)$/iu.test(labelledSeller)) {
    return labelledSeller;
  }

  if (!root) return undefined;

  const storeName = root.querySelector(
    '[data-qa-id="pro-store-name"] strong, [data-testid="pro-store-name"] strong',
  );
  const storeValue = firstCleanText(storeName ? elementText(storeName) : undefined);
  if (isSellerName(storeValue)) return storeValue;

  const soldByHeading = Array.from(root.querySelectorAll("h1, h2, h3, h4"))
    .find((heading) => /^Vendu par$/iu.test(elementText(heading)));
  const soldByRoot = soldByHeading?.closest("section, article") ?? soldByHeading?.parentElement;

  if (soldByRoot) {
    for (const candidate of soldByRoot.querySelectorAll("a, strong")) {
      if (isWithinExcludedRegion(candidate, soldByRoot)) continue;
      const value = firstCleanText(elementText(candidate));
      if (isSellerName(value)) return value;
    }
  }

  return undefined;
}

function extractPostedAt(text: string): string | undefined {
  const relative = firstMatch(
    text,
    /\b((?:aujourd['’]hui|hier)(?:\s+à)?\s+\d{1,2}:\d{2})\b/iu,
  );
  if (relative) return relative;

  const spokenDate = text.match(
    /\b(\d{1,2}\s+[\p{L}.'’ -]+\s+\d{4}).{0,80}?\b(\d{1,2})\s+heures?\s+(\d{1,2})\b/iu,
  );
  if (spokenDate) {
    return `${cleanText(spokenDate[1])} à ${spokenDate[2].padStart(2, "0")}:${spokenDate[3].padStart(2, "0")}`;
  }

  return firstMatch(
      text,
      /\b(\d{1,2}\s+[\p{L}.'’ -]+\s+\d{4}\s+à\s+\d{1,2}:\d{2})\b/iu,
    )
    ?? firstMatch(
      text,
      /(?:Date de dépôt|Publi[ée]e?\s+le|Mise? en ligne\s+le)\s*:?\s*(?:[·|]\s*)?((?:le\s+)?\d{1,2}\s+[\p{L}.'’ -]+\s+\d{4}(?:\s+à\s+\d{1,2}:\d{2})?)/iu,
    );
}

function extractEnergyGrade(
  text: string,
  root: Element | undefined,
  kind: "energy" | "ges",
): string | undefined {
  const pattern = kind === "energy"
    ? /(?:classe\s+énergie|\bdpe\b)(?:\s*\(dpe\))?\s*:?\s*(?:[·|]\s*)?([A-G])\b(?![\s·|/,;-]*[A-G]\b)/iu
    : /(?:classe\s+climat|\bges\b)(?:\s*\(ges\))?\s*:?\s*(?:[·|]\s*)?([A-G])\b(?![\s·|/,;-]*[A-G]\b)/iu;

  if (!root) return firstMatch(text, pattern);

  const currentScale = extractCurrentDiagnosticScaleGrade(root, kind);
  if (currentScale.recognized) return currentScale.grade;

  for (const element of root.querySelectorAll("img[alt], [aria-label], [title]")) {
    if (isHidden(element) || isWithinExcludedRegion(element, root)) continue;
    const labels = [
      element.getAttribute("alt"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
    ];
    for (const label of labels) {
      const grade = label ? firstMatch(cleanText(label), pattern) : undefined;
      if (grade) return grade;
    }
  }

  return firstMatch(text, pattern);
}

function extractCurrentDiagnosticScaleGrade(
  root: Element,
  kind: "energy" | "ges",
): { recognized: boolean; grade?: string } {
  const criteriaSelector = kind === "energy"
    ? '[data-qa-id="criteria_item_energy_rate"]'
    : '[data-qa-id="criteria_item_ges"]';
  const valueTitle = kind === "energy" ? "Classe énergie" : "GES";

  for (const criteria of root.querySelectorAll(criteriaSelector)) {
    if (isHidden(criteria) || isWithinExcludedRegion(criteria, root)) continue;
    const value = Array.from(criteria.querySelectorAll<HTMLElement>("[title]"))
      .find((element) => cleanText(element.getAttribute("title") ?? "") === valueTitle);
    if (!value) continue;

    const gradeCandidates = Array.from(value.querySelectorAll<HTMLElement>("div"))
      .filter((element) => /^[A-G]$/iu.test(cleanText(element.textContent ?? "")));
    if (gradeCandidates.length < 2) continue;

    const selected = gradeCandidates.filter((element) => {
      if (isHidden(element)) return false;
      return (
        element.classList.contains("border-solid") &&
        element.classList.contains("drop-shadow-sm")
      ) || element.getAttribute("aria-selected") === "true" ||
        element.getAttribute("aria-current") === "true" ||
        element.getAttribute("data-selected") === "true";
    });

    return {
      recognized: true,
      grade: selected.length === 1
        ? cleanText(selected[0].textContent ?? "").toUpperCase()
        : undefined,
    };
  }

  return { recognized: false };
}

function isSellerName(value: string | undefined): value is string {
  return Boolean(
    value &&
    value.length >= 2 &&
    value.length <= 120 &&
    !/^(?:professionnel|particulier|pro|vendeur professionnel|voir plus)$/iu.test(value),
  );
}

function accessibleLabelledBy(element: Element | undefined): string | undefined {
  const ids = element?.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  const values = ids.map((id) => element?.ownerDocument.getElementById(id)?.textContent);
  return firstCleanText(...values);
}

function extractFeatures(text: string): string[] {
  const normalizedText = removeAccents(text).toLowerCase();
  return FEATURE_DEFINITIONS.filter(({ aliases }) =>
    aliases.some((alias) => hasPositiveFeature(normalizedText, alias)),
  ).map(({ label }) => label);
}

function hasPositiveFeature(normalizedText: string, alias: string): boolean {
  const normalizedAlias = removeAccents(alias).toLowerCase();
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedAlias)}(?=$|[^a-z0-9])`, "gu");

  for (const match of normalizedText.matchAll(pattern)) {
    const aliasIndex = (match.index ?? 0) + match[1].length;
    const prefix = normalizedText.slice(Math.max(0, aliasIndex - 60), aliasIndex);
    const suffix = normalizedText.slice(aliasIndex + normalizedAlias.length, aliasIndex + normalizedAlias.length + 45);
    const negatedBefore = /(?:sans|pas\s+de|aucun(?:e)?|ni|non)\s+(?:[a-z'’-]+\s+){0,2}$/u.test(prefix);
    const negatedAfter = /^\s*(?::|-)?\s*(?:absent(?:e)?|non\s+(?:inclus|compris|disponible))/u.test(suffix);
    const uncertainBefore = /(?:possibilite|projet|option)\s+(?:(?:de|d['’](?:un|une)?)\s+)?$/u.test(prefix);
    const uncertainAfter = /^\s*(?::|-)?\s*(?:en\s+option|optionnel(?:le)?|a\s+proximite|possible|potentiel(?:le)?)/u.test(suffix);

    if (!negatedBefore && !negatedAfter && !uncertainBefore && !uncertainAfter) {
      return true;
    }
  }

  return false;
}

function extractSurfaceM2(text: string): number | undefined {
  const labelledSurface = numberMatch(
    text,
    new RegExp(
      `\\b(?:Surface(?:\\s+habitable)?(?!\\s+du\\s+terrain)|Habitable)${LABEL_VALUE_GAP_SOURCE}(${FRENCH_NUMBER_SOURCE})\\s*(?:m²|m2|mètres carrés)`,
      "iu",
    ),
  ) ?? numberMatch(
    text,
    new RegExp(`(${FRENCH_NUMBER_SOURCE})\\s*(?:m²|m2|mètres carrés)\\s+habitables?\\b`, "iu"),
  );

  if (labelledSurface !== undefined) {
    return labelledSurface;
  }

  const matches = Array.from(text.matchAll(SURFACE_PATTERN));

  for (const match of matches) {
    const before = text.slice(Math.max(0, match.index - 24), match.index).toLowerCase();

    if (!before.includes("par") && !before.includes("/") && !before.includes("terrain")) {
      return parseFrenchNumber(match[1]);
    }
  }

  return undefined;
}

function extractPrice(text: string): { text: string; value: number } | undefined {
  const candidates = Array.from(text.matchAll(PRICE_CANDIDATE_PATTERN))
    .filter((match) => {
      const suffix = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 35);
      return !/^\s*(?:par|\/)\s*(?:m²|m2|mètres carrés)/iu.test(suffix);
    })
    .map((match) => {
      const priceText = cleanText(match[1]);
      const value = parseFrenchNumber(priceText);
      const prefix = text.slice(Math.max(0, (match.index ?? 0) - 35), match.index ?? 0);
      return value === undefined
        ? undefined
        : { text: priceText, value, labelled: /(?:prix|prix de vente)\s*:?\s*(?:[·|]\s*)?$/iu.test(prefix) };
    })
    .filter(isDefined);

  const selected = candidates.find((candidate) => candidate.labelled) ?? candidates[0];
  return selected ? { text: selected.text, value: selected.value } : undefined;
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  return match ? parseFrenchNumber(match[1]) : undefined;
}

function parseFrenchNumber(value: string): number | undefined {
  const compact = value.replace(/[\s\u202f]/g, "").replace(/[^\d,.-]/g, "");
  const commaIndex = compact.lastIndexOf(",");
  const dotIndex = compact.lastIndexOf(".");
  let normalized = compact;

  if (commaIndex !== -1 && dotIndex !== -1) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = compact.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  } else if (commaIndex !== -1) {
    normalized = compact.replaceAll(".", "").replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(compact)) {
    normalized = compact.replaceAll(".", "");
  }

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1] ? cleanText(match[1]) : undefined;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstCleanText(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const cleaned = value ? cleanText(value) : "";

    if (cleaned) {
      return cleaned;
    }
  }

  return undefined;
}

function queryText(root: ParentNode, selector: string): string | undefined {
  for (const element of root.querySelectorAll(selector)) {
    const boundary = root instanceof Element ? root : element.ownerDocument.documentElement;
    if (!isHidden(element) && !isWithinExcludedRegion(element, boundary)) {
      const text = firstCleanText(elementText(element));
      if (text) return text;
    }
  }

  return undefined;
}

function getMeta(doc: Document, key: string): string | undefined {
  return firstCleanText(
    doc.querySelector<HTMLMetaElement>(`meta[property="${key}"]`)?.content,
    doc.querySelector<HTMLMetaElement>(`meta[name="${key}"]`)?.content,
  );
}

function findDetailRoot(doc: Document): Element {
  return Array.from(doc.querySelectorAll("main")).find((main) => !isHidden(main))
    ?? doc.body
    ?? doc.documentElement;
}

function findSearchRoots(doc: Document): Element[] {
  const explicitCandidates = Array.from(doc.querySelectorAll(
    [
      '[data-qa-id*="search-result" i]',
      '[data-testid*="search-result" i]',
      '[data-test-id*="search-result" i]',
      '[aria-label*="résultat" i]',
      '[aria-label*="resultat" i]',
    ].join(","),
  )).filter((candidate) => !isHidden(candidate) && candidate.querySelector(LISTING_LINK_SELECTOR));

  if (explicitCandidates.length > 0) {
    return explicitCandidates.filter((candidate) =>
      !explicitCandidates.some((other) => other !== candidate && other.contains(candidate)),
    );
  }

  return [
    Array.from(doc.querySelectorAll("main")).find((main) => !isHidden(main))
      ?? doc.body
      ?? doc.documentElement,
  ];
}

function extractionText(root: Element): string {
  const chunks: string[] = [];
  const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const blockTags = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BR", "DD", "DIV", "DL", "DT", "FIGCAPTION",
    "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI",
    "MAIN", "NAV", "P", "SECTION", "TABLE", "TD", "TH", "TR", "UL", "OL",
  ]);

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) chunks.push(node.textContent);
      return;
    }

    if (!(node instanceof Element)) return;
    if (ignoredTags.has(node.tagName)) return;
    if (node !== root && (isHidden(node) || isExcludedRegionRoot(node))) return;

    const isBlock = blockTags.has(node.tagName);
    if (isBlock) chunks.push(" | ");
    for (const child of node.childNodes) visit(child);
    if (isBlock) chunks.push(" | ");
  };

  visit(root);
  return cleanText(chunks.join(" ").replace(/(?:\s*\|\s*){2,}/g, " | "));
}

function isWithinExcludedRegion(element: Element, boundary: Element): boolean {
  let current: Element | null = element;

  while (current) {
    if (isExcludedRegionRoot(current)) return true;
    if (current === boundary) return false;
    current = current.parentElement;
  }

  return false;
}

function isExcludedRegionRoot(element: Element): boolean {
  if (element.matches(
    [
      '[data-qa-id*="recommend" i]',
      '[data-testid*="recommend" i]',
      '[data-qa-id*="similar" i]',
      '[data-testid*="similar" i]',
      '[data-qa-id="adview_profile_part_other_ads"]',
      '[aria-label*="recommand" i]',
      '[aria-label*="similaire" i]',
      '[aria-label*="carrousel des annonces du professionnel" i]',
      '[aria-label*="carroussel d’annonces du professionnel" i]',
    ].join(","),
  )) return true;

  if (!element.matches("section, article, aside")) return false;
  const heading = elementText(element.querySelector("h2, h3"));
  return /\b(?:annonces?\s+(?:recommand[ée]es?|similaires?|de\s+ce\s+pro|du\s+professionnel)|vous\s+aimerez|suggestions?)\b/iu.test(heading);
}

function hasActiveLoadingState(root: Element): boolean {
  const loadingSelector = [
    '[aria-busy="true"]',
    '[data-testid*="skeleton" i]',
    '[data-qa-id*="skeleton" i]',
    '[class*="skeleton" i]',
    '[aria-label*="chargement" i]',
    '[aria-label*="loading" i]',
  ].join(",");
  const busyElements = [
    ...(root.matches(loadingSelector) ? [root] : []),
    ...Array.from(root.querySelectorAll(loadingSelector)),
  ];

  if (Array.from(busyElements).some((element) => !isHidden(element))) return true;
  return /\b(?:chargement de l['’]annonce|chargement des annonces|loading listing)\b/iu.test(elementText(root));
}

function isHidden(element: Element): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert], dialog:not([open])')) return true;
  const view = element.ownerDocument.defaultView;
  let current: Element | null = element;

  while (current) {
    const inlineStyle = (current as HTMLElement).style;
    if (
      inlineStyle?.display === "none" ||
      inlineStyle?.visibility === "hidden" ||
      inlineStyle?.opacity === "0" ||
      inlineStyle?.contentVisibility === "hidden"
    ) return true;
    if (view) {
      const style = view.getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      ) return true;
    }
    current = current.parentElement;
  }

  return false;
}

function collectImageUrls(
  root: ParentNode | undefined,
  leadingCandidates: Array<string | null | undefined> = [],
): string[] | undefined {
  if (!root) return mergeUniqueStrings(
    leadingCandidates.map((candidate) => normalizeHttpsUrl(candidate)).filter(isDefined),
  );

  const doc = root instanceof Document ? root : (root as Node).ownerDocument;
  const baseUrl = doc ? safeDocumentUrl(doc) : undefined;
  const candidates: Array<string | null | undefined> = [...leadingCandidates];

  for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
    if (
      isHidden(image) ||
      (root instanceof Element && isWithinExcludedRegion(image, root)) ||
      isNonListingImage(image)
    ) continue;
    candidates.push(
      image.currentSrc,
      image.getAttribute("data-src"),
      image.getAttribute("src"),
      ...srcsetCandidates(image.getAttribute("srcset")),
      ...srcsetCandidates(image.getAttribute("data-srcset")),
    );
  }

  for (const source of root.querySelectorAll<HTMLSourceElement>("picture source")) {
    const pictureImage = source.closest("picture")?.querySelector("img");
    if (
      isHidden(source) ||
      (root instanceof Element && isWithinExcludedRegion(source, root)) ||
      (pictureImage && isNonListingImage(pictureImage))
    ) continue;
    candidates.push(
      ...srcsetCandidates(source.getAttribute("srcset")),
      ...srcsetCandidates(source.getAttribute("data-srcset")),
    );
  }

  return mergeUniqueStrings(
    candidates
      .map((candidate) => normalizeHttpsUrl(candidate, baseUrl))
      .filter(isDefined),
  )?.slice(0, 50);
}

function collectDetailImageUrls(
  root: Element,
  leadingCandidates: Array<string | null | undefined>,
): string[] | undefined {
  const gallerySelector = [
    '[aria-label*="galerie de photos" i]',
    '[aria-label*="photos de l’annonce" i]',
    '[aria-label*="photos de l\'annonce" i]',
    '[data-qa-id*="gallery" i]',
    '[data-testid*="gallery" i]',
    '[data-qa-id="adview_sticky_image"]',
  ].join(",");
  const candidates = Array.from(root.querySelectorAll(gallerySelector))
    .filter((candidate) => !isHidden(candidate) && !isWithinExcludedRegion(candidate, root));
  const galleryRoots = candidates.filter((candidate) =>
    !candidates.some((other) => other !== candidate && other.contains(candidate)),
  );

  if (galleryRoots.length === 0) {
    const visibleImageUrls = collectImageUrls(root);
    if (!visibleImageUrls) return undefined;

    const leading = leadingCandidates
      .map((candidate) => normalizeHttpsUrl(candidate, safeDocumentUrl(root.ownerDocument)))
      .filter(isDefined)
      .filter((candidate) => !isLikelyGenericImageUrl(candidate));
    return mergeUniqueStrings(leading, visibleImageUrls)?.slice(0, 50);
  }

  const leading = leadingCandidates
    .map((candidate) => normalizeHttpsUrl(candidate, safeDocumentUrl(root.ownerDocument)))
    .filter(isDefined)
    .filter((candidate) => !isLikelyGenericImageUrl(candidate));
  return mergeUniqueStrings(
    ...galleryRoots.map((galleryRoot) => collectImageUrls(galleryRoot)),
    leading,
  )?.slice(0, 50);
}

function isLikelyGenericImageUrl(value: string): boolean {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname).toLowerCase();
    return pathname.endsWith(".svg") ||
      /(?:^|[\/_.-])(?:avatar|favicon|icon|logo|placeholder|sprite)(?:[\/_.-]|$)/u.test(pathname);
  } catch {
    return true;
  }
}

function isNonListingImage(image: HTMLImageElement): boolean {
  const alt = cleanText(image.getAttribute("alt") ?? "");
  if (
    /\b(?:avatar|logo|vendeur|seller|dpe|ges|diagnostic|ic[oô]ne|carte|map)\b/iu.test(alt) ||
    /\bclasse\s+(?:énergie|climat)\b/iu.test(alt)
  ) {
    return true;
  }

  return Boolean(image.closest(
    [
      '[aria-label*="vendeur" i]',
      '[aria-label*="seller" i]',
      '[data-qa-id*="seller" i]',
      '[data-testid*="seller" i]',
      '[class*="avatar" i]',
      '[class*="logo" i]',
      '[data-qa-id*="map" i]',
      '[data-testid*="map" i]',
    ].join(","),
  ));
}

function srcsetCandidates(value: string | null): string[] {
  if (!value) return [];
  if (/(?:data|blob):/iu.test(value)) {
    return Array.from(value.matchAll(/https:\/\/[^\s,]+/giu), (match) => match[0]);
  }

  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter(isDefined);
}

function normalizeHttpsUrl(
  value: string | null | undefined,
  baseUrl?: string,
): string | undefined {
  if (!value || value.length > 2_048) return undefined;

  try {
    const url = new URL(value, baseUrl);
    const normalized = url.toString();
    return url.protocol === "https:" && normalized.length <= 2_048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function elementText(element: Element | undefined | null): string {
  if (!element) {
    return "";
  }

  return cleanText((element as HTMLElement).innerText || element.textContent || "");
}

function sampleText(text: string): string {
  return cleanText(text).slice(0, 1200);
}

export function listingIdFromUrl(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(LISTING_PATH_PATTERN)?.[2];
  } catch {
    return undefined;
  }
}

function isLeboncoinHost(hostname: string): boolean {
  return hostname === "leboncoin.fr" || hostname === "www.leboncoin.fr";
}

function safeDocumentUrl(doc: Document): string {
  const href = doc.location?.href;

  if (href && href !== "about:blank") return href;

  const explicitBaseUrl = doc.querySelector<HTMLBaseElement>("base[href]")?.href;
  if (explicitBaseUrl) return explicitBaseUrl;

  return "https://www.leboncoin.fr/";
}

function removeAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeUniqueStrings(...groups: Array<string[] | undefined>): string[] | undefined {
  const values = Array.from(new Set(groups.flatMap((group) => group ?? [])));
  return values.length > 0 ? values : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
