import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denicheurApi } from "../api/denicheurApi";
import { queryKeys } from "../api/queryKeys";
import { AppIntlProvider, localeStorageKey } from "../intl/IntlContext";
import { Shell } from "./Shell";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Shell API status", () => {
  it("reports a failed health refresh even with cached healthy data and recovers on success", async () => {
    const health = vi.spyOn(denicheurApi, "health").mockResolvedValue({
      status: "ok",
      database: "ok",
      media: { status: "ok", pending: 0, processing: 0, ready: 0, failed: 0 },
      openAiConfigured: true,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    window.localStorage.setItem(localeStorageKey, "fr");
    const view = render(<QueryClientProvider client={client}><AppIntlProvider><Shell><p>Workspace</p></Shell></AppIntlProvider></QueryClientProvider>);

    expect(screen.queryByText("API connectée")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Paramètres" }));
    fireEvent.click(screen.getByRole("button", { name: "Développement" }));
    expect(await screen.findByText("API connectée")).toBeInTheDocument();
    health.mockRejectedValueOnce(new Error("Connection lost"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.health.all });
    });

    expect(await screen.findByText("API indisponible")).toBeInTheDocument();
    expect(screen.queryByText("API connectée")).not.toBeInTheDocument();
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.health.all });
    });

    expect(await screen.findByText("API connectée")).toBeInTheDocument();
    view.unmount();
    client.clear();
  });
});
