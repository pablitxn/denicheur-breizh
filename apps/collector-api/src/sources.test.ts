import {describe,expect,it} from "vitest";
import {captureRequestSchema} from "@denicheur-breizh/collector-contracts";
import {canonicalIdentity,leboncoinSource,pageKey,validateSourceRequest} from "./sources.js";
import {readConfig} from "./config.js";

describe("source and storage boundaries",()=>{
  const request=captureRequestSchema.parse({name:"Search",source:"leboncoin",provider:"xai",mode:"search",filters:{location:"Rennes"}});
  it("uses stable source + native identity despite provider/tracking variation",()=>{
    const a=canonicalIdentity("leboncoin","https://www.leboncoin.fr/ad/ventes_immobilieres/12345?tracking=abc");
    const b=canonicalIdentity("leboncoin","https://leboncoin.fr/ventes_immobilieres/12345.htm");
    expect(a.id).toBe(b.id);expect(a.externalId).toBe("12345");expect(a.url).not.toContain("tracking");
  });
  it("rejects off-source URLs and missing listing identities",()=>{
    for(const url of ["https://leboncoin.fr.evil.example/ad/123","https://www.leboncoin.fr/recherche","https://localhost/ad/123","https://www.leboncoin.fr/compte/123","https://www.leboncoin.fr/recherche/123","https://www.leboncoin.fr/ad/123","https://www.leboncoin.fr/ad/ventes_immobilieres/123/extra"]){expect(()=>canonicalIdentity("leboncoin",url)).toThrow();}
    expect(()=>validateSourceRequest({...request,searchUrl:"https://other.example/recherche"})).toThrow();
  });
  it("normalizes page identity without removing search criteria",()=>{
    expect(pageKey("https://www.leboncoin.fr/recherche?z=2&a=1#top")).toBe(pageKey("https://www.leboncoin.fr/recherche?a=1&z=2"));
    expect(pageKey("https://www.leboncoin.fr/recherche?page=1")).not.toBe(pageKey("https://www.leboncoin.fr/recherche?page=2"));
    expect(pageKey("https://www.leboncoin.fr/recherche?page=2&ref_id=random-one&utm_source=agent")).toBe(pageKey("https://www.leboncoin.fr/recherche?page=2&ref_id=random-two"));
  });
  it("keeps provider context bounded while retaining unlimited persisted discovery",()=>{
    const ids=Array.from({length:10000},(_,i)=>String(1000000000+i));
    const work={id:"page",kind:"discover" as const,urls:[],cursor:"Continue native pages"};
    const prompt=leboncoinSource.instructions(request,work,ids);
    expect(prompt.length).toBeLessThan(6000);expect(prompt).toContain("10000 total persisted");expect(prompt).toContain(ids.at(-1));
    expect(leboncoinSource.instructions(request,{...work,kind:"details"},ids)).not.toContain("Recent discovered");
  });
  it("isolates defaults and rejects the main API storage directory",()=>{
    const config=readConfig({});expect(config.dbPath).toContain("collector-api/.data/collector.sqlite");
    expect(config.xaiBudget).toBe(25);expect(config.firecrawlBudget).toBe(5000);expect(config.port).toBe(4315);
    expect(()=>readConfig({COLLECTOR_DATA_DIR:config.dataDirectory.replace("collector-api","api")})).toThrow(/main API/);
    expect(()=>readConfig({COLLECTOR_XAI_EXPIRES_AT:"sometime"})).toThrow();
  });
  it("keeps v3 preparation immutable and exposes separate v4 preparation and observed evidence",()=>{
    expect(leboncoinSource.detailPreparationScript).toContain("leboncoin-expand-description-v1");
    expect(leboncoinSource.detailPreparationScript).not.toContain("criteria_item_energy_rate");
    expect(leboncoinSource.detailRepairScript).toContain("additionalCriteria");
    expect(leboncoinSource.detailRepairEvidenceScript).toContain("drop-shadow-sm");
    const v4=captureRequestSchema.parse({...request,provider:"firecrawl",strategy:"firecrawl-detail-repair-v4",mode:"urls",urls:["https://www.leboncoin.fr/ad/ventes_immobilieres/123"]});
    expect(leboncoinSource.instructions(v4,{id:"repair",kind:"details",urls:v4.urls,repairFields:["gesClass"]},[])).toContain("exemption in fieldStates");
    expect(leboncoinSource.instructions(v4,{id:"discovery",kind:"discover",urls:[]},[])).not.toContain("exemption in fieldStates");
  });
});
