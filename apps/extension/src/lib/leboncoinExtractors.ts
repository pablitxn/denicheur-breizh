import type { ListingDetail, ListingSummary, SiteChallenge } from "./types";

const LISTING_PATH_PATTERN =
  /\/(?:ad\/)?(?:ventes_immobilieres|locations|colocations|bureaux_commerces|immobilier_neuf)\/[A-Za-z0-9_-]+/i;

const KNOWN_FEATURES = [
  "Balcon",
  "Terrasse",
  "Jardin",
  "Parking",
  "Garage",
  "Cave",
  "Ascenseur",
  "Piscine",
  "Dernier etage",
  "Dernier étage",
  "Visite virtuelle",
  "Plain-pied",
  "Meuble",
  "Meublé",
  "Neuf",
];

export function detectCaptcha(doc: Document = document): boolean {
  return detectSiteChallenge(doc)?.type === "captcha";
}

export function detectSiteChallenge(doc: Document = document): SiteChallenge | undefined {
  const bodyText = cleanText(doc.body?.innerText ?? doc.body?.textContent ?? "").toLowerCase();

  if (
    bodyText.includes("we detected unusual activity") ||
    bodyText.includes("unusual activity from your device or network") ||
    bodyText.includes("automated (bot) activity") ||
    bodyText.includes("rapid taps or clicks") ||
    bodyText.includes("use of developer or inspection tools")
  ) {
    return {
      type: "unusual-activity",
      title: "Unusual activity block",
      message: "LeBonCoin flagged this browser or network. Stop automation and wait before trying again manually.",
    };
  }

  if (
    bodyText.includes("please enable js") ||
    bodyText.includes("captcha") ||
    bodyText.includes("datadome") ||
    bodyText.includes("vérifiez que vous êtes humain") ||
    bodyText.includes("verifiez que vous etes humain")
  ) {
    return {
      type: "captcha",
      title: "Captcha challenge",
      message: "Solve the challenge in the active tab before resuming.",
    };
  }

  const challengeElement = doc.querySelector(
    [
      'iframe[src*="captcha"]',
      'iframe[src*="datadome"]',
      '[id*="captcha" i]',
      '[class*="captcha" i]',
      'script[src*="captcha-delivery"]',
    ].join(","),
  );

  if (challengeElement) {
    return {
      type: "captcha",
      title: "Captcha challenge",
      message: "Solve the challenge in the active tab before resuming.",
    };
  }

  return undefined;
}

export function collectListingSummaries(
  doc: Document = document,
  limit = 20,
): ListingSummary[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.trunc(limit))) : 20;
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"));
  const seen = new Set<string>();
  const listings: ListingSummary[] = [];
  const baseUrl = safeDocumentUrl(doc);

  for (const anchor of anchors) {
    const url = normalizeListingUrl(anchor.getAttribute("href") ?? anchor.href, baseUrl);

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    listings.push(extractListingSummary(anchor, url));

    if (listings.length >= safeLimit) {
      break;
    }
  }

  return listings;
}

export function collectListingDetail(doc: Document = document): ListingDetail {
  const text = cleanText(doc.body?.innerText ?? doc.body?.textContent ?? "");
  const metaTitle = getMeta(doc, "og:title");
  const title = firstCleanText(
    queryText(doc, 'h1, [data-qa-id*="title" i], [data-testid*="title" i]'),
    metaTitle,
    doc.title,
  );
  const description = firstCleanText(
    queryText(
      doc,
      [
        '[data-qa-id*="description" i]',
        '[data-testid*="description" i]',
        '[itemprop="description"]',
        "section",
      ].join(","),
    ),
    getMeta(doc, "description"),
  );
  const common = extractCommonFields(text);

  return {
    ...common,
    title: title?.slice(0, 240),
    description: description?.slice(0, 5_000),
    imageUrl: normalizeHttpsUrl(getMeta(doc, "og:image")) ?? firstImage(doc),
    features: extractFeatures(text),
    rawTextSample: sampleText(text),
  };
}

