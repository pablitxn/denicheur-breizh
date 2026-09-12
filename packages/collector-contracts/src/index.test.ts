import {describe,expect,it} from "vitest";
import {captureRequestSchema,listingDataSchema,referenceImportSchema,searchFiltersSchema} from "./index.js";

describe("collector contracts",()=>{
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
});
