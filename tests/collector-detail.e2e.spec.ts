import { expect, test, type Page } from "@playwright/test";
import { leboncoinExpandDescription } from "../apps/collector-api/src/leboncoin-detail.js";

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
