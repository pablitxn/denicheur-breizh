import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIntlProvider } from "../../intl/IntlContext";
import { BuilderView } from "./BuilderView";

const timestamp = "2026-07-18T10:00:00.000Z";
const recipe = {
  id: "family",
  version: 1,
  name: "Maison famille",
  threshold: 70,
  criteria: [{ id: "garden", name: "Jardin", description: "Le jardin est explicite.", weight: 2, required: true, evidenceRequired: true }],
  active: true,
  createdAt: timestamp,
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("BuilderView", () => {
  it("saves a new recipe version through the API without changing the active version implicitly", async () => {
    window.localStorage.setItem("denicheur:locale", "fr");
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/recipes") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ items: [recipe] }), { status: 200 });
      }
      if (url.endsWith("/v1/recipes/active")) return new Response(JSON.stringify(recipe), { status: 200 });
      if (url.endsWith("/v1/recipes/family") && init?.method === "PUT") {
        return new Response(JSON.stringify({ ...recipe, version: 2, name: "Maison famille Bretagne", active: false }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    render(<QueryClientProvider client={client}><AppIntlProvider><BuilderView /></AppIntlProvider></QueryClientProvider>);

    const name = await screen.findByRole("textbox", { name: "Nom" });
    fireEvent.change(name, { target: { value: "Maison famille Bretagne" } });
    fireEvent.click(screen.getByRole("button", { name: /Enregistrer une version/u }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:4310/v1/recipes/family",
      expect.objectContaining({ method: "PUT" }),
    ));
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/activate") && init?.method === "POST")).toBe(false);
  });
});