export function normalizeListingUrl(href: string, baseUrl?: string): string | undefined {
  let url: URL;

  try {
    url = new URL(href, baseUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || !isLeboncoinHost(url.hostname) || !LISTING_PATH_PATTERN.test(url.pathname)) {
    return undefined;
  }

  url.hostname = "www.leboncoin.fr";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function extractListingSummary(anchor: HTMLAnchorElement, url: string): ListingSummary {
  const card = findListingCard(anchor);
  const text = cleanText(elementText(card) || elementText(anchor));
  const title = extractTitle(anchor, card, text) ?? "Annonce leboncoin";
  const common = extractCommonFields(text);

  return {
    source: "leboncoin",
    id: listingIdFromUrl(url),
    url,
    title: title.slice(0, 240),
    ...common,
    imageUrl: firstImage(card),
    features: extractFeatures(text),
    rawTextSample: sampleText(text),
  };
}

function extractCommonFields(text: string) {
  const propertyType = firstMatch(text, /\b(Maison|Appartement|Terrain|Parking|Autre|Loft|Villa|Immeuble)\b/i);
  const rooms = numberMatch(text, /(\d+)\s*pi[eè]ces?/i);
  const bedrooms = numberMatch(text, /(\d+)\s*chambres?/i);
  const surfaceM2 = extractSurfaceM2(text);
  const landSurfaceM2 = numberMatch(
    text,
    /(?:Terrain|Surface du terrain)\s*:?\s*(\d[\d\s.,]*)\s*(?:m²|m2|mètres carrés)/i,
  );

  return {
    priceText: firstMatch(text, /(\d[\d\s\u202f.]*\s*€)/),
    priceEuros: numberMatch(text, /(\d[\d\s\u202f.]*)\s*€/),
    pricePerSquareMeterText: firstMatch(
      text,
      /(\d[\d\s\u202f.]*\s*€\s*(?:par|\/)\s*(?:m²|m2|mètres carrés))/i,
    ),
    propertyType,
    rooms,
    bedrooms,
    surfaceM2,
    landSurfaceM2,
    location: extractLocation(text),
    sellerName: extractSellerName(text),
    sellerType: firstMatch(text, /\b(Vendeur professionnel|Particulier|Pro)\b/i),
    postedAt: firstMatch(text, /Date de dépôt\s*:?\s*([^.]*)/i) ?? firstMatch(text, /\b(aujourd’hui à \d{1,2}:\d{2})\b/i),
    energyClass: firstMatch(text, /Classe énergie\s*([A-G])/i) ?? firstMatch(text, /\bDPE\s*([A-G])\b/i),
    gesClass: firstMatch(text, /\bGES\s*([A-G])\b/i),
  };
}

function extractTitle(
  anchor: HTMLAnchorElement,
  card: Element | undefined,
  text: string,
): string | undefined {
  const anchorLabel = firstCleanText(
    anchor.getAttribute("aria-label"),
    anchor.getAttribute("title"),
    anchor.textContent,
  );

  if (anchorLabel && !/^image$/i.test(anchorLabel)) {
    return anchorLabel.replace(/\.$/, "");
  }

  const heading = card?.querySelector("h1, h2, h3, h4");
  const headingText = firstCleanText(heading?.textContent);

  if (headingText && headingText !== "###") {
    return headingText.replace(/\.$/, "");
  }

  const lines = text
    .split(/(?<=\.)\s+|\n+/)
    .map(cleanText)
    .filter(Boolean);

  return lines.find((line) => {
    return (
      line.length > 10 &&
      line.length < 120 &&
      !line.includes("Prix:") &&
      !line.includes("Située à") &&
      !line.includes("Date de dépôt") &&
      !/^\d[\d\s\u202f.]*\s*€/.test(line)
    );
  });
}

function findListingCard(anchor: HTMLAnchorElement): Element | undefined {
  const structural = anchor.closest(
    [
      "article",
      "li",
      '[data-qa-id*="ad" i]',
      '[data-testid*="ad" i]',
      '[data-test-id*="ad" i]',
    ].join(","),
  );

  if (structural && elementText(structural).length > 40) {
    return structural;
  }

  let node: Element | null = anchor.parentElement;

  for (let depth = 0; node && depth < 7; depth += 1) {
    const text = elementText(node);

    if (text.length > 60 && /€|pi[eè]ces?|m²|Située à/i.test(text)) {
      return node;
    }

    node = node.parentElement;
  }

  return anchor;
}

function extractLocation(text: string): string | undefined {
  const located = firstMatch(text, /Situ[ée]e?\s+à\s+([^.]*)/i);

  if (located) {
    return cleanText(located);
  }

  const postalLine = firstMatch(text, /([A-ZÀ-ÿ][A-Za-zÀ-ÿ' -]{2,}\s+\d{5}(?:\s+[A-Za-zÀ-ÿ' -]+)?)/);
  return postalLine ? cleanText(postalLine) : undefined;
}

function extractSellerName(text: string): string | undefined {
  const lines = text
    .split(/\n+|(?<=\.)\s+/)
    .map(cleanText)
    .filter(Boolean);
  const sellerLine = lines.find((line) => /Vendeur professionnel|Particulier|Pro/.test(line));

  if (!sellerLine) {
    return undefined;
  }

  return cleanText(
    sellerLine
      .replace(/Date de dépôt\s*:?.*/i, "")
      .replace(/\baujourd’hui à \d{1,2}:\d{2}\b/i, "")
      .replace(/\b(Vendeur professionnel|Particulier|Pro)\b/gi, ""),
  );
}

function extractFeatures(text: string): string[] {
  const normalizedText = removeAccents(text).toLowerCase();
  const features = KNOWN_FEATURES.filter((feature) =>
    normalizedText.includes(removeAccents(feature).toLowerCase()),
  ).map((feature) => (feature === "Dernier etage" ? "Dernier étage" : feature));

  return Array.from(new Set(features));
}

function extractSurfaceM2(text: string): number | undefined {
  const typedSurface = numberMatch(
    text,
    /\b(?:Maison|Appartement|Terrain|Autre|Loft|Villa|Immeuble)\b[\s\S]{0,100}?(\d[\d\s.,]*)\s*(?:m²|m2|mètres carrés)/i,
  );

  if (typedSurface !== undefined) {
    return typedSurface;
  }

  const matches = Array.from(text.matchAll(/(\d[\d\s.,]*)\s*(?:m²|m2|mètres carrés)/gi));

  for (const match of matches) {
    const before = text.slice(Math.max(0, match.index - 24), match.index).toLowerCase();

    if (!before.includes("par") && !before.includes("/") && !before.includes("terrain")) {
      return parseFrenchNumber(match[1]);
    }
  }

  return undefined;
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

function queryText(doc: Document, selector: string): string | undefined {
  return firstCleanText(doc.querySelector(selector)?.textContent);
}

function getMeta(doc: Document, key: string): string | undefined {
  return firstCleanText(
    doc.querySelector<HTMLMetaElement>(`meta[property="${key}"]`)?.content,
    doc.querySelector<HTMLMetaElement>(`meta[name="${key}"]`)?.content,
  );
}

function firstImage(root: ParentNode | undefined): string | undefined {
  if (!root) {
    return undefined;
  }

  const image = root.querySelector<HTMLImageElement>("img[src]");
  return normalizeHttpsUrl(image?.src);
}

function normalizeHttpsUrl(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function elementText(element: Element | undefined | null): string {
  if (!element) {
    return "";
  }

  return cleanText((element as HTMLElement).innerText ?? element.textContent ?? "");
}

function sampleText(text: string): string {
  return cleanText(text).slice(0, 1200);
}

export function listingIdFromUrl(url: string): string {
  let idFromPath: string | undefined;

  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const candidate = segments.at(-1);
    if (candidate && /^[A-Za-z0-9_-]{6,}$/.test(candidate)) {
      idFromPath = candidate;
    }
  } catch {
    idFromPath = undefined;
  }

  if (idFromPath) {
    return idFromPath;
  }

  let hash = 0;

  for (const char of url) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return `lbc-${hash.toString(36)}`;
}

function isLeboncoinHost(hostname: string): boolean {
  return hostname === "leboncoin.fr" || hostname === "www.leboncoin.fr";
}

function safeDocumentUrl(doc: Document): string {
  const href = doc.location?.href;

  if (!href || href === "about:blank") {
    return "https://www.leboncoin.fr/";
  }

  return href;
}

function removeAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
