import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureRun, EvaluationReport, LabMetadata } from "@denicheur-breizh/collector-contracts";
import { App } from "./App";
import { usePreferences, saveTheme } from "./preferences";
import { initialDraft, useDraft } from "./draft";
import { referenceRecords } from "./Evaluation";

const metadata: LabMetadata = {
  live: false, sources: [{ id: "leboncoin", label: "Leboncoin", domains: ["leboncoin.fr"], fields: [] }],
  providers: ["xai", "firecrawl"].map((id) => ({ id: id as "xai" | "firecrawl", label: id, model: "test", strategy: id === "xai" ? "xai-web-search-v1" : "firecrawl-agent-scrape-v1", strategies: id === "firecrawl" ? [{ id: "firecrawl-agent-scrape-v1", label: "Agent + scrape" }, { id: "firecrawl-agent-native-v2", label: "Native navigation" }] : undefined, configured: true })),
  budgets: ["xai", "firecrawl"].map((provider) => ({ provider: provider as "xai" | "firecrawl", unit: provider === "xai" ? "usd" : "credits", limit: provider === "xai" ? 25 : 5000, spent: 0, reserved: 0, remaining: provider === "xai" ? 25 : 5000, unknownCalls: 0, configured: true, balance: null, expiresAt: null, checkedAt: null, note: "" })),
};
const run: CaptureRun = {
  id: "test-run", request: { ...initialDraft, name: "Quimper", filters: { ...initialDraft.filters, location: "Quimper" } }, status: "completed", createdAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-12T12:01:00.000Z", strategy: "test", model: "test", coverage: "unknown", discovered: 101, captured: 100, failed: 1, duplicates: 0, pagesVisited: 4, pending: 1, observedEnd: false, warnings: [], cost: 0.01, costUnknown: false, unit: "usd",
};
const page = (items: unknown[]) => ({ items, offset: 0, limit: 25, total: items.length });
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(<QueryClientProvider client={client}><App /></QueryClientProvider>); }
function setupFetch(overrides?: (path: string, init?: RequestInit) => Response | undefined) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const overridden = overrides?.(path, init); if (overridden) return overridden;
    const data = path.endsWith("/meta") ? metadata : path.endsWith("/observations?offset=0&limit=24") ? page([]) : path.endsWith("/events") ? { items: [] } : path.endsWith(`/runs/${run.id}`) ? run : path.includes("/evaluations?") ? page([]) : path.endsWith("/usage/unknown") ? { items: [] } : path.endsWith("/references") ? { items: [] } : path.includes("/runs?") ? page([run]) : run;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  }); vi.stubGlobal("fetch", fetcher); return fetcher;
}
beforeEach(() => { window.history.replaceState(null, "", "/"); localStorage.clear(); usePreferences.setState({ locale: "en", theme: "system" }); useDraft.setState({ draft: { ...initialDraft, filters: { ...initialDraft.filters } } }); });

