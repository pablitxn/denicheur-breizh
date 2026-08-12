import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../components/Shell";
import { PropertiesView } from "../features/properties/PropertiesView";
import { AppIntlProvider, getInitialLocale, localeStorageKey } from "./IntlContext";

function renderIntlWorkspace() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <AppIntlProvider>
        <Shell>
          <PropertiesView />
        </Shell>
      </AppIntlProvider>
    </QueryClientProvider>,
  );
}

function installLocalStorage(initialLocale?: string, key = localeStorageKey) {
  const store = new Map<string, string>();
  if (initialLocale) store.set(key, initialLocale);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
  return store;
}

function installApiFixture() {
  const timestamp = "2026-07-18T10:00:00.000Z";
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/health/details")) {
      return new Response(JSON.stringify({
        status: "ok",
        service: "denicheur-api",
        database: { status: "ok" },
        media: { status: "ok", pending: 0, processing: 0, ready: 0, failed: 0 },
        openAiConfigured: true,
      }), { status: 200 });
    }
    if (url.includes("/v1/listings?")) {
      return new Response(JSON.stringify({
        items: [{
          source: "leboncoin",
          externalId: "listing-1",
          id: "leboncoin:listing-1",
          url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
          title: "Maison collectée",
          status: "detailed",
          scrapedAt: timestamp,
          lastRunId: "run-1",
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          updatedAt: timestamp,
        }],
        nextCursor: null,
        total: 1,
      }), { status: 200 });
    }
    if (url.includes("/v1/listings/leboncoin/listing-1")) {
      return new Response(JSON.stringify({
        source: "leboncoin",
        externalId: "listing-1",
        id: "leboncoin:listing-1",
        url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
        title: "Maison collectée",
        status: "detailed",
        scrapedAt: timestamp,
        lastRunId: "run-1",
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        updatedAt: timestamp,
        runs: [],
        evaluations: [],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intl UI", () => {
  it("uses the browser language when no preference has been stored", () => {
    installLocalStorage();
    const originalLanguages = Object.getOwnPropertyDescriptor(window.navigator, "languages");
    Object.defineProperty(window.navigator, "languages", {
      configurable: true,
      value: ["en-US", "fr-FR"],
    });

    expect(getInitialLocale()).toBe("en");

    if (originalLanguages) {
      Object.defineProperty(window.navigator, "languages", originalLanguages);
    } else {
      Reflect.deleteProperty(window.navigator, "languages");
    }
  });

  it("switches the workspace shell, domain copy and metadata across French, Spanish and English", async () => {
    installApiFixture();
    const store = installLocalStorage("fr", "denicheur.locale");
    document.head.innerHTML = '<meta name="description" content="">';
    renderIntlWorkspace();

    expect(await screen.findByRole("navigation", { name: "Vue principale" })).toHaveTextContent("Carte");
    expect((await screen.findAllByText("Maison collectée")).length).toBeGreaterThan(0);
    expect(await screen.findByText("API connectée")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Ouvrir l’annonce source/u })).toHaveAttribute(
      "href",
      "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
    );
    expect((await screen.findAllByText("Non disponible")).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe("fr-FR");
    expect(document.title).toBe("dénicheur·breizh — Décision immobilière en Bretagne");
    expect(document.body).toHaveTextContent("dénicheur·breizh");
    expect(store.get(localeStorageKey)).toBe("fr");
    expect(store.has("denicheur.locale")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Espagnol" }));

    expect(await screen.findByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Mapa");
    expect((await screen.findAllByText("Maison collectée")).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Propiedades");
    expect(document.documentElement.lang).toBe("es-ES");
    expect(document.title).toBe("dénicheur·breizh — Decisión inmobiliaria en Bretaña");

    fireEvent.click(screen.getByRole("button", { name: "Inglés" }));

    expect(await screen.findByRole("navigation", { name: "Primary view" })).toHaveTextContent("Map");
    expect((await screen.findAllByText("Maison collectée")).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Primary view" })).toHaveTextContent("Properties");
    expect(document.documentElement.lang).toBe("en-GB");
    expect(document.title).toBe("dénicheur·breizh — Property decisions in Brittany");
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      expect.stringContaining("property decision workspace"),
    );
  });

  it("follows locale changes from another tab", async () => {
    installApiFixture();
    installLocalStorage("fr");
    renderIntlWorkspace();
    await screen.findByRole("navigation", { name: "Vue principale" });

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: localeStorageKey, newValue: "en" }));
    });

    expect(await screen.findByRole("navigation", { name: "Primary view" })).toHaveTextContent("Map");
    expect(document.documentElement.lang).toBe("en-GB");
  });
});
