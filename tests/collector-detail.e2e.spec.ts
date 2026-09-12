import { expect, test, type Page } from "@playwright/test";
import { leboncoinExpandDescription, leboncoinPrepareDetailRepair, leboncoinObserveDetailRepair, leboncoinObserveNativeInventory, leboncoinOpenGalleryAudit, leboncoinObserveAndCloseGallery, leboncoinVerifyGalleryClosed, leboncoinOpenGalleryWalk, leboncoinWalkAndCloseGallery, leboncoinVerifyGalleryWalkClosed } from "../apps/collector-api/src/leboncoin-detail.js";

async function descriptionFixture(page: Page, descriptionHeading: boolean) {
  // This fixture runs entirely in the test browser. No source site or paid API is accessed.
  await page.route("**/*", (route) => route.abort("blockedbyclient"));
  await page.setContent(`<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>
    <main>
      <h1>Maison de référence fictive</h1>
      <section aria-label="Détails du bien">
        <h2>${descriptionHeading ? "Description" : "À propos de ce bien"}</h2>
        <p>Début de la description fictive.</p>
        <p id="complete-description" hidden>Texte intégral : maison fictive de 100 m² avec jardin, sans annonce réelle.</p>
        <button id="expand-description" data-clicks="0"> Voir   plus </button>
      </section>
      <section aria-label="Publicité">
        <h2>Publicité</h2>
        <p>Une autre section comporte un bouton portant le même libellé.</p>
        <button id="expand-advertising" data-clicks="0">Voir plus</button>
      </section>
      <section aria-label="Contact">
        <h2>Contacter le vendeur</h2>
        <button id="contact-seller" data-clicks="0">Envoyer un message</button>
      </section>
    </main>
  </body></html>`);
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("button")) {
      button.addEventListener("click", () => {
        button.dataset.clicks = String(Number(button.dataset.clicks) + 1);
        if (button.id === "expand-description") document.getElementById("complete-description")!.hidden = false;
      });
    }
  });
}

test("description preparation expands only the Description section and never advertisement or contact controls", async ({ page }) => {
  await descriptionFixture(page, true);
  const outcome = await page.evaluate(leboncoinExpandDescription);
  expect(outcome).toEqual({ preparation: "leboncoin-expand-description-v1", descriptionHeadingFound: true, matchingControls: 2, clicked: 1 });
  await expect(page.locator("#expand-description")).toHaveAttribute("data-clicks", "1");
  await expect(page.locator("#expand-advertising")).toHaveAttribute("data-clicks", "0");
  await expect(page.getByRole("button", { name: "Envoyer un message" })).toHaveAttribute("data-clicks", "0");
  await expect(page.getByText("Texte intégral : maison fictive de 100 m² avec jardin, sans annonce réelle.", { exact: true })).toBeVisible();
});

test("description preparation performs zero clicks when the Description heading is absent", async ({ page }) => {
  await descriptionFixture(page, false);
  const outcome = await page.evaluate(leboncoinExpandDescription);
  expect(outcome).toEqual({ preparation: "leboncoin-expand-description-v1", descriptionHeadingFound: false, matchingControls: 2, clicked: 0 });
  for (const button of await page.getByRole("button").all()) await expect(button).toHaveAttribute("data-clicks", "0");
  await expect(page.locator("#complete-description")).not.toBeVisible();
});