describe("collector user flow", () => {
  it("dispatches only the chosen provider and preserves the idempotency key after an uncertain network failure", async () => {
    let attempts = 0;
    const fetcher = setupFetch((path, init) => {
      if (path.endsWith("/runs") && init?.method === "POST") {
        attempts += 1;
        return attempts === 1 ? new Response(JSON.stringify({ error: { code: "uncertain", message: "Response lost" } }), { status: 503 }) : new Response(JSON.stringify(run));
      }
      return undefined;
    });
    mount();
    fireEvent.click(screen.getByRole("radio", { name: /Firecrawl Agent/ }));
    fireEvent.change(screen.getByLabelText("Capture name"), { target: { value: "Quimper" } });
    fireEvent.change(screen.getByLabelText("Location", { exact: true }), { target: { value: "Quimper" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Start capture" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await screen.findByText("Capture history");
    const calls = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(calls).toHaveLength(2);
    const first = calls[0][1]!; const second = calls[1][1]!;
    expect(JSON.parse(first.body as string).provider).toBe("firecrawl");
    expect(first.headers).toEqual(second.headers);
    expect((first.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(screen.getByText("Simulated data · no live results")).toBeVisible();
  });

  it("dispatches the explicitly selected native Agent strategy without falling back to page jobs", async () => {
    const fetcher = setupFetch(); mount();
    fireEvent.click(screen.getByRole("radio", { name: /Firecrawl Agent/ }));
    const strategy = await screen.findByRole("combobox", { name: "Capture strategy" });
    fireEvent.change(strategy, { target: { value: "firecrawl-agent-native-v2" } });
    fireEvent.change(screen.getByLabelText("Capture name"), { target: { value: "Native Quimper" } });
    fireEvent.change(screen.getByLabelText("Location", { exact: true }), { target: { value: "Quimper" } });
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ provider: "firecrawl", strategy: "firecrawl-agent-native-v2" });
  });

  it("does not call a finished execution complete coverage and keeps all 101 results visible in counts", async () => {
    setupFetch(); mount(); fireEvent.click(screen.getByRole("button", { name: "Captures" }));
    expect(await screen.findByText("Unverified")).toBeVisible();
    expect(screen.queryByText("Complete coverage verified")).not.toBeInTheDocument();
    expect(screen.getByText("101", { selector: ".stat strong" })).toBeVisible();
    expect(screen.getAllByText("Execution finished").length).toBeGreaterThan(0);
  });

  it("keeps appearance and language in the shared Settings modal, with technical details in Development", async () => {
    setupFetch(); mount();
    expect(screen.queryByRole("combobox", { name: "Appearance" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog");
    const language = within(dialog).getByRole("combobox", { name: "Language" });
    fireEvent.change(language, { target: { value: "es" } });
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    expect(localStorage.getItem("denicheur:locale")).toBe("es");
    expect(screen.getByText("Explorar. Capturar. Verificar.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Desarrollo" }));
    expect(within(dialog).getByText("collector-api · /api/v1")).toBeVisible();
    expect(within(dialog).queryByRole("textbox", { name: /key/i })).not.toBeInTheDocument();
  });

  it("reopens a persisted report after reload without evaluating again or dispatching providers", async () => {
    const metric = { numerator: 1, denominator: 1, ratio: 1 };
    const report: EvaluationReport = { id: "saved-report", referenceId: "independent-reference", createdAt: "2026-09-12T14:00:00.000Z", referenceComplete: true, results: [{ runId: run.id, provider: "xai", verdict: "verified_complete", reasons: [], recall: metric, detailCoverage: metric, fieldCompleteness: metric, fieldAccuracy: metric, imageCoverage: metric, discrepancies: [], cost: 0.2, unit: "usd", costPerUsefulListing: 0.2, durationMs: 2000 }] };
    const fetcher = setupFetch((path) => {
      if (path.includes("/evaluations?")) return new Response(JSON.stringify(page([{ id: report.id, referenceId: report.referenceId, referenceName: "Independent Quimper reference", createdAt: report.createdAt, results: report.results.map(({ runId, provider, verdict }) => ({ runId, provider, verdict })) }])));
      if (path.endsWith("/evaluations/saved-report")) return new Response(JSON.stringify(report));
      return undefined;
    });
    const firstMount = mount();
    fireEvent.click(screen.getByRole("button", { name: "Evaluation" }));
    const history = await screen.findByRole("region", { name: "Saved reports" });
    fireEvent.click(await within(history).findByRole("button", { name: /Independent Quimper reference/ }));
    expect(await screen.findByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/v1/evaluations/saved-report/export?format=json");
    expect(new URLSearchParams(window.location.search).get("report")).toBe("saved-report");
    firstMount.unmount();
    mount();
    expect(await screen.findByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/v1/evaluations/saved-report/export?format=json");
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/evaluations/saved-report"))).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("blocks capture when a provider has unresolved billable calls", async () => {
    setupFetch((path) => path.endsWith("/meta") ? new Response(JSON.stringify({ ...metadata, budgets: metadata.budgets.map((budget) => budget.provider === "xai" ? { ...budget, unknownCalls: 1 } : budget) })) : undefined);
    mount();
    expect((await screen.findAllByText("Unknown usage: reconciliation is required.")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start capture" })).toBeDisabled();
  });
});

describe("host preference and reference compatibility", () => {
  it("updates the existing theme envelope without erasing unrelated host preferences", () => {
    localStorage.setItem("denicheur:workspace", JSON.stringify({ version: 2, state: { theme: "dark", accent: "sea", density: "compact" } }));
    saveTheme("light");
    expect(JSON.parse(localStorage.getItem("denicheur:workspace")!)).toEqual({ version: 2, state: { theme: "light", accent: "sea", density: "compact" } });
  });
  it("accepts reference records without silently truncating large extension exports", () => {
    const records = Array.from({ length: 503 }, (_, id) => ({ id }));
    expect(referenceRecords({ records })).toHaveLength(503);
    expect(referenceRecords({ observations: records })).toBe(records);
    expect(() => referenceRecords({ ignored: records })).toThrow();
  });
});
