import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppIntlProvider } from "../../intl/IntlContext";
import { ScoringsView } from "./ScoringsView";

const now = "2026-07-19T10:00:00.000Z";
const recipe = {
  id: "family",
  version: 1,
  name: "Maison famille",
  threshold: 70,
  criteria: [{ id: "garden", name: "Jardin", description: "Présence explicite", weight: 2, required: true, evidenceRequired: true }],
  active: false,
  createdAt: now,
};
const plan = {
  id: "primary-home",
  version: 1,
  name: "Résidence principale",
  operator: "all",
  recipes: [{ recipeId: "family", recipeVersion: 1 }],
  combinerVersion: "tri-state-v1",
  isDefault: true,
  createdAt: now,
};
const oldExecution = execution("execution-old", "completed", {
  total: 1,
  processed: 1,
  relevant: 1,
  notRelevant: 0,
  review: 0,
  failed: 0,
});
const newExecution = execution("execution-new", "queued");

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("ScoringsView", () => {
  it("keeps a newly started execution selected while the executions list is still stale", async () => {
    const fetcher = scoringFetch();
    vi.stubGlobal("fetch", fetcher);
    renderScorings();

    const start = await screen.findByRole("button", { name: "Lancer l’évaluation" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("seid")).toBe("execution-new"));
    expect(fetcher.mock.calls.some(([input, init]) =>
      String(input).endsWith("/v1/runs/run-1/evaluation-executions") && init?.method === "POST")).toBe(true);
    expect(fetcher.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-1/listings"))).toBe(false);
    expect(await screen.findByText("execution-new")).toBeInTheDocument();
  });

  it("disables launch when the run summary reports no detailed listings", async () => {
    vi.stubGlobal("fetch", scoringFetch({ detailedListingCount: 0 }));
    renderScorings();

    const start = await screen.findByRole("button", { name: "Lancer l’évaluation" });

    await waitFor(() => expect(start).toBeDisabled());
    expect(await screen.findByText("Ce run terminé ne contient aucun snapshot détaillé à évaluer.")).toBeInTheDocument();
  });

  it("renders aggregate provenance with namespaced recipe criteria and evaluator version", async () => {
    vi.stubGlobal("fetch", scoringFetch());
    renderScorings();

    expect(await screen.findByText("family@v1/garden")).toBeInTheDocument();
    expect(screen.getByText("gpt-test · evaluator-v1")).toBeInTheDocument();
    expect(screen.getByText("Le jardin est mentionné.")).toBeInTheDocument();
    expect(screen.getByText("Résultat agrégé pertinent.")).toBeInTheDocument();
  });

  it("offers retry for unavailable run details without claiming the run is empty", async () => {
    const fetcher = scoringFetch();
    let unavailable = true;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      unavailable && String(input).endsWith("/v1/runs/run-1")
        ? Promise.resolve(json({ error: { message: "Temporarily unavailable" } }, 503))
        : fetcher(input, init)));
    renderScorings();

    const retry = await screen.findByRole("button", { name: "Réessayer" });
    expect(screen.queryByText("Ce run terminé ne contient aucun snapshot détaillé à évaluer.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lancer l’évaluation" })).toBeDisabled();
    unavailable = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "Lancer l’évaluation" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Réessayer" })).not.toBeInTheDocument();
  });

  it("loads history beyond the first hundred entries without changing the current selection", async () => {
    vi.stubGlobal("fetch", historyFetch());
    renderScorings();
    expect(await screen.findByText("Runs chargés : 100 sur 101")).toBeInTheDocument();
    expect(screen.getByText("Exécutions chargées : 100 sur 101")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Charger des runs plus anciens" }));
    expect(await screen.findByRole("option", { name: /run-older/u })).toBeInTheDocument();
    expect(screen.getByText("Runs chargés : 101 sur 101")).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("srun")).toBe("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Charger des exécutions plus anciennes" }));
    expect(await screen.findByText("Exécutions chargées : 101 sur 101")).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("seid")).toBe("execution-old");

    fireEvent.click(screen.getByRole("button", { name: /2024/u }));
    expect(await screen.findByText("execution-older")).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get("seid")).toBe("execution-older");
    expect(screen.getByRole("button", { name: "Actualiser les exécutions" })).toBeEnabled();
  });

  it("retains loaded history and result details after a page failure, then refreshes and retries", async () => {
    let unavailable = true;
    vi.stubGlobal("fetch", historyFetch(() => unavailable));
    renderScorings();
    await screen.findByText("Runs chargés : 100 sur 101");
    await screen.findByText("Résultat agrégé pertinent.");
    fireEvent.click(screen.getByRole("button", { name: "Charger des runs plus anciens" }));

    expect(await screen.findByText(/Impossible de charger l’historique/u)).toBeInTheDocument();
    expect(screen.getByText("Runs chargés : 100 sur 101")).toBeInTheDocument();
    expect(screen.getByText("Résultat agrégé pertinent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Charger des runs plus anciens" })).toBeDisabled();
    unavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Actualiser les runs" }));
    await waitFor(() => expect(screen.queryByText(/Impossible de charger l’historique/u)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Charger des runs plus anciens" }));
    expect(await screen.findByText("Runs chargés : 101 sur 101")).toBeInTheDocument();
  });

  it("preserves direct links to a run and execution outside the first history page", async () => {
    vi.stubGlobal("fetch", historyFetch());
    renderScorings("/?view=scorings&srun=run-older&seid=execution-older");
    await screen.findByText("Résultat agrégé pertinent.");
    expect(screen.getByRole("combobox", { name: "Run terminé" })).toHaveValue("run-older");
    expect(new URL(window.location.href).searchParams.get("srun")).toBe("run-older");
    expect(new URL(window.location.href).searchParams.get("seid")).toBe("execution-older");
    expect(screen.getByRole("button", { name: "Lancer l’évaluation" })).toBeEnabled();
  });

  it("preserves the requested result while its execution results are still loading", async () => {
    const fetcher = scoringFetch();
    let finishResults: (() => void) | undefined;
    const resultsReady = new Promise<void>((resolve) => { finishResults = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/evaluation-executions/execution-old/results")) {
        await resultsReady;
        const payload = executionResults("execution-old");
        return json({ ...payload, items: [...payload.items, { ...payload.items[0], listingId: "leboncoin:requested" }] });
      }
      return fetcher(input, init);
    }));
    renderScorings("/?view=scorings&seid=execution-old&sid=leboncoin%3Arequested");
    await waitFor(() => expect(screen.getAllByText("Chargement des résultats de l’exécution…").length).toBeGreaterThan(0));
    expect(new URL(window.location.href).searchParams.get("sid")).toBe("leboncoin:requested");
    await act(async () => { finishResults!(); });
    expect(await screen.findByRole("heading", { name: "leboncoin:requested" })).toBeInTheDocument();
  });
});