const repairUrl = "https://www.leboncoin.fr/ad/ventes_immobilieres/123";
async function repairFixture(page: Page, content: string) {
  await page.route("**/*", route => route.request().url() === repairUrl
    ? route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>${content}</body></html>` })
    : route.abort("blockedbyclient"));
  await page.goto(repairUrl);
}
const scale = (key: string, title: string, selected: string[] = []) => `<div data-qa-id="criteria_item_${key}"><p>${title}</p><div title="${title}">${[..."ABCDEFG"].map(value=>`<div ${selected.includes(value)?'class="border-solid drop-shadow-sm"':''}>${value}</div>`).join("")}</div></div>`;

test("v4 expands only native detail disclosures and reads selected diagnostic DOM after expansion", async ({page}) => {
  await repairFixture(page, `<main><h1>Fiche de test</h1>
    <section><h2>Description</h2><p>Début.</p><button id="description" onclick="this.textContent='Voir moins'">Voir plus</button></section>
    <section><h2>Les informations clés</h2><div id="additional" hidden><div data-qa-id="criteria_item_land_plot_surface"><p>Surface totale du terrain</p><p title="581 m²">581 m²</p></div><div data-qa-id="criteria_item_outside_access"><p>Extérieur</p><p title="Jardin">Jardin</p></div></div><button id="criteria" onclick="document.getElementById('additional').hidden=false;this.textContent='Voir moins de critères'">Voir les 2 critères supplémentaires</button></section>
    <section><h2>Diagnostics</h2>${scale("energy_rate","Classe énergie",["D"])}${scale("ges","GES",["B"])}</section>
    <section><h2>Contacter le vendeur</h2><button id="contact" data-clicks="0" onclick="this.dataset.clicks='1'">Envoyer un message</button><button id="unrelated" data-clicks="0" onclick="this.dataset.clicks='1'">Voir plus</button></section>
    <section data-qa-id="adview-similar-ads"><h2>Ces annonces peuvent vous intéresser</h2>${scale("ges","GES",["G"])}<button id="recommended" data-clicks="0" onclick="this.dataset.clicks='1'">Voir les 2 critères supplémentaires</button></section>
  </main>`);
  const preparation=await page.evaluate(leboncoinPrepareDetailRepair);
  expect(preparation).toMatchObject({blocked:false,description:{clicked:1},additionalCriteria:{clicked:1}});
  await expect(page.getByRole("button",{name:"Voir moins",exact:true})).toBeVisible();
  await expect(page.getByText("581 m²",{exact:true})).toBeVisible();
  const observed=await page.evaluate(leboncoinObserveDetailRepair);
  expect(observed.fields.energyClass).toMatchObject({value:"D",selected:true});
  expect(observed.fields.gesClass).toMatchObject({value:"B",selected:true});
  expect(observed.criteria).toContainEqual(expect.objectContaining({label:"Surface totale du terrain",value:"581 m²"}));
  expect(observed.features).toContainEqual(expect.objectContaining({value:"Jardin"}));
  expect(observed.additionalCriteria.remainingControls).toBe(0);
  for(const id of ["contact","unrelated","recommended"])await expect(page.locator(`#${id}`)).toHaveAttribute("data-clicks","0");
});

test("v4 never chooses a generic scale letter and retains conflicting selected diagnostics as unresolved", async ({page})=>{
  await repairFixture(page, `<main><h1>Fiche de test</h1><section><h2>Diagnostics</h2>${scale("energy_rate","Classe énergie")}${scale("ges","GES",["B","F"])}</section></main>`);
  const observed=await page.evaluate(leboncoinObserveDetailRepair);
  expect(observed.fields.energyClass).toBeUndefined();
  expect(observed.fields.gesClass).toMatchObject({value:null,selected:false});
  expect(observed.criteria).toEqual([]);
});

