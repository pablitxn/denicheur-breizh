import type { ObservationInput } from "@denicheur-breizh/collector-contracts";
import { asRecord } from "./http.js";

export const SOURCE_DESCRIPTION_COLLAPSED = "source_description_collapsed:";

export interface ScrapeDescription {
  state: "expanded" | "bounded" | "collapsed" | "unbounded" | "unavailable";
  description: string | null;
  sourceUrl?: string;
}

function sameListingUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left), b = new URL(right);
    return a.protocol === "https:" && b.protocol === "https:" && a.hostname.replace(/^www\./u, "") === b.hostname.replace(/^www\./u, "") && a.pathname.replace(/\/$/u, "") === b.pathname.replace(/\/$/u, "");
  } catch { return false; }
}

/** Markdown controls inside code are source text, never navigation boundaries. */
function structuralLines(lines: readonly string[]): boolean[] {
  let fence: { character: string; length: number } | undefined;
  let htmlCode: string | undefined;
  return lines.map(line => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
      if (closing && closing[0] === fence.character && closing.length >= fence.length) fence = undefined;
      return false;
    }
    if (htmlCode) { if (new RegExp(`</${htmlCode}>`, "iu").test(line)) htmlCode = undefined; return false; }
    const htmlStart = /^\s*<(pre|code|script|style)\b/iu.exec(line)?.[1];
    if (htmlStart) { if (!new RegExp(`</${htmlStart}>`, "iu").test(line)) htmlCode = htmlStart; return false; }
    const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (opening) { fence = { character: opening[0]!, length: opening.length }; return false; }
    return !/^(?: {4}|\t)/u.test(line);
  });
}

function disclosure(line: string): "expanded" | "collapsed" | undefined {
  // The real detail page may put its visit CTA and the disclosure on the same line.
  const control = line.trim().replace(/^\[(?:Demander une visite|Contacter|Envoyer un message|Appeler)\]\(https:\/\/(?:www\.)?leboncoin\.fr\/[^\n]*?\)\s*/iu, "");
  const match = /^(?:\*\*)?(?:Voir\s+(plus|moins)|\[Voir\s+(plus|moins)\]\([^\n]*\))(?:\*\*)?\s*$/iu.exec(control);
  return match ? (match[1] ?? match[2])?.toLowerCase() === "plus" ? "collapsed" : "expanded" : undefined;
}

/** Recover the complete observed Description block, with no character or paragraph limit. */
export function scrapeDescription(raw: unknown): ScrapeDescription {
  const data = asRecord(asRecord(raw)?.data);
  const markdown = data?.markdown;
  const sourceUrl = asRecord(data?.metadata)?.sourceURL;
  const identity = typeof sourceUrl === "string" ? { sourceUrl } : {};
  if (typeof markdown !== "string") return { state: "unavailable", description: null, ...identity };
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const structural = structuralLines(lines);
  const descriptionHeading = /^\s*(#{1,6}\s+)?(?:\*\*|__)?Description(?:\*\*|__)?\s*:?\s*$/iu;
  const start = lines.findIndex((line, index) => structural[index] && descriptionHeading.test(line));
  if (start < 0) return { state: "unavailable", description: null, ...identity };
  const headingLevel = descriptionHeading.exec(lines[start]!)?.[1]?.trim().length;
  const content: string[] = [];
  const finish = (state: ScrapeDescription["state"]): ScrapeDescription => ({ state, description: content.join("\n").trim() || null, ...identity });
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (structural[index]) {
      const control = disclosure(line);
      if (control) return finish(control);
      const heading = /^\s*(#{1,6})\s+/u.exec(line)?.[1];
      const label = line.trim().replace(/^#{1,6}\s+/u, "").replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)\s*$/u, "$1").trim();
      const nativeSection = /^(?:Les informations cl[ée]s|Diagnostics|Localisation|Vendu par|Le vendeur|Annonces similaires|Ces annonces peuvent vous int[ée]resser|Vous aimerez aussi|Nos recommandations)\s*:?\s*$/iu.test(label);
      // Internal headings are part of the authored description. Native peer sections end it.
      if ((nativeSection && (!heading || !headingLevel || heading.length <= headingLevel)) || /^(?:Passer la liste des m[ée]dias|Liste des m[ée]dias)/iu.test(label)) return finish("bounded");
    }
    content.push(line);
  }
  return finish("unbounded");
}

/** Inspect the observed document independently of the model's structured completeness claim. */
export function scrapeEvidenceWarnings(raw: unknown, fallbackUrl?: string): string[] {
  const extracted = scrapeDescription(raw);
  if (extracted.state !== "collapsed") return [];
  const sourceUrl = extracted.sourceUrl ?? fallbackUrl;
  return [`${SOURCE_DESCRIPTION_COLLAPSED} ${sourceUrl ? `[${sourceUrl}] ` : ""}Firecrawl source markdown still shows the Description disclosure (Voir plus); the full description was not observed.`];
}

/** Repair only this response's description; preserve other gaps and the provider's status. */
export function normalizeScrapeDescription<T extends ObservationInput>(observation: T, raw: unknown, fallbackUrl?: string): T {
  const extracted = scrapeDescription(raw);
  const sourceUrl = extracted.sourceUrl ?? fallbackUrl;
  if (!sourceUrl || !sameListingUrl(sourceUrl, observation.url)) return observation;
  if (extracted.state === "collapsed") return { ...observation, missingFields: [...new Set([...observation.missingFields, "description" as const])] };
  if ((extracted.state !== "expanded" && extracted.state !== "bounded") || !extracted.description) return observation;
  return {
    ...observation, data: { ...observation.data, description: extracted.description },
    missingFields: observation.missingFields.filter(field => field !== "description"),
    absentFields: observation.absentFields.filter(field => field !== "description"),
  };
}

/** Run-level warnings must not invalidate a different listing or an unrelated description. */
export function hasCollapsedDescription(warnings: readonly string[], url: string): boolean {
  return warnings.some(warning => {
    if (!warning.startsWith(SOURCE_DESCRIPTION_COLLAPSED)) return false;
    const target = /^\s*\[([^\]]+)\]/u.exec(warning.slice(SOURCE_DESCRIPTION_COLLAPSED.length))?.[1];
    if (!target) return true;
    return sameListingUrl(target, url);
  });
}
