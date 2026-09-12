import { describe, expect, it } from "vitest";
import { dataFields, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import { detailFieldStates, detailGaps } from "./capture-quality.js";
import { repairObservationFromEvidence } from "./detail-repair-evidence.js";

const url="https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
const seed=():ObservationInput=>({url,data:{},detailStatus:"failed",missingFields:[...dataFields],absentFields:[],evidence:[]});
const raw=(markdown:string,script?:unknown,sourceURL=url)=>({success:true,data:{metadata:{sourceURL},markdown,actions:{javascriptReturns:script?[{value:script}]:[]}}});
const document=(criteria:string,description="Complete source description.")=>`# Maison\n\n## Description\n\n${description}\n\nVoir moins\n\n## Les informations clés\n\n${criteria}\n\n## Localisation\nLannion (22300)`;
const inventoryScript=(images:Record<string,unknown>,extra:Record<string,unknown>={})=>({preparation:"leboncoin-native-inventory-v5",phase:"observe",url,blocked:false,listingId:"123456",inventory:{listingId:"123456",images,...extra}});
const galleryResponse=(count:number,headerCount:number,modal:Record<string,unknown>={})=>{
  const urls=Array.from({length:count},(_,i)=>`https://img.leboncoin.fr/api/v1/lbcpb1/images/photo${i}.jpg?rule=ad-large`);
  const inventory={...inventoryScript({urls,declaredCount:count,observedCount:count,inventoryComplete:count===headerCount},{galleryControl:{observed:true,declaredCount:headerCount}}),preparation:"leboncoin-gallery-audit-v6"};
  const gallery={preparation:"leboncoin-gallery-audit-v6",phase:"gallery",stage:"restored",url,listingId:"123456",openedByOwnControl:true,dialogFound:true,dialogHeading:"Photos",closed:true,restoredDetail:true,counters:[{kind:"position",current:1,total:count,text:`1 / ${count}`}],images:urls.slice(0,3).map(value=>({url:value.replace("ad-large","ad-thumb"),alt:"Photo"})),mediaKinds:["photo"],...modal};
  return {success:true,data:{metadata:{sourceURL:url},markdown:"",actions:{javascriptReturns:[{value:inventory},{value:{...gallery,stage:"before-close",closed:false,restoredDetail:false}},{value:gallery}]}}};
};
const walkResponse=(photoCount:number,contact=false)=>{
  const total=photoCount+Number(contact), response=galleryResponse(photoCount,total);
  const values=response.data.actions.javascriptReturns;
  const inventory=values[0]!.value as Record<string,unknown>;
  inventory.preparation="leboncoin-gallery-walk-v7";
  const positions:Array<Record<string,unknown>>=Array.from({length:photoCount},(_,index)=>{
    const position=index+1,image={url:`https://img.leboncoin.fr/api/v1/lbcpb1/images/photo${index}.jpg?rule=ad-image`,alt:`Image ${position}`};
    return {position,total,counterText:`${position} / ${total}`,images:[image],activeImages:[image],mediaKinds:["photo"],text:`${position} / ${total}`,controls:[]};
  });
  if(contact)positions.push({position:total,total,counterText:`${total} / ${total}`,images:[],activeImages:[],mediaKinds:["contact"],text:"Cette annonce vous intéresse ? Envoyer un message",controls:[],nonPhotoEvidence:{kind:"contact",text:"Cette annonce vous intéresse ? Envoyer un message",selector:'[aria-roledescription="slide"][aria-current="true"]'}});
  const gallery={...values[2]!.value,preparation:"leboncoin-gallery-walk-v7",walk:{positions,declaredTotal:total,visitedPositions:positions.map(value=>value.position),complete:true,stopReason:"all_positions_observed"}};
  response.data.actions.javascriptReturns=[{value:inventory},{value:gallery}] as typeof values;
  return {response,gallery,positions,inventory};
};
const businessCardHtml=(reply="/reply/123456",extra="")=>`<div role="group" aria-roledescription="slide" data-scope="carousel" data-part="item" data-index="11" aria-hidden="false"><div data-qa-id="business-card-slide" style="background-image: url(&quot;/_next/static/media/card.webp&quot;)"><div><img alt="" aria-hidden="true" src="/_next/image?url=https%3A%2F%2Fimg.leboncoin.fr%2Fapi%2Fv1%2Flbcpb1%2Fimages%2Flogo%3Frule%3Dbo-logo&amp;w=256&amp;q=75"><p>Agency example</p><a href="${reply}">Contacter</a></div></div>${extra}</div>`;
const savedCardResponse=()=>{
  const walk=walkResponse(11,true),position=walk.positions[11]!;
  Object.assign(position,{activeImages:[],mediaKinds:[],nonPhotoEvidence:undefined,activeSlideEvidence:{position:12,dataIndex:11,ariaHidden:"false",ariaCurrent:null,dataState:null,inert:false,matchedSlides:1,viewport:{left:0,top:94238,right:800,bottom:94406},slide:{left:0,top:500,right:800,bottom:1100},selector:'[data-scope="carousel"][data-part="item"][data-index="11"]:not([aria-hidden="true"]):not([inert])',html:businessCardHtml(),htmlTruncated:false}});
  return {...walk,position};
};

describe("deterministic same-listing evidence repair",()=>{
  it("recovers labeled numeric criteria with French separators and clears only fields proven by the source",()=>{
    const input=seed();input.data.title="Original title";input.fieldStates={title:{status:"unresolved",reason:"Original unresolved title",evidence:[],observedAt:"2026-09-12T08:00:00.000Z"}};
    const before=structuredClone(input);
    const output=repairObservationFromEvidence(input,raw(document("Type de bien\n\nMaison\n\nSurface habitable\n\n107,5 m²\n\nSurface totale du terrain\n\n1 234 m²\n\nNombre de pièces\n\n4\n\nNombre de chambres\n\n3 ch.")),url);
    expect(output.data).toMatchObject({surfaceM2:107.5,landSurfaceM2:1234,rooms:4,bedrooms:3,propertyType:"Maison"});
    expect(detailGaps(output)).not.toContain("surfaceM2");expect(detailGaps(output)).not.toContain("landSurfaceM2");expect(detailGaps(output)).toContain("gesClass");
    expect(output.fieldStates?.title).toEqual(before.fieldStates?.title);expect(input).toEqual(before);expect(output.detailStatus).toBe("failed");
  });
  it("never guesses missing terrain from an apartment or from an empty criterion section",()=>{
    for(const markdown of [document("Type de bien\n\nAppartement"),document(""),""]){
      const output=repairObservationFromEvidence(seed(),raw(markdown),url);
      expect(output.fieldStates?.landSurfaceM2).toBeUndefined();expect(output.absentFields).not.toContain("landSurfaceM2");expect(detailGaps(output)).toContain("landSurfaceM2");
    }
  });
  it("distinguishes explicit source absence from non-applicability without fabricated values",()=>{
    const input=seed();input.data.landSurfaceM2=55;input.data.energyClass="En savoir plus";
    const output=repairObservationFromEvidence(input,raw(document("Surface totale du terrain\n\nNon renseigné", "Bien non soumis au DPE. GES non renseigné.")),url);
    expect(output.data.landSurfaceM2).toBeUndefined();expect(output.data.energyClass).toBeUndefined();expect(output.data.gesClass).toBeUndefined();
    expect(output.fieldStates?.landSurfaceM2?.status).toBe("absent");expect(output.fieldStates?.energyClass?.status).toBe("not_applicable");expect(output.fieldStates?.gesClass?.status).toBe("absent");
    expect(detailGaps(output)).not.toContain("landSurfaceM2");expect(detailGaps(output)).not.toContain("energyClass");expect(detailGaps(output)).not.toContain("gesClass");
  });
  it("does not apply an explicit DPE exemption to GES without a separate source declaration",()=>{
    const output=repairObservationFromEvidence(seed(),raw(document("", "Bien non soumis au DPE.")),url);
    expect(output.fieldStates?.energyClass?.status).toBe("not_applicable");expect(output.fieldStates?.gesClass).toBeUndefined();expect(detailGaps(output)).toContain("gesClass");
  });
  it("accepts an explicit native GES exemption independently and handles serialized observation scripts",()=>{
    const script={preparation:"leboncoin-detail-repair-v4",phase:"observe",url,fields:{gesClass:{value:null,selected:false,selector:"__NEXT_DATA__.ad.attributes.ges",evidence:"GES: Non soumis; current listing 123456 native attribute ges"}}};
    for(const payload of [script,JSON.stringify(script)]){
      const output=repairObservationFromEvidence(seed(),raw("",payload),url);
      expect(detailFieldStates(output).gesClass.status).toBe("not_applicable");expect(output.data.gesClass).toBeUndefined();expect(detailGaps(output)).toContain("energyClass");expect(detailGaps(output)).not.toContain("gesClass");
    }
    for(const patch of [{phase:"prepare"},{blocked:true},{url:"https://www.leboncoin.fr/ad/ventes_immobilieres/999999"}]){
      const output=repairObservationFromEvidence(seed(),raw("",{...script,...patch}),url);expect(detailGaps(output)).toContain("gesClass");
    }
  });
  it.each(["Classe énergie\n\nEn savoir plus\n\nA\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG", "Classe énergie\n\nA\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG"])("never reads the first letter of a diagnostic legend as the selected value: %s",legend=>{
    const output=repairObservationFromEvidence(seed(),raw(`## Diagnostics\n\n${legend}\n\nGES\n\nA\n\nB\n\nC\n\nD\n\nE\n\nF\n\nG\n\n## Localisation\nLannion`),url);
    expect(output.data.energyClass).toBeUndefined();expect(output.data.gesClass).toBeUndefined();expect(detailGaps(output)).toContain("energyClass");expect(detailGaps(output)).toContain("gesClass");
  });
  it("requires an explicit unambiguous selected DOM diagnostic, preserves exact source evidence, and ignores foreign script URLs",()=>{
    const script={preparation:"leboncoin-detail-repair-v4",phase:"observe",url,fields:{energyClass:{value:"D",selected:true,selector:"[aria-selected=true]",evidence:"Classe énergie: D"},gesClass:{value:"A",selected:false,selector:".legend",evidence:"GES: A B C D E F G"}}};
    const output=repairObservationFromEvidence(seed(),raw("",script),url);
    expect(output.data.energyClass).toBe("D");expect(detailFieldStates(output).energyClass.status).toBe("observed");expect(output.data.gesClass).toBeUndefined();
    expect(output.evidence.some(item=>item.text.includes("Classe énergie: D"))).toBe(true);
    const foreign=repairObservationFromEvidence(seed(),raw("",{...script,url:"https://www.leboncoin.fr/ad/ventes_immobilieres/999999"}),url);
    expect(foreign.data.energyClass).toBeUndefined();
  });
  it("does not read LLM JSON, diagnostic measurements, or unselected inline scales as source ratings",()=>{
    const response=raw(document("", "Consommation énergétique : 163 kWh/m²/an\nEmission de gaz à effet de serre : 6 CO2/m²/an\nDPE A B C D E F G"));
    Object.assign(response.data,{json:{data:{energyClass:"D",gesClass:"B",landSurfaceM2:600}}});
    const output=repairObservationFromEvidence(seed(),response,url);
    expect(output.data.energyClass).toBeUndefined();expect(output.data.gesClass).toBeUndefined();expect(output.data.landSurfaceM2).toBeUndefined();
  });
  it("keeps complete descriptions and all explicit source feature bullets without importing recommendations",()=>{
    const bullets=Array.from({length:501},(_,i)=>`- Source feature ${i}`);
    const description=`Original paragraph.\n\n${bullets.join("\n")}\n\n${"All source text. ".repeat(3000)}`;
    const markdown=document("Caractéristiques\n\nAvec garage\n\nExtérieur\n\nBalcon, Terrasse",description)+"\n\n## Ces annonces peuvent vous intéresser\n\n## Les informations clés\n\nSurface totale du terrain\n\n999 m²\n\n- Foreign recommended feature";
    const output=repairObservationFromEvidence(seed(),raw(markdown),url);
    expect(output.data.description).toBe(description.trim());expect(output.data.features).toHaveLength(504);expect(output.data.features).not.toContain("Foreign recommended feature");expect(output.data.landSurfaceM2).toBeUndefined();
    expect(detailGaps(output)).not.toContain("features");expect(detailGaps(output)).not.toContain("description");
  });
  it("recovers the saved 3156106279 narrative amenities as exact complete sentences, preserving the source description",()=>{
    const description=[
      "Dans un environnement calme et agréable, à proximité des écoles et des commerces, découvrez cette maison de plain-pied construite en 2010, idéale pour une vie de famille sereine.",
      "D'une surface d'environ 107 m², elle offre un bel espace de vie lumineux de 45 m² avec cuisine ouverte sur le salon; une arrière-cuisine vient compléter cet espace pour plus de praticité.",
      "Côté nuit, vous trouverez 3 chambres ainsi qu'une salle de bains équipée d'une douche et d'une baignoire, adaptée aux besoins de toute la famille.",
      "Implantée sur un terrain d'environ 600 m², la maison bénéficie d'un agréable extérieur pour profiter des beaux jours.",
      "Fonctionnelle, moderne et bien située, cette maison réunit tous les atouts pour accueillir votre famille dans les meilleures conditions. Montant estimé des dépenses annuelles d'énergie pour un usage standard entre 1670.0 € et 2300.0 € indexées aux années 2021, 2022, 2023 (abonnements compris).\nRéférence annonce : 398\nConsommation énergétique : 163 kWh/m²/an\nEmission de gaz à effet de serre : 6 CO2/m²/an\nLes honoraires sont à la charge du vendeur",
    ];
    const response=raw(document("Surface totale du terrain\n\n581 m²\n\nNombre de salles de bain\n\n1",description.join("\n\n")));
    Object.assign(response.data,{json:{data:{features:["proche écoles","extérieur agréable"]},fieldStates:{features:{status:"observed",reason:"Features found",evidence:[]}}}});
    const output=repairObservationFromEvidence(seed(),response,url);
    expect(output.data.features).toEqual(["Nombre de salles de bain: 1",...description.slice(0,3)]);
    expect(output.data.landSurfaceM2).toBe(581);expect(output.data.description).toBe(description.join("\n\n"));
    expect(output.fieldStates?.features?.evidence[0]?.text).toContain(description[1]);expect(detailFieldStates(output).features.status).toBe("observed");expect(detailGaps(output)).not.toContain("features");
    expect(output.data.features).not.toContain("proche écoles");expect(output.data.features).not.toContain("garage");
  });
  it("does not promote negations, possible works, energy costs, contact text, code, or recommendations into narrative amenities",()=>{
    const excluded=["Cette maison est sans garage.","Il n'y a pas de piscine.","Un garage pourrait être construit.","Possibilité de créer une terrasse.","L'ancienne cave est devenue une chambre.","Garage en option.","Un futur jardin pourra être aménagé.","Contactez notre agence pour visiter cette maison avec garage.","Les dépenses d'énergie incluent le chauffage par pompe à chaleur.","Sous réserve de disponibilité, cette maison comprend un jardin.","Photo de mise en situation non contractuelle avec piscine.","```\nUne maison avec garage.\n```"];
    const output=repairObservationFromEvidence(seed(),raw(document("",excluded.join("\n\n"))+"\n\n## Ces annonces peuvent vous intéresser\n\nUne maison avec piscine."),url);
    expect(output.data.features).toBeUndefined();expect(detailGaps(output)).toContain("features");
    const collapsed=repairObservationFromEvidence(seed(),raw("## Description\n\nUne maison avec garage…\n\nVoir plus\n\n## Localisation\nLannion"),url);
    expect(collapsed.data.features).toBeUndefined();expect(detailGaps(collapsed)).toContain("features");
  });
  it("adds labeled native amenities while keeping already proven features and rejecting unsupported replacements",()=>{
    const input=seed();input.data.features=["Cave"];input.fieldStates={features:{status:"observed",reason:"Native feature observed",evidence:[{url,text:"Caractéristiques: Cave",kind:"page"}]}};
    const output=repairObservationFromEvidence(input,raw(document("Nombre de salles de bain\n\n2\n\nNombre d’étages dans l’immeuble\n\n3\n\nType de chauffage\n\nIndividuel\n\nMode de chauffage\n\nGaz\n\nAscenseur\n\nNon\n\nNombre de salles d'eau\n\nEn savoir plus\n\nPlaces de parking\n\nnull", "Une cuisine ouverte complète ce logement.")),url);
    expect(output.data.features).toEqual(["Cave","Nombre de salles de bain: 2","Nombre d’étages dans l’immeuble: 3","Type de chauffage: Individuel","Mode de chauffage: Gaz","Ascenseur: Non","Une cuisine ouverte complète ce logement."]);
    expect(detailFieldStates(output).features.status).toBe("observed");expect(input.data.features).toEqual(["Cave"]);
  });
  it("ignores diagnostic claims and fake headings inside code, and keeps collapsed descriptions unresolved",()=>{
    const output=repairObservationFromEvidence(seed(),raw(document("", "```\nDPE: A\nGES: B\n```\nStill authored code.")),url);
    expect(output.data.energyClass).toBeUndefined();expect(output.data.gesClass).toBeUndefined();
    const collapsed=repairObservationFromEvidence(seed(),raw("## Description\n\nCollapsed source…\n\nVoir plus\n\n## Localisation\nLannion"),url);
    expect(collapsed.fieldStates?.description?.status).toBe("unresolved");expect(detailGaps(collapsed)).toContain("description");
  });
  it("rejects conflicting explicit values rather than selecting the last source statement",()=>{
    const output=repairObservationFromEvidence(seed(),raw(document("DPE\n\nC", "DPE: D")),url);
    expect(output.fieldStates?.energyClass?.status).toBe("unresolved");expect(detailGaps(output)).toContain("energyClass");
  });
  it("rejects foreign response identities, string null, and cross-field criterion values",()=>{
    const input=seed(),response=raw(document("Surface totale du terrain\n\nnull\n\nCaractéristiques\n\nSurface habitable\n\n90 m²"));
    const output=repairObservationFromEvidence(input,response,url);
    expect(output.data.landSurfaceM2).toBeUndefined();expect(output.data.features).toBeUndefined();expect(output.data.surfaceM2).toBe(90);
    expect(repairObservationFromEvidence(input,raw(document("DPE\n\nA"),undefined,"https://www.leboncoin.fr/ad/ventes_immobilieres/999999"),url)).toEqual(input);
    expect(repairObservationFromEvidence(input,response,"https://www.leboncoin.fr.evil.example/ad/ventes_immobilieres/123456")).toEqual(input);
  });
  it("recovers a price from the exact listing-header selector with French spaces and an explicit field citation",()=>{
    const response=raw(document(""));Object.assign(response.data,{html:'<h1>Pavillon 4 pièces</h1><div data-qa-id="adview_price"><div><p class="text-display-3">227 900&nbsp;€</p><svg><title>Baisse de prix</title></svg></div></div><h2>Description</h2><p>Une maison.</p>'});
    const input=seed();input.data.priceEuros=227900;input.fieldStates={priceEuros:{status:"observed",reason:"Price found",evidence:[{url,kind:"page",text:"227 900 €"}]}};
    expect(detailGaps(input)).toContain("priceEuros");
    const result=repairObservationFromEvidence(input,response,url);
    expect(result.data.priceEuros).toBe(227900);expect(detailGaps(result)).not.toContain("priceEuros");expect(result.fieldStates?.priceEuros?.evidence[0]?.text).toContain('Prix: 227900 €; source selector [data-qa-id="adview_price"]');
  });
  it.each([
    '<h1>Maison</h1><div data-qa-id="finance_price"><p>900 €</p></div><h2>Description</h2>',
    '<h1>Maison</h1><div data-qa-id="adview_price"><p>900 €</p><span>par mois</span></div><h2>Description</h2>',
    '<h1>Maison</h1><div data-qa-id="adview_price"><p>3 500 €/m²</p></div><h2>Description</h2>',
    '<h1>Maison</h1><div data-qa-id="adview_price"><p>900 €</p><span>Honoraires</span></div><h2>Description</h2>',
    '<h1>Maison</h1><h2>Description</h2><h2>Annonces similaires</h2><div data-qa-id="adview_price"><p>900 €</p></div>',
    '<template><h1>Fake</h1><div data-qa-id="adview_price"><p>900 €</p></div><h2>Description</h2></template>',
    '<h1>Maison</h1><script>"<div data-qa-id=\"adview_price\"><p>900 €</p></div>"</script><h2>Description</h2>',
  ])("rejects financing, unit-price, fee, recommendation or inactive HTML prices",html=>{
    const response=raw(document(""));Object.assign(response.data,{html});
    const result=repairObservationFromEvidence(seed(),response,url);expect(result.data.priceEuros).toBeUndefined();expect(detailGaps(result)).toContain("priceEuros");
  });
  it("repairs every native photo without a cap and validates the inventory count after exact URL deduplication",()=>{
    const urls=Array.from({length:501},(_,i)=>`https://img.leboncoin.fr/photos/${i}.jpg`);
    const script=inventoryScript({urls:[...urls,urls[0]],declaredCount:501,observedCount:501,inventoryComplete:true},{price:[227900],galleryControl:{observed:true,declaredCount:501}});
    const input=seed();input.data.imageUrls=["https://img.leboncoin.fr/recommendation.jpg"];
    const result=repairObservationFromEvidence(input,raw("",script),url);
    expect(result.data.imageUrls).toEqual(urls);expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain(urls[500]);expect(result.data.priceEuros).toBe(227900);
    expect(detailGaps(result)).not.toContain("imageUrls");expect(detailGaps(result)).not.toContain("priceEuros");expect(result.detailStatus).toBe("failed");
  });
  it.each([
    {declaredCount:12,observedCount:3,inventoryComplete:true},
    {declaredCount:3,observedCount:3,inventoryComplete:false},
    {declaredCount:null,observedCount:3,inventoryComplete:true},
    {declaredCount:3,observedCount:12,inventoryComplete:true},
  ])("retains partial native photo URLs without treating three preview images as a complete gallery",metadata=>{
    const urls=[1,2,3].map(i=>`https://img.leboncoin.fr/photos/${i}.jpg`);
    const result=repairObservationFromEvidence(seed(),raw("",inventoryScript({urls,...metadata})),url);
    expect(result.data.imageUrls).toEqual(urls);expect(result.fieldStates?.imageUrls?.status).toBe("unresolved");expect(detailGaps(result)).toContain("imageUrls");
  });
  it("rejects foreign inventory IDs, a gallery count contradiction, insecure URLs and unproven zero-image absence",()=>{
    const images={urls:["https://img.leboncoin.fr/photo.jpg"],declaredCount:1,observedCount:1,inventoryComplete:true};
    const foreign=repairObservationFromEvidence(seed(),raw("",inventoryScript(images,{listingId:"999999",price:227900})),url);
    expect(foreign.data.imageUrls).toBeUndefined();expect(foreign.data.priceEuros).toBeUndefined();
    const mismatch=repairObservationFromEvidence(seed(),raw("",inventoryScript(images,{galleryControl:{observed:true,declaredCount:12}})),url);
    expect(mismatch.fieldStates?.imageUrls?.status).toBe("unresolved");
    const insecure=repairObservationFromEvidence(seed(),raw("",inventoryScript({...images,urls:[...images.urls,"http://img.leboncoin.fr/unsafe.jpg"],declaredCount:2,observedCount:2})),url);
    expect(insecure.data.imageUrls).toEqual(images.urls);expect(detailGaps(insecure)).toContain("imageUrls");
    const empty=repairObservationFromEvidence(seed(),raw("",inventoryScript({urls:[],declaredCount:0,observedCount:0,inventoryComplete:true})),url);
    expect(empty.absentFields).not.toContain("imageUrls");expect(detailGaps(empty)).toContain("imageUrls");
  });
  it("projects exact native title, seller and labeled numeric attributes while respecting the explicit strategy guard",()=>{
    const script=inventoryScript({urls:[],declaredCount:0,observedCount:0,inventoryComplete:false},{title:"Appartement 4 pièces 86 m²",attributes:[{key:"rooms",value:"4",value_label:"4"},{key:"bedrooms",value:"2",value_label:"2 ch."},{key:"store_name",value:"Nathalie LEBE - I@D France",value_label:"Nathalie LEBE - I@D France"}]});
    const result=repairObservationFromEvidence(seed(),raw("",script),url,{nativeInventory:true});
    expect(result.data).toMatchObject({title:"Appartement 4 pièces 86 m²",rooms:4,bedrooms:2,sellerName:"Nathalie LEBE - I@D France"});
    for(const field of ["title","rooms","bedrooms","sellerName"])expect(detailGaps(result)).not.toContain(field);
    const guarded=repairObservationFromEvidence(seed(),raw("",script),url,{nativeInventory:false});
    expect(guarded.data.title).toBeUndefined();expect(guarded.data.rooms).toBeUndefined();expect(guarded.data.sellerName).toBeUndefined();
  });
  it("reads only the same-listing header map link and the bounded seller section, with literal type evidence",()=>{
    const markdown=`# Appartement 4 pièces 86 m²\n\n[Lannion 22300 · Quartier Rive Gauche](https://www.leboncoin.fr/ad/ventes_immobilieres/123456#map)\n\n## Description\nDescription intégrale.\nVoir moins\n\n## Vendu par\n\n[Nathalie LEBE - I@D France](https://www.leboncoin.fr/boutique/56315/nathalie.htm)\n\nProN° SIRET : 00000000000000\n\n## Les annonces de ce pro\n\n[Un autre vendeur](https://www.leboncoin.fr/boutique/456/other.htm)\n\nParticulier`;
    const result=repairObservationFromEvidence(seed(),raw(markdown),url);
    expect(result.data).toMatchObject({location:"Lannion 22300 · Quartier Rive Gauche",sellerName:"Nathalie LEBE - I@D France",sellerType:"Pro"});
    for(const field of ["location","sellerName","sellerType"])expect(detailGaps(result)).not.toContain(field);
    const foreign=repairObservationFromEvidence(seed(),raw(markdown.replace('/123456#map','/999999#map').replace('## Vendu par','## Ces annonces peuvent vous intéresser')),url);
    expect(foreign.data.location).toBeUndefined();expect(foreign.data.sellerName).toBeUndefined();expect(foreign.data.sellerType).toBeUndefined();
  });
  it("does not infer rooms from bedrooms or invent GES from an exempt DPE despite a complete native attribute inventory",()=>{
    const script=inventoryScript({urls:[],declaredCount:0,observedCount:0,inventoryComplete:false},{title:"Maison 90 m² Lannion",attributesComplete:true,attributes:[{key:"bedrooms",value:"3",value_label:"3 ch."}],sectionsObserved:{description:true,additionalCriteria:true},collapsedControls:{description:0,additionalCriteria:0}});
    const input=seed();input.data.rooms=5;
    const result=repairObservationFromEvidence(input,raw(document("","Maison plain-pied, une pièce de vie, cuisine ouverte sur séjour salon, 3 chambres, 1 salle d'eau, 1 WC séparé et 1 local technique.\nNon soumis au DPE"),script),url);
    expect(result.data.bedrooms).toBe(3);expect(detailGaps(result)).toContain("rooms");expect(detailGaps(result)).toContain("gesClass");expect(result.fieldStates?.energyClass?.status).toBe("not_applicable");
  });
  it("reconciles 11 native photos with the actual restored gallery count while retaining the original button's 12 claim",()=>{
    const result=repairObservationFromEvidence(seed(),galleryResponse(11,12),url);
    expect(result.data.imageUrls).toHaveLength(11);expect(detailGaps(result)).not.toContain("imageUrls");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("original header counts=[12]");expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("dialog total=11");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("rule=ad-thumb");expect(result.data.imageUrls?.every(value=>value.endsWith("rule=ad-large"))).toBe(true);
  });
  it("retains a genuinely additional photo from the opened gallery instead of inventing a missing cover",()=>{
    const extra="https://img.leboncoin.fr/api/v1/lbcpb1/images/additional.jpg?rule=ad-large";
    const response=galleryResponse(11,12,{counters:[{kind:"photo-count",total:12,text:"12 photos"}],images:[{url:extra,alt:"Another actual listing photo"}]});
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(result.data.imageUrls).toHaveLength(12);expect(result.data.imageUrls).toContain(extra);expect(detailGaps(result)).not.toContain("imageUrls");
    const missing=repairObservationFromEvidence(seed(),galleryResponse(11,12,{counters:[{kind:"photo-count",total:12,text:"12 photos"}]}),url);
    expect(missing.data.imageUrls).toHaveLength(11);expect(detailGaps(missing)).toContain("imageUrls");
  });
  it.each([
    {closed:false}, {restoredDetail:false}, {openedByOwnControl:false}, {dialogFound:false}, {listingId:"999999"},
    {url:"https://www.leboncoin.fr/ad/ventes_immobilieres/999999"},
    {counters:[{kind:"photo-count",total:11},{kind:"photo-count",total:12}]},
    {counters:[{kind:"other",total:11}]},
    {mediaKinds:["photo","video"]},
  ])("keeps gallery completeness unresolved for unproved modal scope, closure or counters",patch=>{
    const result=repairObservationFromEvidence(seed(),galleryResponse(11,11,patch),url);
    expect(detailGaps(result)).toContain("imageUrls");expect(result.data.imageUrls).toHaveLength(11);
  });
  it("requires a v6 modal audit and does not mistake a mixed-media position total for a photo counter",()=>{
    const response=galleryResponse(11,11);response.data.actions.javascriptReturns=response.data.actions.javascriptReturns.slice(0,1);
    expect(detailGaps(repairObservationFromEvidence(seed(),response,url))).toContain("imageUrls");
    const explicit=galleryResponse(11,12,{mediaKinds:["photo","video"],counters:[{kind:"position",current:1,total:12},{kind:"photo-count",total:11}]});
    expect(detailGaps(repairObservationFromEvidence(seed(),explicit,url))).not.toContain("imageUrls");
  });
  it("retains model photo URLs as partial when a requested v5/v6 inventory is absent, malformed or for another listing",()=>{
    const urls=[1,2,3].map(i=>`https://img.leboncoin.fr/api/v1/lbcpb1/images/${i}.jpg`);
    const input=seed();input.data.imageUrls=urls;input.missingFields=input.missingFields.filter(field=>field!=="imageUrls");input.fieldStates={imageUrls:{status:"observed",reason:"Model cited these images",evidence:[{url,kind:"page",text:urls.join("\n")}]}};
    const scripts=[undefined,{preparation:"leboncoin-native-inventory-v5",phase:"observe",url,listingId:"123456",inventory:{listingId:"123456",galleryControl:{observed:true,declaredCount:12}}},{preparation:"leboncoin-gallery-audit-v6",phase:"observe",url,listingId:"999999",inventory:{listingId:"999999",images:{urls,declaredCount:3,observedCount:3,inventoryComplete:true}}}];
    for(const script of scripts){
      const result=repairObservationFromEvidence(input,raw("",script),url,{nativeInventory:true});
      expect(result.data.imageUrls).toEqual(urls);expect(detailGaps(result)).toContain("imageUrls");expect(result.fieldStates?.imageUrls?.status).toBe("unresolved");
    }
    for(const response of [null,{success:true,data:{}},raw("",undefined,"https://www.leboncoin.fr/ad/ventes_immobilieres/999999")]){
      const result=repairObservationFromEvidence(input,response,url,{nativeInventory:true});
      expect(result.data.imageUrls).toEqual(urls);expect(detailGaps(result)).toContain("imageUrls");expect(result.fieldStates?.imageUrls?.evidence[0]?.kind).toBe("trace");
    }
    expect(detailGaps(repairObservationFromEvidence(input,raw(""),url,{nativeInventory:false}))).not.toContain("imageUrls");
  });
  it("accepts a complete native v7 inventory without requiring the gallery to open",()=>{
    const script={...inventoryScript({urls:["https://img.leboncoin.fr/api/v1/lbcpb1/images/a.jpg","https://img.leboncoin.fr/api/v1/lbcpb1/images/b.jpg"],declaredCount:2,observedCount:2,inventoryComplete:true}),preparation:"leboncoin-gallery-walk-v7",galleryOpening:{reason:"native_inventory_complete",clicked:false}};
    const result=repairObservationFromEvidence(seed(),raw("",script),url);
    expect(result.data.imageUrls).toHaveLength(2);expect(detailGaps(result)).not.toContain("imageUrls");
    script.inventory.images.urls=["https://img.leboncoin.fr/api/v1/lbcpb1/images/a.jpg?rule=ad-large","https://img.leboncoin.fr/api/v1/lbcpb1/images/a.jpg?rule=ad-image"];
    expect(detailGaps(repairObservationFromEvidence(seed(),raw("",script),url))).toContain("imageUrls");
  });
  it("accepts eleven photos in twelve fully visited positions only with explicit evidence of the contact slide",()=>{
    const {response}=walkResponse(11,true), result=repairObservationFromEvidence(seed(),response,url);
    expect(result.data.imageUrls).toHaveLength(11);expect(detailGaps(result)).not.toContain("imageUrls");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("explicit non-photo slots=1");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("Envoyer un message");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("gallery button=12");
  });
  it("accepts the observed current data-index and viewport when Spark omits aria-hidden on its contact slide",()=>{
    const {response,positions}=walkResponse(11,true);
    for(const [index,position] of positions.entries()) position.activeSlideEvidence={position:index+1,dataIndex:index,ariaHidden:null,inert:false,matchedSlides:1,viewport:{left:0,top:80,right:800,bottom:680},slide:{left:0,top:80,right:800,bottom:680}};
    Object.assign(positions[11]!.nonPhotoEvidence as object,{selector:'[aria-roledescription="slide"][data-index="11"]'});
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(result.data.imageUrls).toHaveLength(11);expect(detailGaps(result)).not.toContain("imageUrls");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain('"ariaHidden":null');
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain('"dataIndex":11');
  });
  it.each([{ariaHidden:"false"},{ariaCurrent:"true"},{dataState:"active"}])("accepts explicit native active state with its exact index despite source CSS placing the slide outside the viewport: %j",marker=>{
    const {response,positions}=walkResponse(11,true);
    for(const [index,position] of positions.entries()) position.activeSlideEvidence={position:index+1,dataIndex:index,ariaHidden:null,ariaCurrent:null,dataState:null,inert:false,matchedSlides:1,viewport:{left:0,top:94238,right:800,bottom:94406},slide:{left:0,top:500+index*800,right:800,bottom:1100+index*800},...marker};
    Object.assign(positions[11]!.nonPhotoEvidence as object,{selector:'[data-scope="carousel"][data-part="item"][data-index="11"]:not([aria-hidden="true"]):not([inert])'});
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(detailGaps(result)).not.toContain("imageUrls");expect(result.data.imageUrls).toHaveLength(11);
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain('"top":94238');
  });
  it.each([{ariaHidden:"true"},{inert:true},{ariaCurrent:"false"},{dataState:"inactive"},{dataIndex:10},{matchedSlides:2}])("rejects explicit active state when another observed marker, index, or uniqueness check contradicts it: %j",contradiction=>{
    const {response,positions}=walkResponse(11,true);
    positions[11]!.activeSlideEvidence={position:12,dataIndex:11,ariaHidden:"false",ariaCurrent:"true",dataState:"active",inert:false,matchedSlides:1,viewport:{left:0,top:94238,right:800,bottom:94406},slide:{left:0,top:500,right:800,bottom:1100},...contradiction};
    Object.assign(positions[11]!.nonPhotoEvidence as object,{selector:'[data-index="11"]'});
    expect(detailGaps(repairObservationFromEvidence(seed(),response,url))).toContain("imageUrls");
  });
  it("repairs a saved own business-card slide from intact HTML without inventing non-photo evidence or consulting the source again",()=>{
    const {response}=savedCardResponse(),before=structuredClone(response);
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(detailGaps(result)).not.toContain("imageUrls");expect(result.data.imageUrls).toHaveLength(11);
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain('"replyUrl":"https://www.leboncoin.fr/reply/123456"');
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("Collector audit of this active slide's intact saved native HTML");
    expect(response).toEqual(before);
  });
  it.each(["foreign_reply","foreign_origin","query_reply","unscoped_contact","missing_marker","truncated","property_photo","property_background","foreign_srcset","wrong_html_index","hidden_html","hidden_control"])("does not reclassify a saved slide as a contact card without exact own-source proof: %s",scenario=>{
    const {response,position}=savedCardResponse(),active=position.activeSlideEvidence as Record<string,unknown>;
    if(scenario==="foreign_reply")active.html=businessCardHtml("/reply/999999");
    if(scenario==="foreign_origin")active.html=businessCardHtml("https://evil.example/reply/123456");
    if(scenario==="query_reply")active.html=businessCardHtml("/reply/123456?other=999999");
    if(scenario==="unscoped_contact")active.html=businessCardHtml().replace('<a href="/reply/123456">Contacter</a>',"").replace(/<\/div>$/u,'<a href="/reply/123456">Contacter</a></div>');
    if(scenario==="missing_marker")active.html=businessCardHtml().replace('data-qa-id="business-card-slide"','data-qa-id="unrelated"');
    if(scenario==="truncated")active.htmlTruncated=true;
    if(scenario==="property_photo")active.html=businessCardHtml("/reply/123456",'<img src="https://img.leboncoin.fr/api/v1/lbcpb1/images/property.jpg?rule=ad-large" alt="Image 12">');
    if(scenario==="property_background")active.html=businessCardHtml().replace("/_next/static/media/card.webp","https://img.leboncoin.fr/api/v1/lbcpb1/images/property.jpg");
    if(scenario==="foreign_srcset")active.html=businessCardHtml().replace('<img alt=""','<img srcset="https://img.leboncoin.fr/api/v1/lbcpb1/images/property.jpg?rule=ad-large 1x" alt=""');
    if(scenario==="wrong_html_index")active.html=businessCardHtml().replace('data-index="11"','data-index="10"');
    if(scenario==="hidden_html")active.html=businessCardHtml().replace('aria-hidden="false"','aria-hidden="true"');
    if(scenario==="hidden_control")active.html=businessCardHtml().replace('<a href=','<a aria-hidden="true" href=');
    expect(detailGaps(repairObservationFromEvidence(seed(),response,url))).toContain("imageUrls");
  });
  it.each(["index_mismatch","counter_mismatch","hidden","inert","multiple_slides","offscreen","empty_bounds","absent_attribute_unobserved","missing_geometry","selector_mismatch"])("rejects a contact slide whose source current-position proof is ambiguous: %s",scenario=>{
    const {response,positions}=walkResponse(11,true),position=positions[11]!;
    const evidence:Record<string,unknown>={position:12,dataIndex:11,ariaHidden:null,inert:false,matchedSlides:1,viewport:{left:0,top:0,right:800,bottom:600},slide:{left:0,top:0,right:800,bottom:600}};
    position.activeSlideEvidence=evidence;
    Object.assign(position.nonPhotoEvidence as object,{selector:'[aria-roledescription="slide"][data-index="11"]'});
    if(scenario==="index_mismatch")evidence.dataIndex=10;
    if(scenario==="counter_mismatch")evidence.position=11;
    if(scenario==="hidden")evidence.ariaHidden="true";
    if(scenario==="inert")evidence.inert=true;
    if(scenario==="multiple_slides")evidence.matchedSlides=2;
    if(scenario==="offscreen")evidence.slide={left:816,top:0,right:1616,bottom:600};
    if(scenario==="empty_bounds")evidence.slide={left:0,top:0,right:0,bottom:600};
    if(scenario==="absent_attribute_unobserved")delete evidence.ariaHidden;
    if(scenario==="missing_geometry")delete evidence.viewport;
    if(scenario==="selector_mismatch")Object.assign(position.nonPhotoEvidence as object,{selector:'[data-index="10"]'});
    expect(detailGaps(repairObservationFromEvidence(seed(),response,url))).toContain("imageUrls");
  });
  it("recovers a newly observed photo from its actual visited position without keeping navigation thumbnails as extra photos",()=>{
    const {response,positions}=walkResponse(11,true);
    const extra={url:"https://img.leboncoin.fr/api/v1/lbcpb1/images/actual-last.jpg?rule=ad-image",alt:"Image 12"};
    Object.assign(positions[11]!,{activeImages:[extra],images:[extra],mediaKinds:["photo"],nonPhotoEvidence:undefined});
    positions[0]!.images=[...(positions[0]!.images as unknown[]),{url:"https://img.leboncoin.fr/api/v1/lbcpb1/images/navigation.jpg?rule=ad-thumb",alt:"Image 12"}];
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(result.data.imageUrls).toHaveLength(12);expect(result.data.imageUrls).toContain(extra.url);expect(result.data.imageUrls?.some(value=>value.includes("navigation"))).toBe(false);
    expect(detailGaps(result)).not.toContain("imageUrls");
  });
  it.each(["stalled","deadline","identity_changed","blocked","ambiguous_next","repeated_position"])("retains gallery gaps after a %s walk even if the provider says complete",stopReason=>{
    const {response,gallery}=walkResponse(11,true);gallery.walk.stopReason=stopReason;
    expect(detailGaps(repairObservationFromEvidence(seed(),response,url))).toContain("imageUrls");
  });
  it.each(["missing_position","duplicate_position","different_total","bad_counter","unvisited","repeated_photo","blank_slot","unscoped_contact","video_without_proof","not_closed","not_restored","foreign","invalid_image","thumbnail_as_active"])("rejects incomplete or ambiguous per-position gallery evidence: %s",scenario=>{
    const {response,gallery,positions}=walkResponse(11,true);
    if(scenario==="missing_position")positions.splice(5,1);
    if(scenario==="duplicate_position")positions[5]!.position=5;
    if(scenario==="different_total")positions[5]!.total=13;
    if(scenario==="bad_counter")positions[5]!.counterText="6 / 13";
    if(scenario==="unvisited")gallery.walk.visitedPositions=[1,2,3];
    if(scenario==="repeated_photo")positions[5]!.activeImages=[{url:"https://img.leboncoin.fr/api/v1/lbcpb1/images/photo0.jpg?rule=ad-image",alt:"Image 6"}];
    if(scenario==="blank_slot")Object.assign(positions[11]!,{mediaKinds:[],nonPhotoEvidence:undefined,text:"Envoyer un message"});
    if(scenario==="unscoped_contact")Object.assign(positions[11]!,{nonPhotoEvidence:{kind:"contact",text:"Envoyer un message",selector:'[role="dialog"]'}});
    if(scenario==="video_without_proof")Object.assign(positions[11]!,{mediaKinds:["video"],nonPhotoEvidence:undefined});
    if(scenario==="not_closed")Object.assign(gallery,{closed:false});
    if(scenario==="not_restored")Object.assign(gallery,{restoredDetail:false});
    if(scenario==="foreign")Object.assign(gallery,{listingId:"999999"});
    if(scenario==="invalid_image")positions[5]!.activeImages=[{url:"http://img.leboncoin.fr/unsafe.jpg",alt:"Image 6"}];
    if(scenario==="thumbnail_as_active")positions[5]!.activeImages=[{url:"https://img.leboncoin.fr/api/v1/lbcpb1/images/photo5.jpg?rule=ad-thumb",alt:"Image 6"}];
    const result=repairObservationFromEvidence(seed(),response,url);
    expect(detailGaps(result)).toContain("imageUrls");expect(result.data.imageUrls!.length).toBeGreaterThanOrEqual(11);
  });
  it("does not impose a photo or position cap on a fully evidenced gallery walk",()=>{
    const {response}=walkResponse(501,true),result=repairObservationFromEvidence(seed(),response,url);
    expect(result.data.imageUrls).toHaveLength(501);expect(detailGaps(result)).not.toContain("imageUrls");
    expect(result.fieldStates?.imageUrls?.evidence[0]?.text).toContain("Position 502/502");
  });
});
