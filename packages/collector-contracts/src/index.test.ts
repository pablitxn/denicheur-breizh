import {describe,expect,it} from "vitest";
import {captureRequestSchema,listingDataSchema,observationInputSchema,observationSchema,referenceImportSchema,repairRequestSchema,searchFiltersSchema,workItemSchema} from "./index.js";

describe("collector contracts",()=>{
  it("keeps native inventory v5 explicit and preserves independent historical v4 requests",()=>{
    const base={name:"Native inventory",provider:"firecrawl",mode:"urls",urls:["https://www.leboncoin.fr/ad/ventes_immobilieres/123"]};
    for(const strategy of ["firecrawl-detail-repair-v4","firecrawl-native-inventory-v5","firecrawl-gallery-audit-v6", "firecrawl-gallery-walk-v7"]){
      expect(captureRequestSchema.parse({...base,strategy}).strategy).toBe(strategy);
      expect(()=>captureRequestSchema.parse({...base,provider:"xai",strategy})).toThrow();
    }
    expect(captureRequestSchema.parse(base).strategy).toBeUndefined();
  });
  it("accepts complete collections beyond extension and image limits without truncation",()=>{
    const urls=Array.from({length:1101},(_,i)=>`https://www.leboncoin.fr/ad/ventes_immobilieres/${10000+i}`);
    expect(captureRequestSchema.parse({name:"Full source",provider:"xai",mode:"urls",urls}).urls).toEqual(urls);
    const data={description:"A complete description. ".repeat(10000),imageUrls:urls};
    expect(listingDataSchema.parse(data)).toEqual(data);
  });
  it("rejects incompatible filters instead of silently dropping them",()=>{
    expect(()=>searchFiltersSchema.parse({unsupportedSiteFilter:true})).toThrow();
    expect(()=>searchFiltersSchema.parse({priceMin:100,priceMax:50})).toThrow();
  });
  it("requires usable search input and public HTTPS URLs",()=>{
    expect(()=>captureRequestSchema.parse({name:"Empty",provider:"xai",mode:"search"})).toThrow();
    for(const url of ["http://www.leboncoin.fr/ad/1","https://key:secret@www.leboncoin.fr/ad/1"]){
      expect(()=>captureRequestSchema.parse({name:"Bad URL",provider:"firecrawl",mode:"urls",urls:[url]})).toThrow();
    }
  });
  it("does not infer a verified reference from an imported collection",()=>{
    const result=referenceImportSchema.parse({name:"Imported",capturedAt:new Date().toISOString(),records:[{url:"https://www.leboncoin.fr/ad/1"}]});
    expect(result.complete).toBe(false);expect(result.notes).toBe("");expect(result.records[0]?.detailStatus).toBe("pending");
  });
  it("preserves optional per-field status, reason, evidence and source time without changing legacy observations",()=>{
    const legacy={url:"https://www.leboncoin.fr/ad/ventes_immobilieres/123",data:{energyClass:null},absentFields:[]};
    expect(observationInputSchema.parse(legacy).fieldStates).toBeUndefined();
    const fieldStates={energyClass:{status:"not_applicable",reason:"Explicit source exemption",observedAt:"2026-09-12T18:00:00+02:00",evidence:[{url:legacy.url,text:"DPE non soumis",kind:"page"}]}};
    expect(observationInputSchema.parse({...legacy,fieldStates}).fieldStates).toEqual(fieldStates);
    for(const fieldStates of [{unknown:{status:"unresolved",reason:"Missing",evidence:[]}},{energyClass:null},{energyClass:{status:"absent",reason:"",evidence:[]}},{energyClass:{status:"guessed",reason:"Guess",evidence:[]}}])expect(()=>observationInputSchema.parse({...legacy,fieldStates})).toThrow();
  });
  it("validates immutable targeted repairs and accepts an unlimited target collection",()=>{
    const urls=Array.from({length:501},(_,i)=>`https://www.leboncoin.fr/ad/ventes_immobilieres/${1000+i}`);
    const targets=urls.map((_,i)=>({listingId:`leboncoin:${1000+i}`,fields:["description","gesClass"]}));
    const request={name:"Repair",provider:"firecrawl",strategy:"firecrawl-detail-repair-v4",mode:"urls",urls,repair:{parentRunId:"11111111-1111-4111-8111-111111111111",targets}};
    expect(captureRequestSchema.parse(request).repair?.targets).toHaveLength(501);
    expect(()=>captureRequestSchema.parse({...request,provider:"xai"})).toThrow();
    expect(()=>captureRequestSchema.parse({...request,repair:{...request.repair,targets:[targets[0],targets[0]]}})).toThrow();
    expect(repairRequestSchema.parse({})).toEqual({});
    for(const invalid of [{fields:[]},{fields:["guessedField"]},{listingIds:[]},{name:""},{provider:"xai"}])expect(()=>repairRequestSchema.parse(invalid)).toThrow();
    expect(workItemSchema.parse({id:"work",kind:"details",urls:[urls[0]],repairFields:["gesClass"]}).repairFields).toEqual(["gesClass"]);
  });
  it("accepts trusted per-field observation times only on stored observations",()=>{
    const input={url:"https://www.leboncoin.fr/ad/ventes_immobilieres/123",fieldObservedAt:{priceEuros:"2026-09-12T08:00:00.000Z",gesClass:"2026-09-12T12:00:00.000Z"}};
    expect(observationInputSchema.parse(input)).not.toHaveProperty("fieldObservedAt");
    const observation={...input,id:"leboncoin:123",externalId:"123",source:"leboncoin",provider:"firecrawl",runId:"run",observedAt:"2026-09-12T12:00:00.000Z"};
    expect(observationSchema.parse(observation).fieldObservedAt).toEqual(input.fieldObservedAt);
    expect(()=>observationSchema.parse({...observation,fieldObservedAt:{priceEuros:"today"}})).toThrow();
    expect(()=>observationSchema.parse({...observation,fieldObservedAt:{arbitrary:"2026-09-12T12:00:00.000Z"}})).toThrow();
  });
});
