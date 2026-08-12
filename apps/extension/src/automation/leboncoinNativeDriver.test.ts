import { beforeEach, describe, expect, it, vi } from "vitest";
import { isContentRequest, type NativeSearchFilters } from "../lib/messages";
import { LeboncoinNativeDriver } from "./leboncoinNativeDriver";

const FILTERS: NativeSearchFilters = {
  category: "9",
  text: "vue mer",
  locationQuery: "Finistère",
  propertyTypes: ["1", "2"],
  ownerType: "private",
  priceMax: 120_000,
  roomsMin: 2,
  roomsMax: 3,
  bedroomsMax: 2,
  sort: "time",
  order: "desc",
};

const MULTI_STAGE_RESULTS_TEST_TIMEOUT_MS = 10_000;

describe("LeboncoinNativeDriver home search", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState({}, "", "/");
  });

  it("uses the visible header search and ignores the portaled recent-search list", async () => {
    const harness = installAccessibleHome();
    const driver = immediateDriver();

    const prepared = await driver.prepareHomeSearch(FILTERS);
    const action = driver.armHomeSearchSubmission();

    expect(prepared).toMatchObject({
      type: "LBC_NATIVE_SEARCH_RESULT",
      phase: "home-prepared",
      ok: true,
      applied: ["text"],
      omitted: ["category", "locationQuery"],
      warnings: [],
    });
    expect(harness.cookieClicks).toHaveBeenCalledOnce();
    expect(harness.headerActivations).toHaveBeenCalledOnce();
    expect(harness.recentSearchClicks).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#header-search")?.value).toBe("vue mer");
    expect(document.querySelector("#category-trigger")).toBeNull();
    expect(document.querySelector('input[name="location"]')).toBeNull();
    expect(harness.submitClicks).not.toHaveBeenCalled();
    expect(action.response).toMatchObject({ phase: "home-submitted", ok: true });

    await action.execute();
    await action.execute();

    expect(harness.submitClicks).toHaveBeenCalledOnce();
    expect(driver.armHomeSearchSubmission().response).toMatchObject({
      phase: "home-submitted",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "The native home search was already submitted.",
      },
    });
  });

  it("prepares an empty keyword search without inventing category or location controls", async () => {
    const harness = installAccessibleHome({ includeConsent: false });
    const driver = immediateDriver();
    const response = await driver.prepareHomeSearch({
      ...FILTERS,
      text: "",
    });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: true,
      applied: [],
      omitted: ["category", "locationQuery"],
    });
    expect(harness.headerActivations).not.toHaveBeenCalled();
    expect(harness.recentSearchClicks).not.toHaveBeenCalled();
    expect(driver.armHomeSearchSubmission().response).toMatchObject({ ok: true });
  });

  it("defers a navigable page category control instead of touching it before home submit", async () => {
    const harness = installAccessibleHome({ includeConsent: false });
    const searchRoot = document.querySelector<HTMLElement>("#header-search-form")!;
    searchRoot.replaceWith(...Array.from(searchRoot.childNodes));
    const categoryLink = document.createElement("a");
    categoryLink.href = "/c/ventes_immobilieres";
    categoryLink.role = "button";
    categoryLink.setAttribute("aria-haspopup", "menu");
    categoryLink.textContent = "Immobilier";
    const categoryClicks = vi.fn((event: Event) => event.preventDefault());
    categoryLink.addEventListener("click", categoryClicks);
    document.body.append(categoryLink);
    const driver = immediateDriver();

    const response = await driver.prepareHomeSearch({ ...FILTERS, text: "" });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: true,
      applied: [],
      omitted: ["category", "locationQuery"],
      warnings: [],
    });
    expect(categoryClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();

    await driver.armHomeSearchSubmission().execute();
    expect(harness.submitClicks).toHaveBeenCalledOnce();
  });

  it("applies native category and unique location controls before the single home submit", async () => {
    const harness = installAccessibleHome({ includeNativeFilters: true });
    const driver = immediateDriver();

    const prepared = await driver.prepareHomeSearch(FILTERS);

    expect(prepared).toMatchObject({
      phase: "home-prepared",
      ok: true,
      applied: ["text", "category", "locationQuery"],
      omitted: [],
      warnings: [],
    });
    expect(harness.categoryOptionClicks).toHaveBeenCalledOnce();
    expect(harness.locationOptionClicks).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>("#home-location")?.value).toBe("Finistère (29)");
    expect(harness.submitClicks).not.toHaveBeenCalled();

    const action = driver.armHomeSearchSubmission();
    expect(action.response).toMatchObject({ phase: "home-submitted", ok: true });
    await action.execute();
    await action.execute();

    expect(harness.submitClicks).toHaveBeenCalledOnce();
  });

  it("rejects a category option that never stabilizes across observations", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeNativeFilters: true });
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        const root = document.querySelector<HTMLElement>("#home-category-options");
        const option = document.querySelector<HTMLElement>("#home-category-sale");
        if (!root || root.hidden || !option) return;
        option.replaceWith(option.cloneNode(true));
      },
    });

    const response = await driver.prepareHomeSearch({ ...FILTERS, text: "" });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: 'The native category option "Ventes immobilières" did not stabilize.',
      },
    });
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("does not activate a home filter control that can submit or navigate before the ACK", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeNativeFilters: true });
    const option = document.querySelector<HTMLButtonElement>("#home-category-sale")!;
    option.type = "submit";

    const response = await immediateDriver().prepareHomeSearch({ ...FILTERS, text: "" });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "The native home category control may navigate before search submission.",
      },
    });
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("rejects a location autocomplete that replaces the same-looking option", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeNativeFilters: true });
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        const root = document.querySelector<HTMLElement>("#home-location-options");
        const option = document.querySelector<HTMLElement>("#home-location-finistere");
        if (!root || root.hidden || !option) return;
        option.replaceWith(option.cloneNode(true));
      },
    });

    const response = await driver.prepareHomeSearch({ ...FILTERS, text: "" });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      applied: ["category"],
      error: {
        id: "error.nativeInteraction",
        technicalDetail: 'The native location suggestion for "Finistère" did not stabilize.',
      },
    });
    expect(harness.categoryOptionClicks).toHaveBeenCalledOnce();
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("stops immediately when a challenge appears while observing location suggestions", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeNativeFilters: true });
    let challengeMounted = false;
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        const root = document.querySelector<HTMLElement>("#home-location-options");
        if (challengeMounted || !root || root.hidden) return;
        challengeMounted = true;
        mountDataDomeIframe();
      },
    });

    const response = await driver.prepareHomeSearch({ ...FILTERS, text: "" });

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      challenge: { type: "unusual-activity" },
    });
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("blocks an unequivocal cookie banner when no supported accept control exists", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeNativeFilters: true });
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div role="dialog" aria-label="Consentement aux cookies">
        <p>Vos préférences de cookies et de confidentialité</p>
        <button type="button">Gérer mes choix</button>
      </div>`,
    );

    const response = await immediateDriver().prepareHomeSearch(FILTERS);

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "A visible cookie consent banner has no supported accept control.",
      },
    });
    expect(harness.headerActivations).not.toHaveBeenCalled();
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("propagates a restriction challenge without touching the page", async () => {
    document.body.innerHTML = `
      <main>Accès temporairement restreint</main>
      <button id="accept-cookies">Tout accepter</button>
    `;
    const click = vi.fn();
    document.querySelector("button")?.addEventListener("click", click);

    const response = await immediateDriver().prepareHomeSearch(FILTERS);

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      challenge: {
        type: "unusual-activity",
        evidence: "restriction-copy",
      },
    });
    expect(click).not.toHaveBeenCalled();
  });

  it("stops with unusual activity when DataDome appears during keyword entry", async () => {
    const harness = installAccessibleHome({ includeConsent: false });
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        mountDataDomeIframe();
      },
    });

    const response = await driver.prepareHomeSearch(FILTERS);

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      challenge: { type: "unusual-activity" },
    });
    expect(response.error).toBeUndefined();
    expect(harness.recentSearchClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("fails before submission when the visible header has no submit control", async () => {
    const harness = installAccessibleHome({ includeConsent: false, includeSubmit: false });

    const response = await immediateDriver().prepareHomeSearch(FILTERS);

    expect(response).toMatchObject({
      phase: "home-prepared",
      ok: false,
      applied: [],
      error: {
        id: "error.nativeInteraction",
        technicalDetail: expect.stringMatching(
          /home search controls did not open|search submit control was not found/iu,
        ),
      },
    });
    expect(harness.recentSearchClicks).not.toHaveBeenCalled();
    expect(harness.submitClicks).not.toHaveBeenCalled();
  });

  it("keeps a challenged post-ACK home submit rearmable until one click executes", async () => {
    const harness = installAccessibleHome({ includeConsent: false });
    let injectCaptchaOnNextSleep = false;
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        if (!injectCaptchaOnNextSleep) return;
        injectCaptchaOnNextSleep = false;
        mountManualCaptcha();
      },
    });
    const prepared = await driver.prepareHomeSearch({
      ...FILTERS,
      text: "",
    });
    expect(prepared.ok).toBe(true);

    const firstAction = driver.armHomeSearchSubmission();
    expect(firstAction.response).toMatchObject({ phase: "home-submitted", ok: true });
    injectCaptchaOnNextSleep = true;
    const firstError = await captureActionError(firstAction.execute);
    driver.recordQueuedActionFailure("home-submitted", firstError);

    const queued = driver.getQueuedActionFailure();
    expect.soft(queued).toMatchObject({
      phase: "home-submitted",
      ok: false,
      actionExecuted: false,
      challenge: {
        type: "captcha",
        evidence: "human-verification-copy",
      },
    });
    document.querySelector("#runtime-captcha")?.remove();

    const retryAction = driver.armHomeSearchSubmission();
    expect.soft(retryAction.response).toMatchObject({ phase: "home-submitted", ok: true });
    if (retryAction.response.ok) await retryAction.execute();

    expect.soft(harness.submitClicks).toHaveBeenCalledOnce();
  });
});

describe("LeboncoinNativeDriver result filters", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState({}, "", "/recherche?fixture=native-search");
  });

  it("stages location, category, and the AX-realistic property control before navigation", async () => {
    const harness = installAccessibleResults();
    const driver = immediateDriver();

    const locationPrepared = await driver.prepareResultsFilters(FILTERS);
    expect(locationPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: [],
      step: "location",
      navigationExpected: true,
    });
    const locationAction = driver.armResultsFilterApplication();
    expect(locationAction.response).toMatchObject({ step: "location", navigationExpected: true });
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    await locationAction.execute();
    expect(harness.locationOptionClicks).toHaveBeenCalledOnce();

    const categoryPrepared = await driver.prepareResultsFilters(FILTERS);
    expect(categoryPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery"],
      step: "category",
      navigationExpected: true,
    });
    expect(harness.categoryTriggerClicks).toHaveBeenCalledOnce();
    expect(harness.categoryGroupClicks).toHaveBeenCalledOnce();
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.outsideCategoryClicks).not.toHaveBeenCalled();
    await driver.armResultsFilterApplication().execute();
    expect(harness.categoryOptionClicks).toHaveBeenCalledOnce();

    const propertyPrepared = await driver.prepareResultsFilters(FILTERS);
    expect(propertyPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category"],
      step: "property-types",
      navigationExpected: true,
    });
    expect(harness.propertyTypeTriggerClicks).toHaveBeenCalledOnce();
    expect(harness.propertyTypeValidationClicks).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#house")?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#apartment")?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#private")?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#price-max")?.value).toBe("");
    expect(document.querySelector<HTMLElement>('[data-room="2"]')?.getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector<HTMLElement>('[data-room="3"]')?.getAttribute("aria-pressed")).toBe("false");

    const propertyAction = driver.armResultsFilterApplication();
    expect(propertyAction.response).toMatchObject({
      phase: "results-applied",
      ok: true,
      step: "property-types",
      navigationExpected: true,
    });
    await propertyAction.execute();
    expect(harness.propertyTypeValidationClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.getAll("real_estate_type")).toEqual(["1", "2"]);
    expect(harness.roomNavigationClicks).not.toHaveBeenCalled();
    expect(harness.bedroomNavigationClicks).not.toHaveBeenCalled();
  }, MULTI_STAGE_RESULTS_TEST_TIMEOUT_MS);

  it.each([
    {
      name: "removes a selected extra",
      requested: ["1"],
      expected: ["1"],
    },
    {
      name: "clears stale selections when no property type is requested",
      requested: [],
      expected: [],
    },
  ])("converges the AX-hidden property checkboxes exactly: $name", async ({ requested, expected }) => {
    const harness = installAccessibleResults();
    primeCommittedResultsState();
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      propertyTypes: requested,
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category"],
      step: "property-types",
      navigationExpected: true,
    });
    expect(harness.propertyTypeTriggerClicks).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>("#house")?.checked).toBe(requested.includes("1"));
    expect(document.querySelector<HTMLInputElement>("#apartment")?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#land")?.checked).toBe(false);
    expect(harness.propertyTypeValidationClicks).not.toHaveBeenCalled();

    await driver.armResultsFilterApplication().execute();

    expect(harness.propertyTypeValidationClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.getAll("real_estate_type")).toEqual(expected);
  });

  it("uses the property validation captured from its own root instead of a global decoy", async () => {
    const harness = installAccessibleResults();
    primeCommittedResultsState();
    document.body.insertAdjacentHTML("afterbegin", '<button id="global-validate" type="button">Valider</button>');
    const decoyClicks = vi.fn();
    document.querySelector("#global-validate")?.addEventListener("click", decoyClicks);
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters({ ...FILTERS, propertyTypes: ["1"] });
    expect(prepared).toMatchObject({ ok: true, step: "property-types", navigationExpected: true });

    await driver.armResultsFilterApplication().execute();

    expect(harness.propertyTypeValidationClicks).toHaveBeenCalledOnce();
    expect(decoyClicks).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.getAll("real_estate_type")).toEqual(["1"]);
  });

  it("revalidates a committed location from the observed URL and page title when its input is hidden", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#results-location")?.remove();
    document.querySelector<HTMLElement>("#sort-options")?.removeAttribute("hidden");
    document.title = "Maison à vendre et vente appartement Finistère (29) - leboncoin";
    const url = new URL(window.location.href);
    url.searchParams.delete("location");
    url.searchParams.set("locations", "d_29");
    window.history.replaceState({}, "", url);
    const driver = immediateDriver();

    const response = await driver.prepareResultsFilters({
      ...FILTERS,
      roomsMin: undefined,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(response).toMatchObject({
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes", "sort"],
      step: "complete",
      navigationExpected: false,
    });
  });

  it("stages an external native sort select after closing filters and dispatches input/change", async () => {
    const harness = installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#sort-trigger")?.remove();
    document.querySelector("#sort-options")?.remove();
    document.querySelector("header")?.insertAdjacentHTML(
      "beforeend",
      `<label for="external-sort">Tri</label>
       <select id="external-sort" name="sort">
         <option value="relevance-desc" selected>Pertinence</option>
         <option value="time-desc">Plus récentes</option>
         <option value="time-asc">Plus anciennes</option>
       </select>`,
    );
    const inputEvents = vi.fn();
    const changeEvents = vi.fn();
    const sort = document.querySelector<HTMLSelectElement>("#external-sort")!;
    sort.addEventListener("input", inputEvents);
    sort.addEventListener("change", changeEvents);
    const filters: NativeSearchFilters = {
      ...FILTERS,
      roomsMin: undefined,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
    };
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters(filters);
    expect(prepared).toMatchObject({
      ok: true,
      step: "filters",
      navigationExpected: true,
      omitted: [],
    });
    expect(prepared.warnings).toEqual([]);
    expect(harness.closeFilterClicks).toHaveBeenCalledOnce();
    expect(sort.value).toBe("relevance-desc");

    await driver.armResultsFilterApplication().execute();

    expect(sort.value).toBe("time-desc");
    expect(inputEvents).toHaveBeenCalledOnce();
    expect(changeEvents).toHaveBeenCalledOnce();

    const verified = await driver.prepareResultsFilters(filters);
    expect(verified).toMatchObject({
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes", "sort"],
      step: "complete",
      navigationExpected: false,
      omitted: [],
    });
    expect(verified.warnings).toEqual([]);
  });

  it("does not treat a non-interactive sort fallback wrapper as a native control", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#sort-trigger")?.remove();
    document.querySelector("#sort-options")?.remove();
    document.querySelector("header")?.insertAdjacentHTML(
      "beforeend",
      '<div data-testid="sort-control">Tri : Pertinence</div>',
    );

    const response = await immediateDriver().prepareResultsFilters({
      ...FILTERS,
      roomsMin: undefined,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
    });

    expect(response).toMatchObject({
      ok: true,
      step: "complete",
      navigationExpected: false,
      omitted: ["sort"],
      warnings: [expect.objectContaining({ field: "sort" })],
    });
  });

  it("commits Pièces minimum and maximum through separate navigations before advanced filters", async () => {
    const harness = installAccessibleResults();
    primeCommittedResultsState();
    const filters: NativeSearchFilters = {
      ...FILTERS,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
    };
    const driver = immediateDriver();

    const roomsMinPrepared = await driver.prepareResultsFilters(filters);
    expect(roomsMinPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes"],
      step: "rooms-min",
      navigationExpected: true,
    });
    expect(document.querySelector<HTMLElement>('[data-room="2"]')?.textContent).toBe("Sélectionner 2");
    expect(harness.bedroomNavigationClicks).not.toHaveBeenCalled();
    await driver.armResultsFilterApplication().execute();
    expect(harness.roomNavigationClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-2");
    expect(document.querySelector<HTMLElement>('[data-room="3"]')?.textContent).toBe("Sélectionner entre 2 et 3");

    const roomsMaxPrepared = await driver.prepareResultsFilters(filters);
    expect(roomsMaxPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes", "roomsMin"],
      step: "rooms-max",
      navigationExpected: true,
    });
    expect(harness.bedroomNavigationClicks).not.toHaveBeenCalled();
    await driver.armResultsFilterApplication().execute();
    expect(harness.roomNavigationClicks).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-3");
    expect(new URL(window.location.href).searchParams.get("bedrooms")).toBeNull();
    expect(harness.bedroomNavigationClicks).not.toHaveBeenCalled();

    const prepared = await driver.prepareResultsFilters(filters);
    const action = driver.armResultsFilterApplication();

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: [
        "locationQuery",
        "category",
        "propertyTypes",
        "roomsMin",
        "roomsMax",
        "sort",
      ],
      omitted: [],
      step: "filters",
      navigationExpected: true,
    });
    expect(prepared.warnings).toEqual([]);
    expect(harness.filterTriggerClicks).toHaveBeenCalledTimes(3);
    expect(harness.propertyTypeTriggerClicks).not.toHaveBeenCalled();
    expect(harness.propertyTypeValidationClicks).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#house")?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#apartment")?.checked).toBe(true);
    expect(document.querySelector<HTMLElement>('[data-room="2"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLElement>('[data-room="3"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(harness.bedroomNavigationClicks).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#sort-time-desc")?.checked).toBe(true);
    expect(action.response).toMatchObject({
      phase: "results-applied",
      ok: true,
      step: "filters",
      navigationExpected: true,
    });
    expect(harness.applyClicks).not.toHaveBeenCalled();

    await action.execute();
    await action.execute();

    expect(harness.applyClicks).toHaveBeenCalledOnce();

    const verified = await driver.prepareResultsFilters(filters);
    expect(verified).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "complete",
      navigationExpected: false,
    });
    expect(harness.applyClicks).toHaveBeenCalledOnce();
    expect(harness.closeFilterClicks).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>("#filter-dialog")?.hidden).toBe(true);
  });

  it("opens the collapsed Nombre de pièces group and accepts unit-bearing option names", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    const previousRooms = document.querySelector<HTMLElement>("#rooms-filter")!;
    previousRooms.insertAdjacentHTML(
      "beforebegin",
      `
        <button
          id="rooms-filter-trigger"
          type="button"
          aria-controls="rooms-filter-live"
          aria-expanded="false"
        >Ouvrir le filtre Nombre de pièces</button>
        <fieldset id="rooms-filter-live" hidden>
          <legend>Nombre de pièces</legend>
          <button type="button" data-live-room="1" aria-pressed="false" aria-label="Sélectionner 1 pièce">1</button>
          <button type="button" data-live-room="2" aria-pressed="false" aria-label="Sélectionner 2 pièces">2</button>
          <button type="button" data-live-room="3" aria-pressed="false" aria-label="Sélectionner 3 pièces">3</button>
        </fieldset>
      `,
    );
    previousRooms.remove();
    const trigger = document.querySelector<HTMLButtonElement>("#rooms-filter-trigger")!;
    const drawer = document.querySelector<HTMLElement>("#rooms-filter-live")!;
    const triggerClicks = vi.fn(() => {
      drawer.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    });
    const roomClicks = vi.fn((event: Event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLElement)) return;
      const value = button.dataset.liveRoom;
      if (!value) return;
      const url = new URL(window.location.href);
      url.searchParams.set("rooms", `${value}-${value}`);
      window.history.replaceState({}, "", url);
    });
    trigger.addEventListener("click", triggerClicks);
    document.querySelectorAll<HTMLElement>("[data-live-room]")
      .forEach((button) => button.addEventListener("click", roomClicks));
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      propertyTypes: ["1", "2"],
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "rooms-min",
      navigationExpected: true,
    });
    expect(prepared.warnings).toEqual([]);
    expect(triggerClicks).toHaveBeenCalledOnce();
    expect(roomClicks).not.toHaveBeenCalled();

    await driver.armResultsFilterApplication().execute();

    expect(roomClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-2");
  });

  it("waits for the live Pièces controls after the filter shell opens", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#rooms-filter")?.remove();
    let filterOpened = false;
    let roomsMounted = false;
    let rangePolls = 0;
    document.querySelector("#filters")?.addEventListener("click", () => {
      filterOpened = true;
    });
    const roomClicks = vi.fn((event: Event) => {
      const button = event.currentTarget;
      if (!(button instanceof HTMLElement)) return;
      const value = button.dataset.delayedRoom;
      if (!value) return;
      const url = new URL(window.location.href);
      url.searchParams.set("rooms", `${value}-${value}`);
      window.history.replaceState({}, "", url);
    });
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        if (!filterOpened || roomsMounted) return;
        rangePolls += 1;
        if (rangePolls < 60) return;
        roomsMounted = true;
        document.querySelector("#real-estate-filters")?.insertAdjacentHTML(
          "beforeend",
          `
            <fieldset id="rooms-filter-delayed">
              <h3>Pièces</h3>
              <button type="button" data-delayed-room="1" aria-pressed="false">Sélectionner 1</button>
              <button type="button" data-delayed-room="2" aria-pressed="false">Sélectionner 2</button>
              <button type="button" data-delayed-room="3" aria-pressed="false">Sélectionner 3</button>
            </fieldset>
          `,
        );
        document.querySelectorAll<HTMLElement>("[data-delayed-room]")
          .forEach((button) => button.addEventListener("click", roomClicks));
      },
    });

    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "rooms-min",
      navigationExpected: true,
    });
    expect(prepared.warnings).toEqual([]);
    expect(roomsMounted).toBe(true);
    expect(rangePolls).toBeGreaterThanOrEqual(60);

    await driver.armResultsFilterApplication().execute();

    expect(roomClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-2");
  }, 15_000);

  it("scopes Pièces choices before Chambres when both groups share one wrapper", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#rooms-filter")?.remove();
    document.querySelector("#bedrooms-filter")?.remove();
    document.querySelector("#real-estate-filters")?.insertAdjacentHTML(
      "beforeend",
      `
        <div id="shared-range-wrapper">
          <h3>Pièces</h3>
          <div>
            <button type="button" data-shared-room="1" aria-pressed="false">Sélectionner 1</button>
            <button type="button" data-shared-room="2" aria-pressed="false">Sélectionner 2</button>
            <button type="button" data-shared-room="3" aria-pressed="false">Sélectionner 3</button>
          </div>
          <h3>Chambres</h3>
          <div>
            <button type="button" data-shared-bedroom="1" aria-pressed="false">Sélectionner 1</button>
            <button type="button" data-shared-bedroom="2" aria-pressed="false">Sélectionner 2</button>
            <button type="button" data-shared-bedroom="3" aria-pressed="false">Sélectionner 3</button>
          </div>
        </div>
      `,
    );
    const roomTwoClicks = vi.fn();
    const otherRoomClicks = vi.fn();
    const bedroomClicks = vi.fn();
    document.querySelector("[data-shared-room='2']")?.addEventListener("click", roomTwoClicks);
    document.querySelectorAll<HTMLElement>("[data-shared-room]:not([data-shared-room='2'])")
      .forEach((button) => button.addEventListener("click", otherRoomClicks));
    document.querySelectorAll<HTMLElement>("[data-shared-bedroom]")
      .forEach((button) => button.addEventListener("click", bedroomClicks));
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "rooms-min",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();

    expect(roomTwoClicks).toHaveBeenCalledOnce();
    expect(otherRoomClicks).not.toHaveBeenCalled();
    expect(bedroomClicks).not.toHaveBeenCalled();
  });

  it("prefers the on-screen Pièces controls over earlier duplicate range groups", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#rooms-filter")?.remove();
    document.querySelector("#bedrooms-filter")?.remove();
    document.querySelector("#real-estate-filters")?.insertAdjacentHTML(
      "beforeend",
      `
        <div data-range-copy="zero-size">
          <h3>Pièces</h3>
          <button type="button" data-zero-room="2" aria-pressed="false">Sélectionner 2</button>
          <h3>Chambres</h3>
          <button type="button" data-zero-bedroom="2" aria-pressed="false">Sélectionner 2</button>
        </div>
        <div data-range-copy="off-screen">
          <h3>Pièces</h3>
          <button type="button" data-offscreen-room="2" aria-pressed="false">Sélectionner 2</button>
          <h3>Chambres</h3>
          <button type="button" data-offscreen-bedroom="2" aria-pressed="false">Sélectionner 2</button>
        </div>
        <div data-range-copy="on-screen">
          <h3>Pièces</h3>
          <button type="button" data-onscreen-room="2" aria-label="Sélectionner" aria-pressed="false"><span>2</span></button>
          <h3>Chambres</h3>
          <button type="button" data-onscreen-bedroom="2" aria-label="Sélectionner" aria-pressed="false"><span>2</span></button>
        </div>
      `,
    );

    document.querySelectorAll<HTMLElement>('[data-range-copy="zero-size"] *')
      .forEach((element) => mockRenderedRect(element, { left: 0, top: 0, width: 0, height: 0 }));
    document.querySelectorAll<HTMLElement>('[data-range-copy="off-screen"] *')
      .forEach((element) => mockRenderedRect(element, { left: -400, top: 20, width: 100, height: 32 }));
    document.querySelectorAll<HTMLElement>('[data-range-copy="on-screen"] *')
      .forEach((element) => mockRenderedRect(element, { left: 20, top: 20, width: 100, height: 32 }));

    const zeroSizeClicks = vi.fn();
    const offscreenClicks = vi.fn();
    const onscreenRoomClicks = vi.fn();
    const onscreenBedroomClicks = vi.fn();
    document.querySelectorAll<HTMLElement>("[data-zero-room], [data-zero-bedroom]")
      .forEach((button) => button.addEventListener("click", zeroSizeClicks));
    document.querySelectorAll<HTMLElement>("[data-offscreen-room], [data-offscreen-bedroom]")
      .forEach((button) => button.addEventListener("click", offscreenClicks));
    document.querySelector("[data-onscreen-room]")?.addEventListener("click", onscreenRoomClicks);
    document.querySelector("[data-onscreen-bedroom]")?.addEventListener("click", onscreenBedroomClicks);

    const driver = immediateDriver();
    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "rooms-min",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();

    expect(zeroSizeClicks).not.toHaveBeenCalled();
    expect(offscreenClicks).not.toHaveBeenCalled();
    expect(onscreenRoomClicks).toHaveBeenCalledOnce();
    expect(onscreenBedroomClicks).not.toHaveBeenCalled();
  });

  it("maps sibling numeric labels to their ordered Pièces buttons", async () => {
    installAccessibleResults();
    primeCommittedResultsState();
    document.querySelector("#rooms-filter")?.remove();
    document.querySelector("#bedrooms-filter")?.remove();
    const choices = (prefix: string) => Array.from({ length: 8 }, (_, index) => {
      const value = index + 1;
      return `<span data-range-choice="${prefix}-${value}">` +
        `<button type="button" data-${prefix}="${value}" aria-label="Sélectionner" aria-pressed="false"></button>` +
        `<span>${value === 8 ? "8+" : value}</span>` +
        "</span>";
    }).join("");
    document.querySelector("#real-estate-filters")?.insertAdjacentHTML(
      "beforeend",
      `<div data-range-copy="sibling-labels">` +
        `<h3>Pièces</h3><button type="button" data-room-decoy aria-label="Sélectionner"></button>${choices("sibling-room")}` +
        `<h3>Chambres</h3><button type="button" data-bedroom-decoy aria-label="Sélectionner"></button>${choices("sibling-bedroom")}` +
        "</div>",
    );

    const expectedRoomClick = vi.fn();
    const otherRoomClick = vi.fn();
    const bedroomClick = vi.fn();
    const decoyClick = vi.fn();
    document.querySelector('[data-sibling-room="2"]')?.addEventListener("click", expectedRoomClick);
    document.querySelectorAll<HTMLElement>('[data-sibling-room]:not([data-sibling-room="2"])')
      .forEach((button) => button.addEventListener("click", otherRoomClick));
    document.querySelectorAll<HTMLElement>("[data-sibling-bedroom]")
      .forEach((button) => button.addEventListener("click", bedroomClick));
    document.querySelectorAll<HTMLElement>("[data-room-decoy], [data-bedroom-decoy]")
      .forEach((button) => button.addEventListener("click", decoyClick));

    const driver = immediateDriver();
    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      roomsMax: undefined,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
      sort: "relevance",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "rooms-min",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();

    expect(expectedRoomClick).toHaveBeenCalledOnce();
    expect(otherRoomClick).not.toHaveBeenCalled();
    expect(bedroomClick).not.toHaveBeenCalled();
    expect(decoyClick).not.toHaveBeenCalled();
  });

  it("removes stale Pièces boundaries before converging to the requested range", async () => {
    const harness = installAccessibleResults();
    primeCommittedResultsState({ rooms: "1-4" });
    const filters: NativeSearchFilters = {
      ...FILTERS,
      bedroomsMax: undefined,
      ownerType: "all",
      priceMax: undefined,
    };
    const driver = immediateDriver();

    const minimum = await driver.prepareResultsFilters(filters);
    expect(minimum).toMatchObject({ ok: true, step: "rooms-min", navigationExpected: true });
    expect(document.querySelector<HTMLElement>('[data-room="1"]')?.textContent).toBe("Désélectionner 1");
    await driver.armResultsFilterApplication().execute();
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-4");

    const maximum = await driver.prepareResultsFilters(filters);
    expect(maximum).toMatchObject({ ok: true, step: "rooms-max", navigationExpected: true });
    expect(document.querySelector<HTMLElement>('[data-room="4"]')?.textContent).toBe("Désélectionner 4");
    await driver.armResultsFilterApplication().execute();

    expect(harness.roomNavigationClicks).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.get("rooms")).toBe("2-3");
  });

  it("scopes duplicated range names to Chambres without touching Pièces", async () => {
    const harness = installAccessibleResults();
    primeCommittedResultsState({ rooms: "2-3" });
    const filters: NativeSearchFilters = {
      ...FILTERS,
      ownerType: "all",
      priceMax: undefined,
    };
    const driver = immediateDriver();

    const bedroomsMinPrepared = await driver.prepareResultsFilters(filters);
    expect(bedroomsMinPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes", "roomsMin", "roomsMax"],
      step: "bedrooms-min",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();
    expect(harness.roomNavigationClicks).not.toHaveBeenCalled();
    expect(harness.bedroomNavigationClicks).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).searchParams.get("bedrooms")).toBe("1-1");
    expect(document.querySelector<HTMLElement>('[data-bedroom="2"]')?.textContent).toBe("Sélectionner entre 1 et 2");

    const bedroomsMaxPrepared = await driver.prepareResultsFilters(filters);
    expect(bedroomsMaxPrepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      applied: ["locationQuery", "category", "propertyTypes", "roomsMin", "roomsMax"],
      step: "bedrooms-max",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();
    expect(harness.roomNavigationClicks).not.toHaveBeenCalled();
    expect(harness.bedroomNavigationClicks).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.get("bedrooms")).toBe("1-2");
  });

  it("selects a unique prefixed category inside Immobilier and never touches the page decoy", async () => {
    const harness = installAccessibleResults({
      categoryLabels: ["Ventes immobilières 128 420 annonces"],
    });
    const driver = immediateDriver();

    const prepared = await driver.prepareResultsFilters({
      ...FILTERS,
      locationQuery: "",
    });

    expect(prepared).toMatchObject({
      phase: "results-prepared",
      ok: true,
      step: "category",
      navigationExpected: true,
    });
    await driver.armResultsFilterApplication().execute();
    expect(harness.categoryOptionClicks).toHaveBeenCalledOnce();
    expect(harness.outsideCategoryClicks).not.toHaveBeenCalled();
  });

  it("rejects APPLY on a fresh results driver before any step was prepared", async () => {
    const harness = installAccessibleResults();
    const driver = immediateDriver();

    const action = driver.armResultsFilterApplication();

    expect(action.response).toMatchObject({
      phase: "results-applied",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "Results filters must be prepared before they can be applied.",
      },
    });
    await action.execute();
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.propertyTypeValidationClicks).not.toHaveBeenCalled();
    expect(harness.applyClicks).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing",
      categoryLabels: ["Locations"],
      error: /category option.*not found/iu,
    },
    {
      name: "ambiguous",
      categoryLabels: ["Ventes immobilières", "Ventes immobilières"],
      error: /category option.*ambiguous|ambiguous.*category option/iu,
    },
  ])("blocks before navigation when the results category target is $name", async ({ categoryLabels, error }) => {
    const harness = installAccessibleResults({ categoryLabels });

    const response = await immediateDriver().prepareResultsFilters({
      ...FILTERS,
      locationQuery: "",
    });

    expect(response).toMatchObject({
      phase: "results-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: expect.stringMatching(error),
      },
    });
    expect(harness.categoryTriggerClicks).toHaveBeenCalledOnce();
    expect(harness.categoryOptionClicks).not.toHaveBeenCalled();
    expect(harness.outsideCategoryClicks).not.toHaveBeenCalled();
    expect(harness.applyClicks).not.toHaveBeenCalled();
  });

  it("blocks an ambiguous result-location autocomplete before opening filters", async () => {
    const harness = installAccessibleResults({
      locationSuggestions: ["Paris (75)", "Paris 15e"],
    });

    const response = await immediateDriver().prepareResultsFilters({
      ...FILTERS,
      locationQuery: "Paris",
    });

    expect(response).toMatchObject({
      phase: "results-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: 'Location "Paris" is ambiguous; choose a more precise city or department.',
      },
    });
    expect(harness.locationOptionClicks).not.toHaveBeenCalled();
    expect(harness.filterTriggerClicks).not.toHaveBeenCalled();
    expect(harness.applyClicks).not.toHaveBeenCalled();
  });

  it("returns a blocking error when advanced filters have no final search control", async () => {
    const harness = installAccessibleResults({ includeApply: false });
    const driver = immediateDriver();
    await advanceToAdvancedResults(driver, FILTERS);

    const response = await driver.prepareResultsFilters(FILTERS);

    expect(response).toMatchObject({
      phase: "results-prepared",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "The native results filter apply control was not found.",
      },
    });
    expect(response.applied.length).toBeGreaterThan(0);
    expect(harness.applyClicks).not.toHaveBeenCalled();
  }, 10_000);

  it("keeps a challenged post-ACK location commit rearmable until one click executes", async () => {
    const harness = installAccessibleResults();
    let injectCaptchaOnNextSleep = false;
    const driver = new LeboncoinNativeDriver({
      document,
      random: () => 0,
      sleep: async () => {
        if (!injectCaptchaOnNextSleep) return;
        injectCaptchaOnNextSleep = false;
        mountManualCaptcha();
      },
    });
    const prepared = await driver.prepareResultsFilters(FILTERS);
    expect(prepared).toMatchObject({ ok: true, step: "location" });

    const firstAction = driver.armResultsFilterApplication();
    expect(firstAction.response).toMatchObject({ phase: "results-applied", ok: true });
    injectCaptchaOnNextSleep = true;
    const firstError = await captureActionError(firstAction.execute);
    driver.recordQueuedActionFailure("results-applied", firstError);

    const queued = driver.getQueuedActionFailure();
    expect.soft(queued).toMatchObject({
      phase: "results-applied",
      ok: false,
      actionExecuted: false,
      challenge: { type: "captcha" },
    });
    document.querySelector("#runtime-captcha")?.remove();

    const retryAction = driver.armResultsFilterApplication();
    expect.soft(retryAction.response).toMatchObject({
      phase: "results-applied",
      ok: true,
      step: "location",
    });
    if (retryAction.response.ok) await retryAction.execute();

    expect.soft(harness.locationOptionClicks).toHaveBeenCalledOnce();
  });
});

describe("LeboncoinNativeDriver results pagination", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "Résultats";
    window.history.replaceState({}, "", "/recherche?page=1");
  });

  it("prepares and advances the enabled native next-page control exactly once", async () => {
    document.body.innerHTML = `
      <nav aria-label="Pagination">
        <a aria-current="page" href="/recherche?page=1">1</a>
        <a id="next-page" rel="next" aria-label="Page suivante" href="/recherche?page=2">Suivant</a>
      </nav>
    `;
    const nextPageClicks = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("#next-page")?.addEventListener("click", nextPageClicks);
    const driver = immediateDriver();

    const prepared = await driver.prepareNextResultsPage();
    const action = driver.armNextResultsPage();

    expect(prepared).toMatchObject({
      phase: "pagination-prepared",
      ok: true,
      hasNextPage: true,
    });
    expect(action.response).toMatchObject({
      phase: "pagination-advanced",
      ok: true,
      hasNextPage: true,
      navigationExpected: true,
    });
    expect(nextPageClicks).not.toHaveBeenCalled();

    await action.execute();
    await action.execute();

    expect(nextPageClicks).toHaveBeenCalledOnce();
    expect(driver.armNextResultsPage().response).toMatchObject({
      phase: "pagination-advanced",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "The native results page was already advanced.",
      },
    });
  });

  it("reports the end of results for a disabled next control and ignores page decoys", async () => {
    document.body.innerHTML = `
      <button aria-label="Suivant">Carousel suivant</button>
      <nav aria-label="Pagination">
        <a aria-current="page" href="/recherche?page=3">3</a>
        <button aria-label="Page suivante" aria-disabled="true">Suivant</button>
      </nav>
    `;
    const driver = immediateDriver();

    expect(await driver.prepareNextResultsPage()).toMatchObject({
      phase: "pagination-prepared",
      ok: true,
      hasNextPage: false,
      warnings: [],
    });
    expect(driver.armNextResultsPage().response).toMatchObject({
      phase: "pagination-advanced",
      ok: false,
      error: {
        id: "error.nativeInteraction",
        technicalDetail: "The current results page has no next page.",
      },
    });
  });
});

describe("isContentRequest", () => {
  it("accepts the complete native protocol and rejects malformed filter payloads", () => {
    expect(isContentRequest({ type: "LBC_PREPARE_HOME_SEARCH", filters: FILTERS })).toBe(true);
    expect(isContentRequest({ type: "LBC_SUBMIT_HOME_SEARCH" })).toBe(true);
    expect(isContentRequest({ type: "LBC_PREPARE_RESULTS_FILTERS", filters: FILTERS })).toBe(true);
    expect(isContentRequest({ type: "LBC_APPLY_RESULTS_FILTERS" })).toBe(true);
    expect(isContentRequest({ type: "LBC_PREPARE_NEXT_RESULTS_PAGE" })).toBe(true);
    expect(isContentRequest({ type: "LBC_GO_NEXT_RESULTS_PAGE" })).toBe(true);
    expect(isContentRequest({ type: "LBC_COLLECT_SEARCH_RESULTS", limit: 100 })).toBe(true);
    expect(isContentRequest({ type: "LBC_COLLECT_SEARCH_RESULTS", limit: 101 })).toBe(false);
    expect(isContentRequest({
      type: "LBC_PREPARE_HOME_SEARCH",
      filters: { ...FILTERS, locationQuery: 29 },
    })).toBe(false);
  });
});

async function advanceToAdvancedResults(
  driver: LeboncoinNativeDriver,
  filters: NativeSearchFilters,
): Promise<void> {
  const location = await driver.prepareResultsFilters(filters);
  expect(location).toMatchObject({ ok: true, step: "location" });
  await driver.armResultsFilterApplication().execute();

  const category = await driver.prepareResultsFilters(filters);
  expect(category).toMatchObject({ ok: true, step: "category" });
  await driver.armResultsFilterApplication().execute();

  const propertyTypes = await driver.prepareResultsFilters(filters);
  expect(propertyTypes).toMatchObject({ ok: true, step: "property-types" });
  await driver.armResultsFilterApplication().execute();

  const roomsMin = await driver.prepareResultsFilters(filters);
  expect(roomsMin).toMatchObject({ ok: true, step: "rooms-min" });
  await driver.armResultsFilterApplication().execute();

  const roomsMax = await driver.prepareResultsFilters(filters);
  expect(roomsMax).toMatchObject({ ok: true, step: "rooms-max" });
  await driver.armResultsFilterApplication().execute();

  const bedroomsMin = await driver.prepareResultsFilters(filters);
  expect(bedroomsMin).toMatchObject({ ok: true, step: "bedrooms-min" });
  await driver.armResultsFilterApplication().execute();

  const bedroomsMax = await driver.prepareResultsFilters(filters);
  expect(bedroomsMax).toMatchObject({ ok: true, step: "bedrooms-max" });
  await driver.armResultsFilterApplication().execute();
}

function primeCommittedResultsState({
  bedrooms,
  rooms,
}: {
  bedrooms?: string;
  rooms?: string;
} = {}): void {
  const location = document.querySelector<HTMLInputElement>("#results-location");
  if (location) location.value = "Finistère (29)";
  const categoryTrigger = document.querySelector<HTMLElement>("#category-trigger");
  if (categoryTrigger) categoryTrigger.textContent = "Ventes immobilières";
  const realEstateFilters = document.querySelector<HTMLElement>("#real-estate-filters");
  if (realEstateFilters) realEstateFilters.hidden = false;
  for (const selector of ["#house", "#apartment"]) {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (input) input.checked = true;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("location", "Finistère (29)");
  url.searchParams.set("category", "9");
  url.searchParams.delete("real_estate_type");
  url.searchParams.append("real_estate_type", "1");
  url.searchParams.append("real_estate_type", "2");
  if (rooms) url.searchParams.set("rooms", rooms);
  if (bedrooms) url.searchParams.set("bedrooms", bedrooms);
  window.history.replaceState({}, "", url);

  syncPrimedRange("[data-room]", "room", rooms);
  syncPrimedRange("[data-bedroom]", "bedroom", bedrooms);
}

function syncPrimedRange(
  selector: "[data-room]" | "[data-bedroom]",
  dataKey: "room" | "bedroom",
  raw: string | undefined,
): void {
  const match = raw?.match(/^(\d+)(?:-(\d+))?$/u);
  const minimum = Number(match?.[1]);
  const maximum = Number(match?.[2] ?? match?.[1]);
  document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
    const value = Number(button.dataset[dataKey] ?? "0");
    const selected = Boolean(match && value >= minimum && value <= maximum);
    button.setAttribute("aria-pressed", String(selected));
    button.textContent = selected ? `Désélectionner ${value}` : `Sélectionner ${value}`;
  });
}

function immediateDriver(): LeboncoinNativeDriver {
  return new LeboncoinNativeDriver({
    document,
    sleep: async () => undefined,
    random: () => 0,
  });
}

function mockRenderedRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: rect.top + rect.height,
    height: rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  });
}

function mountDataDomeIframe(): void {
  const iframe = document.createElement("iframe");
  iframe.title = "DataDome CAPTCHA";
  iframe.src = "https://geo.captcha-delivery.com/captcha/?initialCid=redacted";
  document.body.append(iframe);
}

function mountManualCaptcha(): void {
  const captcha = document.createElement("section");
  captcha.id = "runtime-captcha";
  captcha.textContent = "Vérifiez que vous êtes humain";
  document.body.append(captcha);
}

async function captureActionError(action: () => Promise<void>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the native action to stop for a challenge.");
}

interface AccessibleHomeOptions {
  includeConsent?: boolean;
  includeNativeFilters?: boolean;
  includeSubmit?: boolean;
}

interface AccessibleHomeHarness {
  cookieClicks: ReturnType<typeof vi.fn>;
  categoryOptionClicks: ReturnType<typeof vi.fn>;
  headerActivations: ReturnType<typeof vi.fn>;
  locationOptionClicks: ReturnType<typeof vi.fn>;
  recentSearchClicks: ReturnType<typeof vi.fn>;
  submitClicks: ReturnType<typeof vi.fn>;
}

function installAccessibleHome({
  includeConsent = true,
  includeNativeFilters = false,
  includeSubmit = true,
}: AccessibleHomeOptions = {}): AccessibleHomeHarness {
  document.body.innerHTML = `
    ${includeConsent ? `
      <div id="consent" role="dialog" aria-label="Consentement aux cookies">
        <p>Vos préférences de cookies</p>
        <button id="accept-cookies" type="button">Tout accepter</button>
      </div>
    ` : ""}
    <main>
      <form id="header-search-form" role="search">
        <input
          id="header-search"
          type="search"
          name="query"
          role="combobox"
          aria-label="Rechercher sur leboncoin"
          aria-autocomplete="list"
          aria-controls="recent-searches"
          aria-expanded="false"
        />
        ${includeNativeFilters ? `
          <button
            id="home-category-trigger"
            type="button"
            aria-haspopup="menu"
            aria-controls="home-category-options"
            aria-expanded="false"
          >Catégories</button>
          <div id="home-category-options" role="menu" aria-label="Catégories" hidden>
            <button
              id="home-category-sale"
              type="button"
              role="menuitemradio"
              aria-checked="false"
            >Ventes immobilières</button>
          </div>
          <label for="home-location">Où cherchez-vous ?</label>
          <input
            id="home-location"
            name="location"
            role="combobox"
            aria-controls="home-location-options"
            aria-expanded="false"
          />
          <div id="home-location-options" role="listbox" aria-label="Suggestions de localisation" hidden>
            <button id="home-location-finistere" type="button" role="option">Finistère (29)</button>
          </div>
        ` : ""}
        ${includeSubmit ? `
          <button id="search-submit" type="button" aria-label="Valider votre recherche">
            Valider votre recherche
          </button>
        ` : ""}
      </form>
    </main>
    <div id="recent-searches" role="listbox" aria-label="Recherches récentes" hidden>
      <button id="recent-search-option" type="button" role="option">Maison avec jardin</button>
    </div>
  `;

  const consent = document.querySelector<HTMLElement>("#consent");
  const headerSearch = document.querySelector<HTMLInputElement>("#header-search")!;
  const recentSearches = document.querySelector<HTMLElement>("#recent-searches")!;
  const categoryTrigger = document.querySelector<HTMLButtonElement>("#home-category-trigger");
  const categoryOptions = document.querySelector<HTMLElement>("#home-category-options");
  const categoryOption = document.querySelector<HTMLElement>("#home-category-sale");
  const location = document.querySelector<HTMLInputElement>("#home-location");
  const locationOptions = document.querySelector<HTMLElement>("#home-location-options");
  const locationOption = document.querySelector<HTMLElement>("#home-location-finistere");

  const cookieClicks = vi.fn(() => consent?.remove());
  const categoryOptionClicks = vi.fn(() => {
    categoryOption?.setAttribute("aria-checked", "true");
    if (categoryTrigger) {
      categoryTrigger.textContent = "Ventes immobilières";
      categoryTrigger.setAttribute("aria-expanded", "false");
    }
    if (categoryOptions) categoryOptions.hidden = true;
  });
  const headerActivations = vi.fn(() => {
    if (!recentSearches.hidden) return;
    recentSearches.hidden = false;
    headerSearch.setAttribute("aria-expanded", "true");
  });
  const recentSearchClicks = vi.fn();
  const locationOptionClicks = vi.fn(() => {
    if (location) {
      location.value = "Finistère (29)";
      location.setAttribute("aria-expanded", "false");
    }
    locationOption?.setAttribute("aria-selected", "true");
    if (locationOptions) locationOptions.hidden = true;
  });
  const submitClicks = vi.fn((event: Event) => event.preventDefault());

  document.querySelector("#accept-cookies")?.addEventListener("click", cookieClicks);
  categoryTrigger?.addEventListener("click", () => {
    if (categoryOptions) categoryOptions.hidden = false;
    categoryTrigger.setAttribute("aria-expanded", "true");
  });
  categoryOption?.addEventListener("click", categoryOptionClicks);
  headerSearch.addEventListener("focus", headerActivations);
  headerSearch.addEventListener("click", headerActivations);
  document.querySelector("#recent-search-option")?.addEventListener("click", recentSearchClicks);
  location?.addEventListener("input", () => {
    if (locationOptions) locationOptions.hidden = false;
    location.setAttribute("aria-expanded", "true");
  });
  locationOption?.addEventListener("click", locationOptionClicks);
  document.querySelector("#search-submit")?.addEventListener("click", submitClicks);

  return {
    cookieClicks,
    categoryOptionClicks,
    headerActivations,
    locationOptionClicks,
    recentSearchClicks,
    submitClicks,
  };
}

interface AccessibleResultsOptions {
  categoryLabels?: string[];
  includeApply?: boolean;
  includeOwner?: boolean;
  locationSuggestions?: string[];
}

interface AccessibleResultsHarness {
  applyClicks: ReturnType<typeof vi.fn>;
  bedroomNavigationClicks: ReturnType<typeof vi.fn>;
  categoryGroupClicks: ReturnType<typeof vi.fn>;
  categoryOptionClicks: ReturnType<typeof vi.fn>;
  categoryTriggerClicks: ReturnType<typeof vi.fn>;
  closeFilterClicks: ReturnType<typeof vi.fn>;
  filterTriggerClicks: ReturnType<typeof vi.fn>;
  locationOptionClicks: ReturnType<typeof vi.fn>;
  outsideCategoryClicks: ReturnType<typeof vi.fn>;
  propertyTypeTriggerClicks: ReturnType<typeof vi.fn>;
  propertyTypeValidationClicks: ReturnType<typeof vi.fn>;
  roomNavigationClicks: ReturnType<typeof vi.fn>;
}

function installAccessibleResults({
  categoryLabels = ["Ventes immobilières"],
  includeApply = true,
  includeOwner = true,
  locationSuggestions = ["Finistère (29)"],
}: AccessibleResultsOptions = {}): AccessibleResultsHarness {
  const categoryOptions = categoryLabels.map((label, index) => `
    <button
      id="category-option-${index}"
      type="button"
      role="menuitemradio"
      aria-checked="false"
      data-category="9"
    >${label}</button>
  `).join("");
  const locationOptions = locationSuggestions.map((label, index) => `
    <button id="location-option-${index}" type="button" role="option">${label}</button>
  `).join("");

  document.body.innerHTML = `
    <nav aria-label="Navigation secondaire">
      <button id="outside-category-option" type="button" role="menuitemradio">
        Ventes immobilières
      </button>
    </nav>
    <header>
      <label>Choisir une localisation
        <input
          id="results-location"
          name="location"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="results-location-options"
          aria-expanded="false"
        />
      </label>
      <button id="filters" type="button" data-testid="filter-trigger">
        Afficher tous les filtres
      </button>
    </header>
    <div id="results-location-options" role="listbox" aria-label="Suggestions de localisation" hidden>
      ${locationOptions}
    </div>
    <section id="filter-dialog" aria-label="Tous les filtres" hidden>
      <h2>Tous les filtres</h2>
      <button type="button" aria-label="Fermer">Fermer</button>
      <button
        id="category-trigger"
        type="button"
        aria-haspopup="menu"
        aria-controls="category-drawer"
        aria-expanded="false"
      >Ouvrir le filtre Catégories</button>
      <div id="category-drawer" role="menu" aria-label="Catégories" hidden>
        <button id="category-group" type="button" role="menuitem" aria-haspopup="menu">
          Immobilier
        </button>
        <div id="category-options" role="menu" aria-label="Immobilier" hidden>
          <button type="button" role="menuitem">Revenir au menu des catégories</button>
          ${categoryOptions}
        </div>
      </div>
      <div id="real-estate-filters" hidden>
        <button
          id="property-type-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-controls="property-type-drawer"
          aria-expanded="false"
        >Ouvrir le filtre Type de bien</button>
        <section id="property-type-drawer" aria-label="Type de bien" hidden>
          <h3>Type de bien</h3>
          <label for="house"><span id="house-description">Maison</span></label>
          <input id="house" type="checkbox" name="property-type" value="1" style="opacity: 0" aria-describedby="house-description" />
          <label for="apartment"><span id="apartment-description">Appartement</span></label>
          <input id="apartment" type="checkbox" name="property-type" value="2" style="opacity: 0" aria-describedby="apartment-description" />
          <label for="land"><span id="land-description">Terrain</span></label>
          <input id="land" type="checkbox" name="property-type" value="3" style="opacity: 0" aria-describedby="land-description" />
          <button id="validate-property-types" type="button">Valider</button>
        </section>
        ${includeOwner ? `
          <fieldset>
            <legend>Vendeur</legend>
            <label><input id="private" type="checkbox" name="owner" value="private" /> Particuliers</label>
            <label><input type="checkbox" name="owner" value="pro" /> Professionnels</label>
          </fieldset>
        ` : ""}
        <label>Prix maximum <input id="price-max" name="price_max" /></label>
        <fieldset id="rooms-filter">
          <h3>Pièces</h3>
          <button type="button" data-room="1" aria-pressed="false">Sélectionner 1</button>
          <button type="button" data-room="2" aria-pressed="false">Sélectionner 2</button>
          <button type="button" data-room="3" aria-pressed="false">Sélectionner 3</button>
          <button type="button" data-room="4" aria-pressed="false">Sélectionner 4</button>
        </fieldset>
        <fieldset id="bedrooms-filter">
          <h3>Chambres</h3>
          <button type="button" data-bedroom="1" aria-pressed="false">Sélectionner 1</button>
          <button type="button" data-bedroom="2" aria-pressed="false">Sélectionner 2</button>
          <button type="button" data-bedroom="3" aria-pressed="false">Sélectionner 3</button>
          <button type="button" data-bedroom="4" aria-pressed="false">Sélectionner 4</button>
        </fieldset>
        <button id="sort-trigger" type="button" aria-haspopup="menu" aria-controls="sort-options">Tri</button>
        <fieldset id="sort-options" hidden>
          <legend>Options de tri</legend>
          <label><input type="radio" name="sort" value="relevance-desc" checked /> Pertinence</label>
          <label><input id="sort-time-desc" type="radio" name="sort" value="time-desc" /> Plus récentes</label>
          <label><input type="radio" name="sort" value="time-asc" /> Plus anciennes</label>
        </fieldset>
      </div>
      ${includeApply ? `<button id="apply" type="button" data-testid="apply-filters">Rechercher</button>` : ""}
    </section>
  `;

  const location = document.querySelector<HTMLInputElement>("#results-location")!;
  const locationRoot = document.querySelector<HTMLElement>("#results-location-options")!;
  const filterDialog = document.querySelector<HTMLElement>("#filter-dialog")!;
  const filterClose = filterDialog.querySelector<HTMLButtonElement>('button[aria-label="Fermer"]')!;
  const categoryTrigger = document.querySelector<HTMLButtonElement>("#category-trigger")!;
  const categoryDrawer = document.querySelector<HTMLElement>("#category-drawer")!;
  const categoryOptionsRoot = document.querySelector<HTMLElement>("#category-options")!;
  const realEstateFilters = document.querySelector<HTMLElement>("#real-estate-filters")!;
  const propertyTypeTrigger = document.querySelector<HTMLButtonElement>("#property-type-trigger")!;
  const propertyTypeDrawer = document.querySelector<HTMLElement>("#property-type-drawer")!;

  const applyClicks = vi.fn((event: Event) => event.preventDefault());
  const categoryGroupClicks = vi.fn(() => {
    categoryOptionsRoot.hidden = false;
  });
  const categoryOptionClicks = vi.fn((event: Event) => {
    const option = event.currentTarget;
    if (!(option instanceof HTMLElement)) return;
    option.setAttribute("aria-checked", "true");
    categoryTrigger.textContent = option.textContent?.trim() ?? "Ventes immobilières";
    filterDialog.hidden = true;
    categoryDrawer.hidden = true;
    realEstateFilters.hidden = false;
    const url = new URL(window.location.href);
    url.searchParams.set("category", option.dataset.category ?? "9");
    window.history.replaceState({}, "", url);
  });
  const categoryTriggerClicks = vi.fn(() => {
    categoryDrawer.hidden = false;
    categoryTrigger.setAttribute("aria-expanded", "true");
  });
  const filterTriggerClicks = vi.fn(() => {
    filterDialog.hidden = false;
  });
  const closeFilterClicks = vi.fn(() => {
    filterDialog.hidden = true;
  });
  const locationOptionClicks = vi.fn((event: Event) => {
    const option = event.currentTarget;
    if (!(option instanceof HTMLElement)) return;
    location.value = option.textContent?.trim() ?? "";
    option.setAttribute("aria-selected", "true");
    locationRoot.hidden = true;
    location.setAttribute("aria-expanded", "false");
    const url = new URL(window.location.href);
    url.searchParams.set("location", location.value);
    window.history.replaceState({}, "", url);
  });
  const outsideCategoryClicks = vi.fn();
  const propertyTypeTriggerClicks = vi.fn(() => {
    propertyTypeDrawer.hidden = false;
    propertyTypeTrigger.setAttribute("aria-expanded", "true");
  });
  const propertyTypeValidationClicks = vi.fn(() => {
    propertyTypeDrawer.hidden = true;
    propertyTypeTrigger.setAttribute("aria-expanded", "false");
    filterDialog.hidden = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("real_estate_type");
    document.querySelectorAll<HTMLInputElement>('input[name="property-type"]:checked')
      .forEach((input) => url.searchParams.append("real_estate_type", input.value));
    window.history.replaceState({}, "", url);
  });
  const readRange = (parameter: "rooms" | "bedrooms") => {
    const raw = new URL(window.location.href).searchParams.get(parameter);
    const match = raw?.match(/^(\d+)(?:-(\d+))?$/u);
    return match ? { minimum: Number(match[1]), maximum: Number(match[2] ?? match[1]) } : undefined;
  };
  const syncRange = (
    parameter: "rooms" | "bedrooms",
    selector: "[data-room]" | "[data-bedroom]",
    dataKey: "room" | "bedroom",
  ) => {
    const observed = readRange(parameter);
    document.querySelectorAll<HTMLElement>(selector).forEach((button) => {
      const value = Number(button.dataset[dataKey] ?? "0");
      const selected = Boolean(observed && value >= observed.minimum && value <= observed.maximum);
      button.setAttribute("aria-pressed", String(selected));
      if (selected) {
        button.textContent = `Désélectionner ${value}`;
      } else if (observed && observed.minimum === observed.maximum) {
        button.textContent = `Sélectionner entre ${Math.min(observed.minimum, value)} et ${Math.max(observed.maximum, value)}`;
      } else {
        button.textContent = `Sélectionner ${value}`;
      }
    });
  };
  const commitRange = (
    parameter: "rooms" | "bedrooms",
    event: Event,
    dataKey: "room" | "bedroom",
  ) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement)) return;
    const value = Number(button.dataset[dataKey] ?? "0");
    const observed = readRange(parameter);
    const url = new URL(window.location.href);
    if (observed && /^d[ée]s[ée]lectionner/iu.test(button.textContent ?? "")) {
      if (observed.minimum === observed.maximum) {
        url.searchParams.delete(parameter);
      } else if (value === observed.minimum) {
        url.searchParams.set(parameter, `${observed.minimum + 1}-${observed.maximum}`);
      } else if (value === observed.maximum) {
        url.searchParams.set(parameter, `${observed.minimum}-${observed.maximum - 1}`);
      }
    } else {
      const minimum = observed ? Math.min(observed.minimum, value) : value;
      const maximum = observed ? Math.max(observed.maximum, value) : value;
      url.searchParams.set(parameter, `${minimum}-${maximum}`);
    }
    window.history.replaceState({}, "", url);
    filterDialog.hidden = true;
    syncRange(parameter, parameter === "rooms" ? "[data-room]" : "[data-bedroom]", dataKey);
  };
  const roomNavigationClicks = vi.fn((event: Event) => commitRange("rooms", event, "room"));
  const bedroomNavigationClicks = vi.fn((event: Event) => commitRange("bedrooms", event, "bedroom"));

  location.addEventListener("input", () => {
    locationRoot.hidden = false;
    location.setAttribute("aria-expanded", "true");
  });
  document.querySelectorAll<HTMLElement>("#results-location-options [role='option']")
    .forEach((option) => option.addEventListener("click", locationOptionClicks));
  document.querySelector("#filters")?.addEventListener("click", filterTriggerClicks);
  filterClose.addEventListener("click", closeFilterClicks);
  categoryTrigger.addEventListener("click", categoryTriggerClicks);
  document.querySelector("#category-group")?.addEventListener("click", categoryGroupClicks);
  document.querySelectorAll<HTMLElement>("#category-options [data-category]")
    .forEach((option) => option.addEventListener("click", categoryOptionClicks));
  document.querySelector("#outside-category-option")?.addEventListener("click", outsideCategoryClicks);
  propertyTypeTrigger.addEventListener("click", propertyTypeTriggerClicks);
  document.querySelector("#validate-property-types")?.addEventListener("click", propertyTypeValidationClicks);
  document.querySelectorAll<HTMLElement>("[data-room]")
    .forEach((room) => room.addEventListener("click", roomNavigationClicks));
  document.querySelectorAll<HTMLElement>("[data-bedroom]")
    .forEach((bedroom) => bedroom.addEventListener("click", bedroomNavigationClicks));
  document.querySelector("#sort-trigger")?.addEventListener("click", () => {
    const sortOptions = document.querySelector<HTMLElement>("#sort-options");
    if (sortOptions) sortOptions.hidden = false;
  });
  document.querySelector("#apply")?.addEventListener("click", applyClicks);

  return {
    applyClicks,
    bedroomNavigationClicks,
    categoryGroupClicks,
    categoryOptionClicks,
    categoryTriggerClicks,
    filterTriggerClicks,
    closeFilterClicks,
    locationOptionClicks,
    outsideCategoryClicks,
    propertyTypeTriggerClicks,
    propertyTypeValidationClicks,
    roomNavigationClicks,
  };
}