test("v4 uses public native attributes only for the current listing identity", async ({page})=>{
  const native={props:{pageProps:{ad:{list_id:123,attributes:[{key:"energy_rate",value:"C"},{key:"ges",value:"A"}],recommendations:[{list_id:456,attributes:[{key:"ges",value:"G"}]}]}}}};
  await repairFixture(page, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(native)}</script><main><h1>Fiche de test</h1>${scale("energy_rate","Classe énergie")}</main>`);
  const observed=await page.evaluate(leboncoinObserveDetailRepair);
  expect(observed.fields.energyClass).toMatchObject({value:"C",selector:"script#__NEXT_DATA__",selected:true});
  expect(observed.fields.gesClass.value).toBe("A");
  await page.evaluate(()=>{const node=document.getElementById("__NEXT_DATA__")!;const data=JSON.parse(node.textContent!);data.props.pageProps.ad.attributes=[{key:"energy_rate",value:"not_subject",value_label:"Non soumis"}];node.textContent=JSON.stringify(data);});
  const exemption=await page.evaluate(leboncoinObserveDetailRepair);
  expect(exemption.fields.energyClass).toMatchObject({value:null,selected:false});
  expect(exemption.fields.energyClass.evidence).toContain("Classe énergie: Non soumis");
  expect(exemption.fields.gesClass).toBeUndefined();
  await page.evaluate(()=>{const node=document.getElementById("__NEXT_DATA__")!;const data=JSON.parse(node.textContent!);data.props.pageProps.ad.list_id=456;node.textContent=JSON.stringify(data);});
  const foreign=await page.evaluate(leboncoinObserveDetailRepair);
  expect(foreign.fields).toEqual({});expect(foreign.structuredData).toEqual([]);
});

test("v4 leaves challenge pages untouched instead of attempting their controls", async ({page})=>{
  await repairFixture(page, '<main><h1>Verify you are human</h1><section><h2>Description</h2><button data-clicks="0" onclick="this.dataset.clicks=1">Voir plus</button></section></main>');
  const preparation=await page.evaluate(leboncoinPrepareDetailRepair);
  expect(preparation.blocked).toBe(true);expect(preparation.description.clicked).toBe(0);
  await expect(page.getByRole("button",{name:"Voir plus"})).toHaveAttribute("data-clicks","0");
  expect((await page.evaluate(leboncoinObserveDetailRepair)).fields).toEqual({});
});

test("v5 inventories all 17 own-ad images, native price and attributes without fees or recommendations", async ({page})=>{
  const urls=Array.from({length:17},(_,i)=>`https://img.leboncoin.fr/own-${i}.jpg`);
  const native={props:{pageProps:{ad:{list_id:123,subject:"Titre natif exact",body:"Texte intégral.\n".repeat(500),price:[227900],images:{urls,nb_images:17},attributes:[{key:"energy_rate",value:"C"},{key:"unknown_public_property_attribute",value:"Avec dépendance",key_label:"Annexe"}],tracking:{secretTracking:"must-not-be-exported"},owner:{privateState:"must-not-be-exported"}},recommendations:[{list_id:999,price:[5],images:{urls:["https://img.leboncoin.fr/recommended.jpg"],nb_images:1}}]}}};
  await repairFixture(page,`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(native)}</script><main><h1>Titre visible</h1><div data-qa-id="adview_price">227 900 €</div><p>Honoraires: 12000 €. Mensualités: 900 €. 2 900 €/m².</p><button>Voir les 17 photos</button><section><h2>Description</h2><p>Texte complet</p></section><section><h2>Les informations clés</h2><p>Informations publiques</p></section><section data-qa-id="adview-similar-ads"><h2>Ces annonces peuvent vous intéresser</h2><button>Voir les 55 photos</button><img src="https://img.leboncoin.fr/recommended.jpg"></section></main>`);
  const observed=await page.evaluate(leboncoinObserveNativeInventory);
  expect(observed.preparation).toBe("leboncoin-native-inventory-v5");
  expect(observed.inventory).toMatchObject({listingId:"123",title:"Titre natif exact",description:native.props.pageProps.ad.body,price:[227900],images:{urls,declaredCount:17,observedCount:17,inventoryComplete:true},attributesComplete:true,sectionsObserved:{description:true,additionalCriteria:true},collapsedControls:{description:0,additionalCriteria:0},galleryControl:{observed:true,declaredCount:17}});
  expect(observed.inventory.attributes).toEqual(native.props.pageProps.ad.attributes);
  expect(JSON.stringify(observed)).not.toContain("must-not-be-exported");
  expect(observed.inventory.images.urls).not.toContain("https://img.leboncoin.fr/recommended.jpg");
  expect((await page.evaluate(leboncoinObserveDetailRepair))).not.toHaveProperty("inventory");
});

test("v5 refuses foreign native ad IDs and keeps incomplete gallery counts explicit", async ({page})=>{
  const native={props:{pageProps:{ad:{list_id:999,price:[150000],images:{urls:["https://img.leboncoin.fr/one.jpg"],nb_images:17},attributes:[]}}}};
  await repairFixture(page,`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(native)}</script><main><h1>Fiche 123</h1><button>Voir les 17 photos</button><section><h2>Description</h2><button>Voir plus</button></section><section><h2>Les informations clés</h2><button>Voir les 2 critères supplémentaires</button></section></main>`);
  expect(await page.evaluate(leboncoinObserveNativeInventory)).not.toHaveProperty("inventory");
  await page.evaluate(()=>{const node=document.querySelector("script#__NEXT_DATA__")!;const data=JSON.parse(node.textContent!);data.props.pageProps.ad.list_id=123;node.textContent=JSON.stringify(data);});
  const observed=await page.evaluate(leboncoinObserveNativeInventory);
  expect(observed.inventory.images).toMatchObject({declaredCount:17,observedCount:1,inventoryComplete:false});
  expect(observed.inventory.collapsedControls).toEqual({description:1,additionalCriteria:1});
});

test("v5 rejects credential-bearing images and ambiguous prices rather than selecting a page fee", async ({page})=>{
  const native={props:{pageProps:{ad:{list_id:123,price:[100000,200000],images:{urls:["https://img.leboncoin.fr/one.jpg","https://key:secret@img.leboncoin.fr/private.jpg"],nb_images:2},attributes:[]}}}};
  await repairFixture(page,`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(native)}</script><main><h1>Fiche</h1><p>Honoraires: 12000 €. 2 900 €/m².</p><button>Voir les 2 photos</button></main>`);
  const observed=await page.evaluate(leboncoinObserveNativeInventory);
  expect(observed.inventory.price).toEqual([100000,200000]);
  expect(observed.inventory.images).toEqual({urls:["https://img.leboncoin.fr/one.jpg"],declaredCount:2,observedCount:1,inventoryComplete:false});
  expect(JSON.stringify(observed)).not.toContain("key:secret");
  await page.evaluate(()=>{const node=document.querySelector("script#__NEXT_DATA__")!;const data=JSON.parse(node.textContent!);delete data.props.pageProps.ad.price;node.textContent=JSON.stringify(data);});
  expect((await page.evaluate(leboncoinObserveNativeInventory)).inventory).not.toHaveProperty("price");
});