function historyFetch(unavailableNextRun = () => false) {
  const fallback = scoringFetch();
  const olderExecution = { ...oldExecution, id: "execution-older", createdAt: "2024-01-01T12:00:00.000Z" };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/runs") {
      if (url.searchParams.has("cursor")) return unavailableNextRun()
        ? json({ error: { message: "Temporary history failure" } }, 503)
        : json({ items: [{ ...runRecord(), id: "run-older" }], nextCursor: null, total: 101 });
      return json({ items: Array.from({ length: 100 }, (_, index) => ({ ...runRecord(), id: `run-${index + 1}` })), nextCursor: "runs-next", total: 101 });
    }
    if (url.pathname === "/v1/evaluation-executions") {
      if (url.searchParams.has("cursor")) return json({ items: [olderExecution], nextCursor: null, total: 101 });
      return json({ items: [oldExecution, ...Array.from({ length: 99 }, (_, index) => ({ ...oldExecution, id: `execution-${index + 1}` }))], nextCursor: "executions-next", total: 101 });
    }
    if (url.pathname === "/v1/runs/run-older") return json({ ...runRecord(), id: "run-older", listingCount: 1, detailedListingCount: 1 });
    if (url.pathname === "/v1/evaluation-executions/execution-older") return json(olderExecution);
    if (url.pathname === "/v1/evaluation-executions/execution-older/results") return json(executionResults("execution-older"));
    return fallback(input, init);
  });
}

