import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    const store = installLocalStorage("fr", "denicheur.locale");
    document.head.innerHTML = '<meta name="description" content="">';
    renderIntlWorkspace();

    expect(await screen.findByRole("navigation", { name: "Vue principale" })).toHaveTextContent("Carte");
    expect((await screen.findAllByText("Maison en pierre")).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe("fr-FR");
    expect(document.title).toContain("Décision immobilière");
    expect(store.get(localeStorageKey)).toBe("fr");
    expect(store.has("denicheur.locale")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Espagnol" }));

    expect(await screen.findByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Mapa");
    expect((await screen.findAllByText("Casa de piedra")).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Propiedades");
    expect(document.documentElement.lang).toBe("es-ES");
    expect(document.title).toContain("Decisión inmobiliaria");

    fireEvent.click(screen.getByRole("button", { name: "Inglés" }));

    expect(await screen.findByRole("navigation", { name: "Primary view" })).toHaveTextContent("Map");
    expect((await screen.findAllByText("Stone house")).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Primary view" })).toHaveTextContent("Properties");
    expect(document.documentElement.lang).toBe("en-GB");
    expect(document.title).toContain("Property decisions");
    expect(document.querySelector('meta[name="description"]')).toHaveAttribute(
      "content",
      expect.stringContaining("property decision workspace"),
    );
  });

  it("follows locale changes from another tab", async () => {
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
