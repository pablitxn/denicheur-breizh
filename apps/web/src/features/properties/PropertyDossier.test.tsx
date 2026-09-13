import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { denicheurApi } from "../../api/denicheurApi";
import { AppIntlProvider, localeStorageKey } from "../../intl/IntlContext";
import type { ListingEvaluation, PropertyListing } from "../../types";
import { PropertyDossier } from "./PropertyDossier";

const clients: QueryClient[] = [];

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(localeStorageKey, "es");
  window.history.replaceState({}, "", "/?view=properties&pid=leboncoin%3A123&pq=port");
  vi.spyOn(denicheurApi, "listRecipes").mockResolvedValue([]);
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("PropertyDossier", () => {
  it("keeps the server score separate from coverage and resolves names from the evaluated recipe version", async () => {
    const evaluation: ListingEvaluation = {
      listingId: "leboncoin:123", runId: "run-1", recipeId: "coastal-home", recipeVersion: 1,
      evaluatedAt: "2026-09-12T10:00:00.000Z", decision: "relevant", score: 100,
      summary: "El precio cumple; faltan datos para valorar el resto.", missingData: [],
      criteria: [
        { criterionId: "budget", verdict: "pass", reason: "Está dentro del presupuesto.", evidence: ["325 000 €"] },
        { criterionId: "private-garden", verdict: "unknown", reason: "No consta si el jardín es privado.", evidence: [] },
        { criterionId: "sea-view", verdict: "unknown", reason: "Falta confirmar la vista desde la vivienda.", evidence: [] },
      ],
    };
    const recipes = vi.mocked(denicheurApi.listRecipes).mockResolvedValue([2, 1].map((version) => ({
      id: "coastal-home", version, name: "Casa costera", active: version === 2, threshold: 70,
      criteria: [{
        id: "budget", name: version === 1 ? "Presupuesto hasta 400.000 €" : "Presupuesto hasta 250.000 €",
        description: "Precio máximo anunciado.", weight: 1, required: true,
      }],
    })));
    renderDossier(listing({ evaluation }));

    const coverage = screen.getByRole("button", { name: "1 criterios resueltos de 3" });
    expect(recipes).not.toHaveBeenCalled();
    fireEvent.click(coverage);

    const evaluationTab = screen.getByRole("tab", { name: /^Evaluación/u });
    expect(evaluationTab).toHaveAttribute("aria-selected", "true");
    expect(evaluationTab).toHaveFocus();
    const panel = screen.getByRole("tabpanel", { name: /^Evaluación/u });
    expect(within(panel).getByText("100 / 100")).toBeInTheDocument();
    expect(within(panel).getByText("1 criterios resueltos de 3")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Por verificar 2" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "Criterios cumplidos 1" })).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: /Criterios incumplidos/u })).not.toBeInTheDocument();
    expect(within(panel).getByText(/Ese score no mide certeza/u)).toBeInTheDocument();
    expect(await within(panel).findByText("Presupuesto hasta 400.000 €")).toBeInTheDocument();
    expect(within(panel).queryByText("Presupuesto hasta 250.000 €")).not.toBeInTheDocument();
    expect(within(panel).getByText("sea-view")).toBeInTheDocument();
  });

  it("preserves fractional areas and zero rooms when displaying the supplied measurements", () => {
    renderDossier(listing({ surfaceM2: 85.5, landSurfaceM2: 363.75, rooms: 0 }));

    expect(screen.getByText(/^85,5\s*m²$/u)).toBeInTheDocument();
    expect(screen.getByText(/^363,75\s*m²$/u)).toBeInTheDocument();
    const rooms = screen.getByText("Ambientes").parentElement!;
    expect(within(rooms).getByRole("definition")).toHaveTextContent(/^0$/u);
  });

  it("supports roving tab focus and URL state, loads history only when selected, and closes on Escape", async () => {
    const archive = vi.spyOn(denicheurApi, "listSourceRecords").mockResolvedValue({ items: [] });
    const { onClose } = renderDossier(listing());
    const dossier = screen.getByRole("complementary", { name: "Ficha de propiedad" });
    const overview = screen.getByRole("tab", { name: "Resumen" });
    const evaluation = screen.getByRole("tab", { name: "Evaluación" });
    const history = screen.getByRole("tab", { name: "Historial" });

    expect(dossier).toHaveFocus();
    expect(archive).not.toHaveBeenCalled();
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(evaluation).toHaveFocus();
    expect(evaluation).toHaveAttribute("aria-selected", "true");
    expect(overview).toHaveAttribute("tabindex", "-1");
    expect(new URLSearchParams(window.location.search).get("ptab")).toBe("evaluation");
    expect(archive).not.toHaveBeenCalled();

    fireEvent.keyDown(evaluation, { key: "End" });
    expect(history).toHaveFocus();
    expect(history).toHaveAttribute("aria-selected", "true");
    expect(new URLSearchParams(window.location.search).get("ptab")).toBe("history");
    await waitFor(() => expect(archive).toHaveBeenCalledOnce());
    expect(archive).toHaveBeenCalledWith("leboncoin", "123", undefined, expect.any(AbortSignal));

    fireEvent.keyDown(history, { key: "ArrowLeft" });
    expect(evaluation).toHaveFocus();
    fireEvent.keyDown(evaluation, { key: "Home" });
    expect(overview).toHaveFocus();
    expect(overview).toHaveAttribute("aria-selected", "true");
    expect(new URLSearchParams(window.location.search).get("ptab")).toBe("overview");
    expect(new URLSearchParams(window.location.search).get("pq")).toBe("port");
    expect(new URLSearchParams(window.location.search).get("pid")).toBe("leboncoin:123");

    fireEvent.keyDown(overview, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderDossier(property: PropertyListing) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const onClose = vi.fn();
  render(<QueryClientProvider client={client}><AppIntlProvider>
    <PropertyDossier listing={property} loading={false} error={false} onRetry={vi.fn()} onClose={onClose}
      detailRef={createRef<HTMLElement>()} expanded={false} onToggleExpanded={vi.fn()} />
  </AppIntlProvider></QueryClientProvider>);
  return { onClose };
}

function listing(overrides: Partial<PropertyListing> = {}): PropertyListing {
  return {
    source: "leboncoin", externalId: "123", key: "leboncoin:123",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123", title: "Maison du port", location: "Trégunc",
    priceEuros: 325_000, imageUrls: [], features: [], runs: [], evaluations: [], ...overrides,
  };
}
