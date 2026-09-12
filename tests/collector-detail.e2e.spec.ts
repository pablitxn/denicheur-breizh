import { expect, test, type Page } from "@playwright/test";
import { leboncoinExpandDescription, leboncoinPrepareDetailRepair, leboncoinObserveDetailRepair } from "../apps/collector-api/src/leboncoin-detail.js";

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
