import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppIntlProvider, localeStorageKey } from "../../intl/IntlContext";
import type { PropertyListing } from "../../types";
import { MapView } from "./MapView";

const mapRuntime = vi.hoisted(() => ({ create: vi.fn(), fail: false }));
const query = vi.hoisted(() => ({ items: [] as PropertyListing[] }));

vi.mock("../../api/hooks", () => ({
  useMapListings: () => ({ data: { items: query.items }, isSuccess: true, isFetching: false }),
  useListing: () => ({}),
}));

vi.mock("maplibre-gl", () => ({
  Map: class {
    constructor({ container }: { container: HTMLElement }) {
      mapRuntime.create();
      container.append(document.createElement("canvas"));
      if (mapRuntime.fail) throw new Error("WebGL unavailable");
    }
    addControl() {}
    on() {}
    getSource() { return undefined; }
    getZoom() { return 7; }
    getCenter() { return { lng: -4, lat: 48 }; }
    getBounds() {
      return { getWest: () => -6, getSouth: () => 47, getEast: () => 0, getNorth: () => 50 };
    }
    resize() {}
    isMoving() { return false; }
    remove() {}
  },
  NavigationControl: class {},
  Marker: class {},
}));

function renderMap() {
  return render(<AppIntlProvider><MapView /></AppIntlProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(localeStorageKey, "en");
  window.history.replaceState({}, "", "/?view=map");
  mapRuntime.create.mockClear();
  mapRuntime.fail = false;
  query.items = ["Maison", "Appartement"].map((propertyType, index) => ({
    key: `leboncoin:${index}`, source: "leboncoin", externalId: String(index),
    title: propertyType, propertyType, url: "https://www.leboncoin.fr/",
    imageUrls: [], features: [], runs: [], evaluations: [],
    coordinates: {
      longitude: -4.486, latitude: 48.391, locationKind: "source-property",
      provenance: "fixture", verifiedAt: "2026-07-18T12:00:00.000Z",
    },
  }));
});

afterEach(cleanup);

describe("map recovery and navigation", () => {
  it("bounds the sidebar to 30 results while keeping every matching listing reachable", async () => {
    query.items = Array.from({ length: 1000 }, (_, index) => ({ ...query.items[0]!, key: `leboncoin:${index}`, externalId: String(index), title: `Home ${index}` }));
    renderMap();
    expect(screen.getAllByRole("button", { name: /^Show details for Home/ })).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Show details for Home 30" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show details for Home 0" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Show details for Home/ })).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByRole("button", { name: "Show details for Home 0" })).toBeInTheDocument();
  });

  it("discards failed canvas setup when changing locale", async () => {
    mapRuntime.fail = true;
    renderMap();
    await screen.findByRole("alert");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: localeStorageKey, newValue: "fr" }));
    });
    await waitFor(() => expect(mapRuntime.create).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("region", { name: "Carte de Bretagne et des biens immobiliers" }).querySelectorAll("canvas")).toHaveLength(1);
  });

  it("reports an asynchronous map startup failure and retries without losing listings", async () => {
    mapRuntime.fail = true;
    renderMap();
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("The map could not start.");
    expect(screen.getByRole("button", { name: "Show details for Maison" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Map of Brittany and property listings" })).toHaveAttribute("aria-busy", "false");

    mapRuntime.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mapRuntime.create).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Map of Brittany and property listings" }).querySelectorAll("canvas")).toHaveLength(1);
  });

  it("restores map filters on remount and browser history navigation", async () => {
    const view = renderMap();
    const typeFilter = screen.getByRole("combobox", { name: "Property type" });
    fireEvent.change(typeFilter, { target: { value: "Maison" } });
    expect(new URLSearchParams(window.location.search).get("mtype")).toBe("Maison");
    expect(screen.queryByRole("button", { name: "Show details for Appartement" })).not.toBeInTheDocument();
    view.unmount();

    renderMap();
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("Maison");
    await act(async () => {
      window.history.replaceState({}, "", "/?view=map&mtype=Appartement");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("combobox", { name: "Property type" })).toHaveValue("Appartement");
    expect(screen.getByRole("button", { name: "Show details for Appartement" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show details for Maison" })).not.toBeInTheDocument();
  });
});
