import { describe, expect, it } from "vitest";
import { detailGaps } from "../capture-quality.js";
import { hasCollapsedDescription, normalizeScrapeDescription, scrapeDescription, scrapeEvidenceWarnings, SOURCE_DESCRIPTION_COLLAPSED } from "./scrape-quality.js";
import type { ObservationInput } from "@denicheur-breizh/collector-contracts";

const url = "https://www.leboncoin.fr/ad/ventes_immobilieres/123";
const raw = (markdown: string) => ({ success: true, data: { markdown, metadata: { sourceURL: url } } });

describe("Firecrawl observed description disclosure", () => {
  it("rejects a model's full-detail assertion when raw Description still has Voir plus, even without JSON ellipsis", () => {
    const warnings = scrapeEvidenceWarnings(raw("## Description\n\nMaison avec jardin…\n\nVoir plus\n\n## Les informations clés\nMaison"));
    expect(warnings[0]).toMatch(/^source_description_collapsed:/);
    expect(detailGaps({ url, data: { description: "The model removed the ellipsis." }, detailStatus: "captured", missingFields: [], absentFields: [], evidence: [] }, ["description"], warnings)).toEqual(["description"]);
  });
  it.each(["Voir plus", "**Voir plus**", "[Voir plus](#description)"])("detects the observed %s control after a plain Description heading", control => {
    expect(scrapeEvidenceWarnings(raw(`Description\n\nA partial description\n\n${control}\n\nPasser la liste des médiasListe des médias`))).toHaveLength(1);
  });
  it("ignores disclosures in another section, normal description prose, and absent markdown", () => {
    expect(scrapeEvidenceWarnings(raw("## Description\n\nComplete description.\n\n## Vendu par\n\nVoir plus"))).toEqual([]);
    expect(scrapeEvidenceWarnings(raw("Description\n\nComplete description.\n\nPasser la liste des médiasListe des médias\n\nVoir plus"))).toEqual([]);
    expect(scrapeEvidenceWarnings(raw("## Description\n\nPour voir plus de photos, contactez..."))).toEqual([]);
    expect(scrapeEvidenceWarnings({ success: true, data: {} })).toEqual([]);
  });
  it("scopes run-level warnings to the observed listing and uses the dispatch URL when metadata omits it", () => {
    const warnings = scrapeEvidenceWarnings({ data: { markdown: "Description\n\nPartial\n\nVoir plus" } }, `${url}?tracking=1`);
    expect(hasCollapsedDescription(warnings, url)).toBe(true);
    expect(hasCollapsedDescription(warnings, `${url}4`)).toBe(false);
    expect(hasCollapsedDescription([`${SOURCE_DESCRIPTION_COLLAPSED} [invalid] bad URL`], url)).toBe(false);
  });
});

describe("same-response source description normalization", () => {
  const observation = (): ObservationInput => ({url,data:{description:"A short model summary.",title:"House"},detailStatus:"failed",missingFields:["description","landSurfaceM2"],absentFields:["description"],evidence:[]});
  it("preserves every paragraph of a long expanded description and excludes its visit CTA, gallery and recommendations", () => {
    const description=`Appartement 3 pièces\n\n${"A fully observed authored paragraph with details omitted by the model.\n\n".repeat(600)}Surface : 71 m²\nMontant estimé des dépenses annuelles : 990 € à 1390 €.`;
    const source=raw(`## Description\n\n${description}\n\n[Demander une visite](https://www.leboncoin.fr/reply/123?action=requestVisit) Voir moins\n\nPasser la liste des médiasListe des médias\n\n![](https://img.leboncoin.fr/gallery.jpg)Photos (12)\n\n## Annonces similaires\nUnrelated house.`);
    const result=normalizeScrapeDescription(observation(),source);
    expect(result.data.description).toBe(description);
    expect(result.data.description!.length).toBeGreaterThan(40000);
    expect(result.data.title).toBe("House");
    expect(result.detailStatus).toBe("failed");
    expect(result.missingFields).toEqual(["landSurfaceM2"]);
    expect(result.absentFields).toEqual([]);
    expect(scrapeDescription(source).state).toBe("expanded");
  });
  it("preserves internal headings, code examples and embedded Voir plus prose without mistaking them for controls", () => {
    const description="House\n\n## Authored section\nUseful text; voir plus de détails in this paragraph.\n\n### Diagnostics\nAuthored diagnostic details.\n\n```html\n## Les informations clés\nVoir plus\n<script>\n```\n\n<pre>\nVoir moins\n</pre>\n\n    Voir plus\n\n`Voir plus`\n\nThe final authored paragraph.";
    const source=raw(`~~~markdown\n## Description\nWrong preamble\nVoir plus\n~~~\n\n## Description\n\n${description}\n\nVoir moins\n\n## Les informations clés\nIgnored native fields.`);
    expect(scrapeDescription(source)).toMatchObject({state:"expanded",description});
    expect(scrapeEvidenceWarnings(source)).toEqual([]);
  });
  it("uses a bounded naturally short description and stops at native sections instead of including captions", () => {
    const description="An observed short description.\n\n### Features\nA useful internal subheading.";
    expect(scrapeDescription(raw(`## Description\n\n${description}\n\n## Les informations clés\nPrice and room fields.\n\nVoir plus`))).toMatchObject({state:"bounded",description});
    expect(scrapeDescription(raw("Description\n\nShort complete text.\n\nPasser la liste des médiasListe des médias\nPhoto caption"))).toMatchObject({state:"bounded",description:"Short complete text."});
  });
  it("keeps collapsed evidence incomplete rather than promoting an abbreviated model description", () => {
    const source=raw("## Description\n\nObserved partial description.\n\nVoir plus\n\n## Diagnostics\nOther fields.");
    const input={...observation(),missingFields:[]};
    const result=normalizeScrapeDescription(input,source);
    expect(result.data.description).toBe(input.data.description);
    expect(result.missingFields).toEqual(["description"]);
    expect(scrapeDescription(source)).toMatchObject({state:"collapsed",description:"Observed partial description."});
  });
  it("does not copy a foreign listing or treat an unterminated fragment as a complete raw description", () => {
    const input=observation();
    const foreign={data:{metadata:{sourceURL:`${url}4`},markdown:"## Description\n\nOther listing text.\n\nVoir moins"}};
    expect(normalizeScrapeDescription(input,foreign,url)).toBe(input);
    const unbounded=raw("## Description\n\nA fragment without a native ending boundary.");
    expect(scrapeDescription(unbounded).state).toBe("unbounded");
    expect(normalizeScrapeDescription(input,unbounded)).toBe(input);
    expect(normalizeScrapeDescription(input,{data:{markdown:"## Description\n\nObserved full description.\n\nVoir moins"}},url).data.description).toBe("Observed full description.");
  });
});
