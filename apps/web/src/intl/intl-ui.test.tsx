import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Shell } from "../components/Shell";
import { PropertiesView } from "../features/properties/PropertiesView";
import { AppIntlProvider } from "./IntlContext";

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

function installLocalStorage(initialLocale: string) {
  const store = new Map<string, string>([["denicheur.locale", initialLocale]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
}

describe("intl UI", () => {
  it("switches the workspace shell and property copy between French and Spanish", async () => {
    installLocalStorage("fr");
    renderIntlWorkspace();

    expect(await screen.findByRole("navigation", { name: "Vue principale" })).toHaveTextContent("Carte");
    expect((await screen.findAllByText("Maison en pierre")).length).toBeGreaterThan(0);
    expect(document.documentElement.lang).toBe("fr");

    fireEvent.click(screen.getByRole("button", { name: "Espagnol" }));

    expect(await screen.findByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Mapa");
    expect((await screen.findAllByText("Casa de piedra")).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Vista principal" })).toHaveTextContent("Propiedades");
    expect(document.documentElement.lang).toBe("es");
  });
});
