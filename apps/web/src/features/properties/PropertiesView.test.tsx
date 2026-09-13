import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denicheurApi, DenicheurApiError } from "../../api/denicheurApi";
import { queryKeys } from "../../api/queryKeys";
import { AppIntlProvider, localeStorageKey } from "../../intl/IntlContext";
import type { PropertyListing } from "../../types";
import { PropertiesView } from "./PropertiesView";

const clients: QueryClient[] = [];

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("PropertiesView", () => {
  it("returns keyboard focus to the selected row after closing the dossier", async () => {
    installApi([listing("Maison du port")]);
    renderProperties();
    const trigger = await screen.findByRole("button", { name: /^Maison du port/u });
    trigger.focus();
    fireEvent.click(trigger);
    const dossier = await screen.findByRole("complementary", { name: "Fiche du bien" });
    await waitFor(() => expect(dossier).toHaveFocus());
    fireEvent.keyDown(dossier, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("complementary", { name: "Fiche du bien" })).not.toBeInTheDocument();
  });

  it("keeps an unavailable linked property keyboard-accessible and restores focus to the catalog", async () => {
    const { detail } = installApi([listing("Other property")]);
    detail.mockRejectedValue(new Error("Unavailable"));
    renderProperties();
    await screen.findByRole("table");
    act(() => {
      window.history.replaceState({}, "", "/?view=properties&pid=leboncoin%3Amissing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const panel = await screen.findByRole("complementary", { name: "Fiche du bien" });
    await waitFor(() => expect(panel).toHaveFocus());
    await within(panel).findByRole("alert");
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Biens", level: 1 })).toHaveFocus());
    expect(new URLSearchParams(window.location.search).has("pid")).toBe(false);
  });

  it("requests global server sorting and preserves the returned order", async () => {
    const { list } = installApi([listing("Unknown"), listing("Low"), listing("High")]);
    renderProperties();
    const table = await screen.findByRole("table", { name: "Table" });
    list.mockResolvedValue({ items: [listing("High"), listing("Low"), listing("Unknown")], total: 300, nextCursor: "next" });
    fireEvent.click(within(table).getByRole("button", { name: "Prix" }));
    await waitFor(() => expect(rowTitles(table)).toEqual(["High", "Low", "Unknown"]));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "priceEuros", order: "desc", limit: 50 }), expect.any(AbortSignal));
    fireEvent.click(within(table).getByRole("button", { name: "Prix" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "priceEuros", order: "asc" }), expect.any(AbortSignal)));
  });

  it("traverses bounded pages, preserves the selected detail and restarts an expired snapshot without discarding the last page", async () => {
    const first = listing("First");
    const second = listing("Second");
    const { list } = installApi([first, second]);
    list.mockImplementation(async (filters) => filters?.cursor
      ? { items: [second], total: 5000, nextCursor: "third" }
      : { items: [first], total: 5000, nextCursor: "second" });
    renderProperties();
    fireEvent.click(await screen.findByRole("button", { name: /^First/u }));
    await screen.findByRole("heading", { name: "First" });
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    await waitFor(() => expect(rowTitles(screen.getByRole("table"))).toEqual(["Second"]));
    expect(screen.getByRole("heading", { name: "First" })).toBeInTheDocument();
    list.mockRejectedValueOnce(new DenicheurApiError("Expired", 410, "CURSOR_EXPIRED"));
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cette liste a expiré");
    expect(rowTitles(screen.getByRole("table"))).toEqual(["Second"]);
    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(rowTitles(screen.getByRole("table"))).toEqual(["First"]));
    expect(screen.getByRole("button", { name: "Précédent" })).toBeDisabled();
    expect(list.mock.calls.filter(([filters]) => !filters?.cursor)).toHaveLength(2);
  });

  it("keeps all-catalog source facets and persists source filters and card sorting", async () => {
    const { list } = installApi([listing("First")]);
    renderProperties("cards");
    fireEvent.click(screen.getByRole("button", { name: "Filtres" }));
    fireEvent.click(await screen.findByRole("button", { name: /^leboncoin 4\s500$/u }));
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sources: ["leboncoin"] }), expect.any(AbortSignal)));
    expect(new URLSearchParams(window.location.search).get("psources")).toBe("leboncoin");
    fireEvent.change(screen.getByRole("combobox", { name: "Trier les biens" }), { target: { value: "surface:desc" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "surfaceM2", order: "desc" }), expect.any(AbortSignal)));
  });

  it("reports incomplete details and loads them when the user retries", async () => {
    const home = listing("Maison du port");
    const { detail } = installApi([home]);
    detail.mockRejectedValueOnce(new Error("Service unavailable"));
    renderProperties();
    fireEvent.click(await screen.findByRole("button", { name: /^Maison du port/u }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Les informations affichées peuvent être incomplètes ou anciennes.");
    expect(screen.getByRole("heading", { name: "Maison du port" })).toBeInTheDocument();
    detail.mockResolvedValue({ ...home, description: "Jardin clos avec vue sur le port." });
    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));

    expect(await screen.findByText("Jardin clos avec vue sur le port.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["table", "cards"] as const)("keeps cached %s results usable after a refresh failure and recovers on retry", async (mode) => {
    const home = listing("Maison du port");
    const { list } = installApi([home]);
    const client = renderProperties(mode);
    fireEvent.click(await screen.findByRole("button", { name: mode === "table" ? /^Maison du port/u : "Afficher le détail de Maison du port" }));
    await screen.findByRole("heading", { name: "Maison du port" });
    list.mockRejectedValueOnce(new Error("Service unavailable"));

    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.listings.lists() });
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Les dernières données chargées restent affichées.");
    const selection = screen.getByRole("button", {
      name: mode === "table" ? /Maison du port/u : "Afficher le détail de Maison du port",
    });
    expect(selection).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Maison du port" })).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("loads a visible row's gallery and changes photos without opening the property", async () => {
    let reveal: (() => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        reveal = () => callback([{ isIntersecting: true }]);
      }
      observe() {}
      disconnect() {}
    });
    const home = listing("Maison du port", {
      externalId: "12345",
      location: "Plouhinec · Saint-Dreyer",
      imageUrls: ["https://example.com/cover.jpg"],
    });
    const { detail } = installApi([home]);
    detail.mockResolvedValue({ ...home, imageUrls: [...home.imageUrls, "https://example.com/garden.jpg"] });
    renderProperties();
    const table = await screen.findByRole("table");
    expect(detail).not.toHaveBeenCalled();
    act(() => reveal?.());
    const next = await within(table).findByRole("button", { name: "Photo suivante de Maison du port" });
    fireEvent.click(next);
    expect(within(table).getByRole("img")).toHaveAttribute("src", "https://example.com/garden.jpg");
    expect(screen.queryByRole("heading", { name: home.title })).not.toBeInTheDocument();
    expect(within(table).getByText(home.location!)).toBeInTheDocument();
    expect(within(table).queryByText(/12345/u)).not.toBeInTheDocument();
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(within(table).getByRole("img")).toHaveAttribute("src", "https://example.com/cover.jpg");
  });

  it("combines search with added filters and resets pagination", async () => {
    const { list } = installApi([listing("Maison")]);
    list.mockResolvedValue({ items: [listing("Maison")], total: 100, nextCursor: "next" });
    renderProperties();
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Rechercher" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "tregunc" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Rechercher" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "tregunc", cursor: undefined }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole("button", { name: "Filtres" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Ajouter un filtre" }), { target: { value: "priceMax" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Prix maximum (€)" }), { target: { value: "400000" } });
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: "tregunc", priceMax: 400000 }), expect.any(AbortSignal)));
    expect(new URLSearchParams(window.location.search).get("pq")).toBe("tregunc");
    fireEvent.click(screen.getByRole("button", { name: "Effacer la recherche : tregunc" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ q: undefined, priceMax: 400000 }), expect.any(AbortSignal)));
  });

  it("shows a retry state when the initial list request fails", async () => {
    const { list } = installApi([listing("Maison du port")]);
    list.mockRejectedValueOnce(new Error("Service unavailable"));
    renderProperties();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Impossible de charger les biens.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));

    expect(await screen.findByRole("table", { name: "Table" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function renderProperties(mode = "table") {
  window.localStorage.setItem(localeStorageKey, "fr");
  window.history.replaceState({}, "", `/?view=properties&pmode=${mode}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><AppIntlProvider><PropertiesView /></AppIntlProvider></QueryClientProvider>);
  return client;
}

function installApi(listings: PropertyListing[]) {
  vi.spyOn(denicheurApi, "listingsMetadata").mockResolvedValue({ value: { revision: "1", total: 5000, sources: [{ source: "leboncoin", count: 4500 }] } });
  return {
    list: vi.spyOn(denicheurApi, "listProperties").mockResolvedValue({ items: listings, total: listings.length, nextCursor: null }),
    detail: vi.spyOn(denicheurApi, "getProperty").mockImplementation(async (_source, externalId) => {
      const result = listings.find((item) => item.externalId === externalId);
      if (!result) throw new Error("Listing not found");
      return result;
    }),
  };
}

function listing(title: string, overrides: Partial<PropertyListing> = {}): PropertyListing {
  return {
    key: `leboncoin:${title}`,
    externalId: title,
    source: "leboncoin",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123456",
    title,
    imageUrls: [],
    features: [],
    runs: [],
    evaluations: [],
    ...overrides,
  };
}

function rowTitles(table: HTMLElement) {
  return Array.from(table.querySelectorAll("tbody tr strong"), (title) => title.textContent);
}
