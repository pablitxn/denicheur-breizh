import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIntlProvider } from "../../intl/IntlContext";
import { BuilderView } from "./BuilderView";
import { recipeDraftStorageKey } from "./builderModel";

const timestamp = "2026-07-19T10:00:00.000Z";
const recipeV1 = recipe("family", 1, "Maison famille v1", false);
const recipeV2 = recipe("family", 2, "Maison famille", true);
const budget = recipe("budget", 1, "Budget", false);
const plan = {
  id: "primary-home",
  version: 1,
  name: "Résidence principale",
  operator: "all",
  recipes: [{ recipeId: "family", recipeVersion: 1 }],
  combinerVersion: "tri-state-v1",
  isDefault: true,
  createdAt: timestamp,
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("BuilderView", () => {
  it("keeps published recipes read only and publishes edits only as a new recoverable version", async () => {
    const fetcher = builderFetch();
    vi.stubGlobal("fetch", fetcher);
    renderBuilder();

    await screen.findByRole("heading", { name: "Maison famille" });
    expect(screen.getByText("Publiée · lecture seule")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Nom" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Créer une version" }));
    const name = screen.getByRole("textbox", { name: "Nom" });
    fireEvent.change(name, { target: { value: "Maison famille Bretagne" } });

    const stored = window.localStorage.getItem(recipeDraftStorageKey);
    expect(stored).toContain("family:2");
    expect(stored).toContain("Maison famille Bretagne");

    fireEvent.click(screen.getByRole("button", { name: "Publier la version" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/v1/recipes/family",
      expect.objectContaining({ method: "PUT" }),
    ));
    await waitFor(() => expect(window.localStorage.getItem(recipeDraftStorageKey)).toBeNull());
  });

  it("pins exact recipe versions in plan drafts and warns when a newer family version exists", async () => {
    vi.stubGlobal("fetch", builderFetch());
    renderBuilder("/?btab=plans");

    await screen.findByRole("heading", { name: "Résidence principale" });
    expect(screen.getByText("v2 disponible")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Crear versión" }));

    const firstRecipe = screen.getByRole("combobox", { name: "Receta en la posición 1" });
    expect(firstRecipe).toHaveValue("family:1");
    fireEvent.click(screen.getByRole("button", { name: "Añadir receta" }));
    expect(screen.getAllByRole("combobox", { name: /Receta en la posición/u })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Subir receta" })[1]).toBeEnabled();
  });

  it("keeps criterion fields focused while editing their identifier", async () => {
    vi.stubGlobal("fetch", builderFetch());
    renderBuilder();
    await screen.findByRole("heading", { name: "Maison famille" });
    fireEvent.click(screen.getByRole("button", { name: "Créer une version" }));
    const identifier = screen.getByRole("textbox", { name: "Identifiant" });
    identifier.focus();

    for (const value of ["garden-", "garden-m", "garden-ma", "garden-main"]) {
      fireEvent.change(identifier, { target: { value } });
      expect(screen.getByRole("textbox", { name: "Identifiant" })).toBe(identifier);
      expect(identifier).toHaveFocus();
      expect(identifier).toHaveValue(value);
    }
    expect(window.localStorage.getItem(recipeDraftStorageKey)).toContain("garden-main");
  });

  it("keeps surviving criterion editors intact after deleting and adding criteria", async () => {
    vi.stubGlobal("fetch", builderFetch());
    renderBuilder();
    await screen.findByRole("heading", { name: "Maison famille" });
    fireEvent.click(screen.getByRole("button", { name: "Créer une version" }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un critère" }));
    const survivor = screen.getAllByRole("textbox", { name: "Identifiant" })[1]!;
    fireEvent.change(survivor, { target: { value: "near-coast" } });

    fireEvent.click(screen.getByRole("button", { name: "Supprimer le critère Jardin" }));
    expect(screen.getByRole("textbox", { name: "Identifiant" })).toBe(survivor);
    expect(survivor).toHaveValue("near-coast");

    fireEvent.click(screen.getByRole("button", { name: "Ajouter un critère" }));
    expect(screen.getAllByRole("textbox", { name: "Identifiant" })[0]).toBe(survivor);
    expect(screen.getAllByRole("textbox", { name: "Identifiant" })).toHaveLength(2);
  });
});

function renderBuilder(href = "/") {
  window.localStorage.setItem("denicheur:locale", "fr");
  if (href.includes("btab=plans")) window.localStorage.setItem("denicheur:locale", "es");
  window.history.replaceState({}, "", href);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AppIntlProvider><BuilderView /></AppIntlProvider></QueryClientProvider>);
}

function builderFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/recipes") && (!init?.method || init.method === "GET")) {
      return json({ items: [recipeV2, recipeV1, budget] });
    }
    if (url.endsWith("/v1/evaluation-plans") && (!init?.method || init.method === "GET")) {
      return json({ items: [plan] });
    }
    if (url.endsWith("/v1/evaluation-plans/default")) {
      return json({
        ...plan,
        recipes: plan.recipes.map((reference) => ({ ...reference, recipe: recipeV1 })),
      });
    }
    if (url.endsWith("/v1/recipes/family") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ ...recipeV2, version: 3, name: body.name, active: false }, 201);
    }
    return json({ error: { message: "Not found" } }, 404);
  });
}

function recipe(id: string, version: number, name: string, active: boolean) {
  return {
    id,
    version,
    name,
    threshold: 70,
    criteria: [{ id: "garden", name: "Jardin", description: "Présence explicite", weight: 2, required: true, evidenceRequired: true }],
    active,
    createdAt: timestamp,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