async function galleryFixture(page:Page,modal:string,extra="") {
  const urls=Array.from({length:11},(_,i)=>`https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${i}.jpg?rule=ad-large`);
  const native={props:{pageProps:{ad:{list_id:123,price:[227900],images:{urls_large:urls,urls:urls.map(u=>u.replace("ad-large","ad-thumb")),nb_images:11,thumb_url:urls[0]},attributes:[]}}}};
  await repairFixture(page,`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(native)}</script><main><h1>Fiche propre123</h1><section aria-label="Aller à la galerie de photos"><button id="own-gallery">Voir les 12 photos</button></section>${extra}<section data-qa-id="adview-similar-ads"><h2>Ces annonces peuvent vous intéresser</h2><section aria-label="Aller à la galerie de photos"><button id="foreign-gallery" data-clicks="0" onclick="this.dataset.clicks='1'">Voir les 99 photos</button></section></section></main>`);
  await page.evaluate(markup=>{document.getElementById("own-gallery")!.addEventListener("click",()=>{const dialog=document.createElement("div");dialog.setAttribute("role","dialog");dialog.setAttribute("aria-label","Galerie de photos");dialog.innerHTML=markup;document.body.append(dialog);dialog.querySelector("[data-close]")?.addEventListener("click",()=>dialog.remove());});},modal);
  return urls;
}

