import type { SourceRecord, SourceRecordsPage } from "@denicheur-breizh/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denicheurApi } from "../../api/denicheurApi";
import { AppIntlProvider, localeStorageKey } from "../../intl/IntlContext";
import { PropertyHistory } from "./PropertyHistory";

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("PropertyHistory", () => {
  it("loads only metadata until a capture is opened and preserves the safely rendered original JSON", async () => {
    const payloadJson = ' \n{"title":"  Maison du port  ","priceEuros":325000,"location":"Trégunc","description":"<img src=x onerror=alert(1)>","unknown":null}\n ';
    const capture = record("one", { payloadJson });
    const list = vi.spyOn(denicheurApi, "listSourceRecords").mockResolvedValue(page(capture));
    const detail = vi.spyOn(denicheurApi, "getSourceRecord").mockResolvedValue(capture);
    const { container } = renderHistory();

    const open = await screen.findByRole("button", { name: /^Ver captura del/u });
    expect(list).toHaveBeenCalledWith("leboncoin", "123", undefined, expect.any(AbortSignal));
    expect(detail).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(await screen.findByText("Maison du port")).toBeInTheDocument();
    expect(screen.getByText("Precio anunciado en esta captura")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector(`time[datetime="${capture.observedAt}"]`)).toBeInTheDocument();
    expect(container.querySelector(`time[datetime="${capture.receivedAt}"]`)).toBeNull();

    fireEvent.click(screen.getByText("Datos de origen"));
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toBe(payloadJson));
    expect(screen.getByText("Guardada en la plataforma")).toBeInTheDocument();
    expect(container.querySelector(`time[datetime="${capture.receivedAt}"]`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Ocultar captura del/u }));
    fireEvent.click(screen.getByRole("button", { name: /^Ver captura del/u }));
    expect(await screen.findByText("Maison du port")).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(1);
  });

  it("does not invent previews from wrong field types and explains the limits of legacy records", async () => {
    const capture = record("legacy", {
      kind: "legacy-run-snapshot",
      payloadJson: '{"title":null,"priceEuros":"300000","location":{"city":"Trégunc"},"description":["text"]}',
    });
    vi.spyOn(denicheurApi, "listSourceRecords").mockResolvedValue(page(capture));
    vi.spyOn(denicheurApi, "getSourceRecord").mockResolvedValue(capture);
    renderHistory();
    expect(await screen.findByText("Registro anterior")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Ver captura del/u }));
    expect(await screen.findByText(/No hay campos para mostrar en la vista previa/u)).toBeInTheDocument();
    expect(screen.getByText(/puede reunir varias observaciones/u)).toBeInTheDocument();
    expect(screen.queryByText("Precio anunciado en esta captura")).not.toBeInTheDocument();
    expect(screen.queryByText("Ubicación")).not.toBeInTheDocument();
  });

  it("retries initial and next-page errors while keeping already loaded captures available", async () => {
    const first = record("first", { sequence: 10 });
    const second = record("second", { sequence: 9, kind: "extension-search-result", observedAt: "2026-09-11T08:00:00.000Z" });
    const list = vi.spyOn(denicheurApi, "listSourceRecords")
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValueOnce({ ...page(first), nextBeforeSequence: 10 })
      .mockRejectedValueOnce(new Error("Next page unavailable"))
      .mockResolvedValueOnce(page(second));
    renderHistory();
    const initialError = await screen.findByRole("alert");
    expect(initialError).toHaveTextContent("No se pudo cargar el historial.");
    fireEvent.click(within(initialError).getByRole("button", { name: "Reintentar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cargar más" }));
    const pageError = await screen.findByRole("alert");
    expect(pageError).toHaveTextContent("No se pudieron cargar las siguientes capturas.");
    expect(screen.getByText("Página del anuncio")).toBeInTheDocument();
    fireEvent.click(within(pageError).getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Resultado de búsqueda")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Ver captura del/u })).toHaveLength(2);
    expect(list).toHaveBeenLastCalledWith("leboncoin", "123", 10, expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
  });

  it("clears expanded capture content and pagination when switching to another property", async () => {
    const first = record("first", { payloadJson: '{"title":"First property"}' });
    const second = record("second", { externalId: "456", kind: "extension-search-result", payloadJson: '{"title":"Second property"}' });
    const list = vi.spyOn(denicheurApi, "listSourceRecords")
      .mockResolvedValueOnce({ ...page(first), nextBeforeSequence: 10 })
      .mockResolvedValueOnce(page(second));
    const detail = vi.spyOn(denicheurApi, "getSourceRecord").mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const { switchProperty } = renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /^Ver captura del/u }));
    expect(await screen.findByText("First property")).toBeInTheDocument();
    switchProperty("456");
    expect(screen.queryByText("First property")).not.toBeInTheDocument();
    expect(await screen.findByText("Resultado de búsqueda")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith("leboncoin", "456", undefined, expect.any(AbortSignal));
    expect(detail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^Ver captura del/u }));
    expect(await screen.findByText("Second property")).toBeInTheDocument();
    expect(screen.queryByText("First property")).not.toBeInTheDocument();
  });

  it("retries an individual capture without refetching the history list", async () => {
    const capture = record("retry", { payloadJson: '{"title":"Recovered capture"}' });
    const list = vi.spyOn(denicheurApi, "listSourceRecords").mockResolvedValue(page(capture));
    const detail = vi.spyOn(denicheurApi, "getSourceRecord")
      .mockRejectedValueOnce(new Error("Capture unavailable")).mockResolvedValueOnce(capture);
    renderHistory();
    fireEvent.click(await screen.findByRole("button", { name: /^Ver captura del/u }));
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("No se pudo cargar esta captura.");
    fireEvent.click(within(error).getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Recovered capture")).toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

function record(id: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id, source: "leboncoin", externalId: "123", runId: "run", sequence: 10,
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123", kind: "extension-detail",
    observedAt: "2026-09-12T08:00:00.000Z", receivedAt: "2026-09-12T09:00:00.000Z",
    payloadSha256: "a".repeat(64), payloadJson: "{}", ...overrides,
  };
}

function page(capture: SourceRecord): SourceRecordsPage {
  const { payloadJson: _payloadJson, ...metadata } = capture;
  return { items: [metadata] };
}

function renderHistory() {
  window.localStorage.setItem(localeStorageKey, "es");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const tree = (externalId: string) => <QueryClientProvider client={client}>
    <AppIntlProvider><PropertyHistory source="leboncoin" externalId={externalId} /></AppIntlProvider>
  </QueryClientProvider>;
  const result = render(tree("123"));
  return { ...result, switchProperty: (externalId: string) => result.rerender(tree(externalId)) };
}