function renderScorings(href = "/?view=scorings") {
  window.localStorage.setItem("denicheur:locale", "fr");
  window.history.replaceState({}, "", href);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AppIntlProvider><ScoringsView /></AppIntlProvider></QueryClientProvider>);
}

function scoringFetch({ detailedListingCount = 1 }: { detailedListingCount?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/evaluation-plans")) return json({ items: [plan] });
    if (url.endsWith("/v1/evaluation-plans/default")) {
      return json({ ...plan, recipes: [{ ...plan.recipes[0], recipe }] });
    }
    if (url.endsWith("/v1/recipes")) return json({ items: [recipe] });
    if (url.includes("/v1/runs?")) return json({ items: [runRecord()], nextCursor: null, total: 1 });
    if (url.endsWith("/v1/runs/run-1")) {
      return json({ ...runRecord(), listingCount: 1, detailedListingCount });
    }
    if (url.includes("/v1/listings/map?")) return json({ items: [listing()], nextCursor: null, total: 1 });
    if (url.includes("/v1/evaluation-executions?") && (!init?.method || init.method === "GET")) {
      return json({ items: [oldExecution], nextCursor: null, total: 1 });
    }
    if (url.endsWith("/v1/evaluation-executions/execution-old")) return json(oldExecution);
    if (url.endsWith("/v1/evaluation-executions/execution-old/results")) return json(executionResults("execution-old"));
    if (url.endsWith("/v1/runs/run-1/evaluation-executions") && init?.method === "POST") return json(newExecution, 202);
    if (url.endsWith("/v1/evaluation-executions/execution-new")) return json(newExecution);
    if (url.endsWith("/v1/evaluation-executions/execution-new/results")) return json({ executionId: "execution-new", items: [] });
    return json({ error: { message: `Unhandled ${url}` } }, 404);
  });
}

function runRecord() {
  return {
    id: "run-1",
    source: "leboncoin",
    status: "completed",
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
  };
}

function listing() {
  return {
    source: "leboncoin",
    externalId: "123456",
    id: "leboncoin:123456",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/123456",
    title: "Maison du port",
    status: "detailed",
    scrapedAt: now,
    lastRunId: "run-1",
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
  };
}

function execution(id: string, status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled", counters = {
  total: 1,
  processed: 0,
  relevant: 0,
  notRelevant: 0,
  review: 0,
  failed: 0,
}) {
  return {
    id,
    runId: "run-1",
    planId: "primary-home",
    planVersion: 1,
    locale: "fr",
    status,
    listingIds: ["leboncoin:123456"],
    force: false,
    createdAt: now,
    ...(status === "completed" ? { startedAt: now, completedAt: now } : {}),
    counters,
    budget: {
      limit: { providerCalls: 10, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: 1_000_000 },
      estimate: { providerCalls: 1, inputTokens: 2_000, outputTokens: 1_000, costMicroUsd: 10_000 },
      consumed: { providerCalls: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    },
  };
}

function executionResults(executionId: string) {
  return {
    executionId,
    items: [{
      executionId,
      listingId: "leboncoin:123456",
      planId: "primary-home",
      planVersion: 1,
      decision: "relevant",
      score: 88,
      summary: "Résultat agrégé pertinent.",
      evaluatedAt: now,
      steps: [{
        recipeId: "family",
        recipeVersion: 1,
        status: "succeeded",
        evaluator: { provider: "openai", model: "gpt-test", version: "evaluator-v1" },
        evaluation: {
          listingId: "leboncoin:123456",
          decision: "relevant",
          score: 88,
          summary: "La maison correspond à la recette.",
          criteria: [{ criterionId: "garden", verdict: "pass", reason: "Jardin confirmé.", evidence: ["Le jardin est mentionné."] }],
          missingData: [],
          evaluatedAt: now,
        },
      }],
    }],
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