test("v6 audits an actual own-gallery counter instead of assuming button plus one and restores the detail",async({page})=>{
  const urls=await galleryFixture(page,`<h2>Photos (11)</h2><p>Image 1 sur 11</p>${Array.from({length:11},(_,i)=>`<img width="80" height="60" alt="Photo ${i+1}" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${i}.jpg?rule=ad-thumb">`).join("")}<button aria-label="Fermer" data-close>×</button><button id="gallery-contact" data-clicks="0" onclick="this.dataset.clicks='1'">Contacter le vendeur</button>`);
  const before=await page.evaluate(leboncoinOpenGalleryAudit);
  expect(before).toMatchObject({preparation:"leboncoin-gallery-audit-v6",listingId:"123",galleryOpening:{clicked:true,matchingControls:1},inventory:{images:{declaredCount:11,inventoryComplete:false},galleryControl:{declaredCount:12}}});
  await expect(page.getByRole("dialog")).toBeVisible();
  const gallery=await page.evaluate(leboncoinObserveAndCloseGallery);
  expect(gallery).toMatchObject({openedByOwnControl:true,dialogFound:true,closeRequested:true});
  expect(gallery.counters).toContainEqual({text:"Photos (11)",kind:"photo-count",total:11});
  expect(gallery.counters).toContainEqual({text:"Image 1 sur 11",kind:"position",current:1,total:11});
  expect(gallery.images.map((i:{url:string})=>i.url)).toEqual(urls.map(u=>u.replace("ad-large","ad-thumb")));
  expect(gallery.nativeImages).toMatchObject({keys:["urls_large","urls","nb_images","thumb_url"],counts:{nb_images:11},scalarUrls:{thumb_url:urls[0]}});
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const restored=await page.evaluate(leboncoinVerifyGalleryClosed);
  expect(restored).toMatchObject({stage:"restored",closed:true,restoredDetail:true});
  expect(restored.images).toEqual(gallery.images);
  await expect(page.getByRole("heading",{name:"Fiche propre123"})).toBeVisible();
  await expect(page.locator("#own-gallery")).toBeFocused();
  await expect(page.locator("#foreign-gallery")).toHaveAttribute("data-clicks","0");
  expect(await page.evaluate(()=>Object.hasOwn(window,"__collectorGalleryAuditV6"))).toBe(false);
});

test("v6 records nonphoto panes separately from the carousel total and never presses a seller action",async({page})=>{
  await galleryFixture(page,'<h2>Photos (2)</h2><p>1 / 3</p><img width="80" height="60" alt="Photo 1" src="https://img.leboncoin.fr/one.jpg"><video width="80" height="60"></video><button aria-label="Fermer" data-close>×</button><button data-clicks="0" id="contact" onclick="window.contactClicked=true">Envoyer un message</button>');
  await page.evaluate(leboncoinOpenGalleryAudit);
  const gallery=await page.evaluate(leboncoinObserveAndCloseGallery);
  expect(gallery.mediaKinds).toContain("video");
  expect(gallery.counters).toContainEqual({text:"1 / 3",kind:"position",current:1,total:3});
  expect(gallery.counters).toContainEqual({text:"Photos (2)",kind:"photo-count",total:2});
  expect(await page.evaluate(()=>Object.hasOwn(window,"contactClicked"))).toBe(false);
  expect(await page.evaluate(leboncoinVerifyGalleryClosed)).toMatchObject({closed:true,restoredDetail:true});
});

test("v6 refuses ambiguous gallery controls and does not claim closure without its own close button",async({page})=>{
  await galleryFixture(page,'<h2>Photos (11)</h2>','<section aria-label="Aller à la galerie de photos"><button>Voir les 12 photos</button></section>');
  expect((await page.evaluate(leboncoinOpenGalleryAudit)).galleryOpening).toMatchObject({clicked:false,matchingControls:2});
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(()=>document.querySelectorAll('section[aria-label="Aller à la galerie de photos"]')[1]?.remove());
  await page.evaluate(leboncoinOpenGalleryAudit);
  const observed=await page.evaluate(leboncoinObserveAndCloseGallery);
  expect(observed).toMatchObject({dialogFound:true,closeRequested:false,closed:false});
  expect(await page.evaluate(leboncoinVerifyGalleryClosed)).toMatchObject({closed:false,restoredDetail:false});
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("v7 observes every modal position including an explicit nonphoto panel and restores its source",async({page})=>{
  await galleryFixture(page,'<p id="position">1/12</p><div aria-roledescription="slide" aria-current="true" id="active-slide"><img width="80" height="60" alt="Photo 1" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-large"></div><nav><img width="40" height="30" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-thumb"></nav><button aria-label="Image suivante" id="next-photo">→</button><button aria-label="Fermer" data-close>×</button>');
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.evaluate(()=>{let current=1;document.getElementById("next-photo")!.addEventListener("click",()=>{current++;document.getElementById("position")!.textContent=`${current}/12`;document.getElementById("active-slide")!.innerHTML=current===12?'<p>Cette annonce vous intéresse ?</p><button onclick="window.sellerContact=true">Envoyer un message</button>':`<img width="80" height="60" alt="Photo ${current}" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${current-1}.jpg?rule=ad-large">`;});});
  const result=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(result.walk).toMatchObject({complete:true,stopReason:"all_positions_observed",declaredTotal:12,visitedPositions:Array.from({length:12},(_,i)=>i+1)});
  expect(result.walk.positions.slice(0,11).map((p:{activeImages:unknown[]})=>p.activeImages.length)).toEqual(Array(11).fill(1));
  expect(result.walk.positions[11]).toMatchObject({position:12,activeImages:[],mediaKinds:["contact"],nonPhotoEvidence:{kind:"contact",text:expect.stringContaining("Cette annonce vous intéresse"),selector:'[aria-roledescription="slide"][aria-current="true"]'}});
  expect(result.walk.positions[11].images).toHaveLength(1); // Navigation thumbnail is retained as evidence, not an active photo.
  expect(await page.evaluate(()=>Object.hasOwn(window,"sellerContact"))).toBe(false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({stage:"restored",closed:true,restoredDetail:true,walk:{complete:true}});
});

test("v7 stops on ambiguous Next controls and on no progress without claiming full coverage",async({page})=>{
  await galleryFixture(page,'<p>1/12</p><img width="80" height="60" alt="Photo 1" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-large"><button aria-label="Image suivante">→</button><button aria-label="Next photo">→</button><button aria-label="Fermer" data-close>×</button>');
  await page.evaluate(leboncoinOpenGalleryWalk);
  const ambiguous=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(ambiguous.walk).toMatchObject({complete:false,stopReason:"ambiguous_next",visitedPositions:[1]});
  await page.evaluate(leboncoinVerifyGalleryWalkClosed);
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.getByRole("button",{name:"Next photo",exact:true}).evaluate(node=>node.remove());
  const stalled=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(stalled.walk).toMatchObject({complete:false,stopReason:"stalled",visitedPositions:[1]});
  expect(stalled.diagnosticHtml).toContain("Image suivante");
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
});

test("v7 recognizes native indexed slides with zoom buttons and retains the final active slide beyond truncated modal HTML",async({page})=>{
  const slides=Array.from({length:12},(_,index)=>`<div data-scope="carousel" data-part="item" data-index="${index}" data-spark-component="carousel-slide" aria-roledescription="slide" style="position:absolute;inset:0" ${index?'aria-hidden="true" inert':''}>${index===11?'<p>Cette annonce vous intéresse ?</p><button onclick="window.sellerContact=true">Envoyer un message</button>':`<button aria-label="Agrandir la photo" onclick="window.zoomClicked=true"><img width="160" height="120" alt="Maison propre (image ${index+1})" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${index}.jpg?rule=ad-large"></button>`}<span hidden>${'diagnostic neighbor '.repeat(90)}</span></div>`).join('');
  await galleryFixture(page,`<p id="position">1/12</p><div data-scope="carousel" data-part="root"><div data-scope="carousel" data-part="item-group" style="position:relative;width:500px;height:220px;overflow:hidden">${slides}</div></div><nav><button><img width="40" height="30" alt="" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-thumb"></button></nav><aside data-qa-id="recommendations"><img width="40" height="30" alt="Photo 1" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/foreign.jpg?rule=ad-large"></aside><button aria-label="Suivant" id="next-photo">→</button><button aria-label="Fermer" data-close>×</button>`);
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.evaluate(()=>{let current=1;document.getElementById('next-photo')!.addEventListener('click',()=>{current++;document.getElementById('position')!.textContent=`${current}/12`;for(const slide of document.querySelectorAll('[data-scope="carousel"][data-part="item"]')){if(slide.getAttribute('data-index')===String(current-1)){slide.removeAttribute('aria-hidden');slide.removeAttribute('inert');}else{slide.setAttribute('aria-hidden','true');slide.setAttribute('inert','');}}});});
  const result=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(result.walk).toMatchObject({complete:true,stopReason:'all_positions_observed',declaredTotal:12});
  expect(result.walk.positions.slice(0,11).map((position:{activeImages:{url:string}[]})=>position.activeImages.map(image=>image.url))).toEqual(Array.from({length:11},(_,index)=>[`https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${index}.jpg?rule=ad-large`]));
  const last=result.walk.positions[11];
  expect(last).toMatchObject({position:12,activeImages:[],mediaKinds:['contact'],activeSlideEvidence:{position:12,dataIndex:11,ariaHidden:null,ariaCurrent:null,dataState:null,inert:false,matchedSlides:1,htmlTruncated:false},nonPhotoEvidence:{kind:'contact',text:'Cette annonce vous intéresse ? Envoyer un message',selector:'[data-scope="carousel"][data-part="item"][data-index="11"]:not([aria-hidden="true"]):not([inert])'}});
  expect(last.activeSlideEvidence.html).toContain('Envoyer un message');
  expect(last.activeSlideEvidence.html).not.toContain('onclick');
  expect(result.diagnosticHtmlTruncated).toBe(true);
  expect(result.diagnosticHtml).not.toContain('Envoyer un message');
  expect(await page.evaluate(()=>Object.hasOwn(window,'sellerContact')||Object.hasOwn(window,'zoomClicked'))).toBe(false);
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
});

test("v7 refuses wrong or ambiguous native slide indexes despite visible photos elsewhere",async({page})=>{
  for(const indexes of [[1],[0,0]]){
    await galleryFixture(page,`<p>1/12</p><div data-scope="carousel" data-part="item-group" style="position:relative;width:500px;height:200px">${indexes.map(index=>`<div data-scope="carousel" data-part="item" data-index="${index}" aria-current="true" style="position:absolute;inset:0"><button><img width="80" height="60" alt="Photo 1" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-large"></button></div>`).join('')}</div><img width="80" height="60" alt="Photo 1" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/outside.jpg?rule=ad-large"><button aria-label="Fermer" data-close>×</button>`);
    await page.evaluate(leboncoinOpenGalleryWalk);
    const result=await page.evaluate(leboncoinWalkAndCloseGallery);
    expect(result.walk).toMatchObject({complete:false,stopReason:'next_missing'});
    expect(result.walk.positions[0].activeImages).toEqual([]);
    expect(result.walk.positions[0]).not.toHaveProperty('activeSlideEvidence');
    expect(result.walk.positions[0]).not.toHaveProperty('nonPhotoEvidence');
    expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
  }
});

test("v7 follows explicit active native state in an unstyled vertical gallery outside viewport geometry",async({page})=>{
  const slides=Array.from({length:12},(_,index)=>`<div data-scope="carousel" data-part="item" data-index="${index}" aria-roledescription="slide" aria-hidden="${index?'true':'false'}" ${index?'inert':''} style="height:168px">${index===11?'<p>Cette annonce vous intéresse ?</p><button onclick="window.sellerContact=true">Envoyer un message</button>':`<button><img width="160" height="120" alt="Maison propre (image ${index+1})" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${index}.jpg?rule=ad-large"></button>`}</div>`).join('');
  await galleryFixture(page,`<p id="position">1/12</p><div data-scope="carousel" data-part="item-group" style="height:168px;overflow:hidden">${slides}</div><nav><img width="40" height="30" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/foreign.jpg?rule=ad-large"></nav><button aria-label="Suivant" id="next-photo">→</button><button aria-label="Fermer" data-close>×</button>`,'<div style="height:90000px"></div>');
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.evaluate(()=>{let current=1;document.getElementById('next-photo')!.addEventListener('click',()=>{current++;document.getElementById('position')!.textContent=`${current}/12`;for(const slide of document.querySelectorAll('[data-scope="carousel"][data-part="item"]')){const active=slide.getAttribute('data-index')===String(current-1);slide.setAttribute('aria-hidden',active?'false':'true');if(active)slide.removeAttribute('inert');else slide.setAttribute('inert','');}});});
  const result=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(result.walk).toMatchObject({complete:true,stopReason:'all_positions_observed',declaredTotal:12});
  expect(result.walk.positions.slice(0,11).map((position:{activeImages:{url:string}[]})=>position.activeImages.map(image=>image.url))).toEqual(Array.from({length:11},(_,index)=>[`https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${index}.jpg?rule=ad-large`]));
  const last=result.walk.positions[11];
  expect(last).toMatchObject({activeImages:[],mediaKinds:['contact'],activeSlideEvidence:{position:12,dataIndex:11,ariaHidden:'false',inert:false,matchedSlides:1,selectionBasis:'explicit_active_state'},nonPhotoEvidence:{kind:'contact',text:'Cette annonce vous intéresse ? Envoyer un message'}});
  expect(last.activeSlideEvidence.slide.top).toBeGreaterThan(last.activeSlideEvidence.viewport.bottom);
  expect(last.candidateSlideEvidence).toHaveLength(1);
  expect(await page.evaluate(()=>Object.hasOwn(window,'sellerContact'))).toBe(false);
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
});

test("v7 retains rejected native candidates without accepting hidden, inert, conflicting or unmarked offscreen slides",async({page})=>{
  for(const attributes of ['aria-hidden="true"','aria-hidden="false" inert','aria-hidden="false" aria-current="false"','aria-hidden="false" data-state="inactive"','']){
    await galleryFixture(page,`<p>1/12</p><div data-scope="carousel" data-part="item-group" style="position:relative;height:168px;overflow:hidden"><div data-scope="carousel" data-part="item" data-index="0" ${attributes} style="position:absolute;top:400px;width:500px;height:168px"><p>Cette annonce vous intéresse ?</p><button>Envoyer un message</button></div></div><button aria-label="Fermer" data-close>×</button>`);
    await page.evaluate(leboncoinOpenGalleryWalk);
    const result=await page.evaluate(leboncoinWalkAndCloseGallery);
    expect(result.walk).toMatchObject({complete:false,stopReason:'next_missing'});
    expect(result.walk.positions[0]).not.toHaveProperty('activeSlideEvidence');
    expect(result.walk.positions[0]).not.toHaveProperty('nonPhotoEvidence');
    expect(result.walk.positions[0].candidateSlideEvidence).toEqual([expect.objectContaining({position:1,dataIndex:0,slide:expect.any(Object),viewport:expect.any(Object)})]);
    expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
  }
});

test("v7 waits for the new native slide to leave inert after counter and images change",async({page})=>{
  const slides=Array.from({length:12},(_,index)=>`<div data-scope="carousel" data-part="item" data-index="${index}" aria-roledescription="slide" aria-hidden="${index?'true':'false'}" ${index?'inert':''} style="height:168px">${index===11?'<p>Cette annonce vous intéresse ?</p><button>Envoyer un message</button>':`<button><img width="160" height="120" alt="Maison propre (image ${index+1})" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-${index}.jpg?rule=ad-large"></button>`}</div>`).join('');
  await galleryFixture(page,`<p id="position">1/12</p><div data-scope="carousel" data-part="item-group" style="height:168px;overflow:hidden">${slides}</div><button aria-label="Suivant" id="next-photo">→</button><button aria-label="Fermer" data-close>×</button>`);
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.evaluate(()=>{
    let current=1;
    document.documentElement.dataset.transitionErrors='0';
    document.documentElement.dataset.transitionsSettled='0';
    document.getElementById('next-photo')!.addEventListener('click',()=>{
      if(document.querySelector(`[data-part="item"][data-index="${current-1}"]`)!.hasAttribute('inert'))document.documentElement.dataset.transitionErrors=String(Number(document.documentElement.dataset.transitionErrors)+1);
      current++;document.getElementById('position')!.textContent=`${current}/12`;
      for(const slide of document.querySelectorAll('[data-scope="carousel"][data-part="item"]')){slide.setAttribute('aria-hidden',slide.getAttribute('data-index')===String(current-1)?'false':'true');slide.setAttribute('inert','');}
      const nextSlide=document.querySelector(`[data-part="item"][data-index="${current-1}"]`)!;
      setTimeout(()=>{nextSlide.removeAttribute('inert');document.documentElement.dataset.transitionsSettled=String(Number(document.documentElement.dataset.transitionsSettled)+1);},500);
    });
  });
  const result=await page.evaluate(leboncoinWalkAndCloseGallery);
  expect(result.walk).toMatchObject({complete:true,stopReason:'all_positions_observed',declaredTotal:12});
  expect(result.walk.positions.slice(0,11).map((position:{activeImages:unknown[]})=>position.activeImages.length)).toEqual(Array(11).fill(1));
  expect(result.walk.positions.every((position:{activeSlideEvidence:{inert:boolean}})=>position.activeSlideEvidence.inert===false)).toBe(true);
  expect(result.walk.positions[11]).toMatchObject({mediaKinds:['contact'],nonPhotoEvidence:{kind:'contact'}});
  await expect(page.locator('html')).toHaveAttribute('data-transition-errors','0');
  await expect(page.locator('html')).toHaveAttribute('data-transitions-settled','11');
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
});

test("v7 recognizes only an exact own-listing business card contact panel and never follows its reply link",async({page})=>{
  const cases=[
    {marker:true,href:'/reply/123',label:'Contacter',photo:false,accepted:true},
    {marker:true,href:'/reply/999',label:'Contacter',photo:false,accepted:false},
    {marker:false,href:'/reply/123',label:'Contacter',photo:false,accepted:false},
    {marker:true,href:'https://other.example/reply/123',label:'Contacter',photo:false,accepted:false},
    {marker:true,href:'/reply/123',label:'Contacter',photo:true,accepted:false},
  ];
  for(const variant of cases){
    await galleryFixture(page,`<p>1/1</p><div data-scope="carousel" data-part="item-group"><div data-scope="carousel" data-part="item" data-index="0" aria-hidden="false"><div ${variant.marker?'data-qa-id="business-card-slide"':''}><img width="96" height="96" alt="" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/agency-logo.jpg?rule=bo-logo"><p>Agence locale</p><a href="${variant.href}" onclick="window.sellerContact=true">${variant.label}</a>${variant.photo?'<button><img width="160" height="120" alt="Maison propre (image 1)" src="https://img.leboncoin.fr/api/v1/lbcpb1/images/own-0.jpg?rule=ad-large"></button>':''}</div></div></div><button aria-label="Fermer" data-close>×</button>`);
    await page.evaluate(leboncoinOpenGalleryWalk);
    const result=await page.evaluate(leboncoinWalkAndCloseGallery),position=result.walk.positions[0];
    if(variant.accepted){
      expect(position).toMatchObject({activeImages:[],mediaKinds:['contact'],nonPhotoEvidence:{kind:'contact',text:'Agence locale Contacter',businessCard:{selector:'[data-qa-id="business-card-slide"]',replyUrl:'https://www.leboncoin.fr/reply/123',linkText:'Contacter'}}});
      expect(position.activeSlideEvidence.html).toContain('href="/reply/123"');
    }else expect(position).not.toHaveProperty('nonPhotoEvidence');
    expect(await page.evaluate(()=>Object.hasOwn(window,'sellerContact'))).toBe(false);
    expect(page.url()).toBe(repairUrl);
    expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
  }
});

test("v7 leaves an already complete two-photo native inventory alone and honors its operation deadline",async({page})=>{
  await galleryFixture(page,'<p>1/12</p><button aria-label="Image suivante">→</button><button aria-label="Fermer" data-close>×</button>');
  await page.evaluate(()=>{const node=document.querySelector("script#__NEXT_DATA__")!;const value=JSON.parse(node.textContent!);value.props.pageProps.ad.images.urls=value.props.pageProps.ad.images.urls.slice(0,2);value.props.pageProps.ad.images.urls_large=value.props.pageProps.ad.images.urls_large.slice(0,2);value.props.pageProps.ad.images.nb_images=2;node.textContent=JSON.stringify(value);document.getElementById("own-gallery")!.textContent="Voir les photos";});
  const complete=await page.evaluate(leboncoinOpenGalleryWalk);
  expect(complete).toMatchObject({inventory:{images:{declaredCount:2,inventoryComplete:true}},galleryOpening:{clicked:false,reason:"native_inventory_complete"}});
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(leboncoinVerifyGalleryWalkClosed);
  await page.evaluate(()=>document.getElementById("own-gallery")!.textContent="Voir les 12 photos");
  await page.evaluate(leboncoinOpenGalleryWalk);
  await page.evaluate(()=>{(window as unknown as {__collectorGalleryWalkV7:{deadline:number}}).__collectorGalleryWalkV7.deadline=Date.now()-1;});
  expect((await page.evaluate(leboncoinWalkAndCloseGallery)).walk).toMatchObject({complete:false,stopReason:"deadline",positions:[]});
  expect(await page.evaluate(leboncoinVerifyGalleryWalkClosed)).toMatchObject({closed:true,restoredDetail:true});
});
