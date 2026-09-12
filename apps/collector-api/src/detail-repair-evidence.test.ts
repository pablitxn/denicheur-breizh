import { describe, expect, it } from "vitest";
import { dataFields, type ObservationInput } from "@denicheur-breizh/collector-contracts";
import { detailFieldStates, detailGaps } from "./capture-quality.js";
import { repairObservationFromEvidence } from "./detail-repair-evidence.js";

const url="https://www.leboncoin.fr/ad/ventes_immobilieres/123456";
const seed=():ObservationInput=>({url,data:{},detailStatus:"failed",missingFields:[...dataFields],absentFields:[],evidence:[]});
const raw=(markdown:string,script?:unknown,sourceURL=url)=>({success:true,data:{metadata:{sourceURL},markdown,actions:{javascriptReturns:script?[{value:script}]:[]}}});
const document=(criteria:string,description="Complete source description.")=>`# Maison\n\n## Description\n\n${description}\n\nVoir moins\n\n## Les informations clés\n\n${criteria}\n\n## Localisation\nLannion (22300)`;

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
});
