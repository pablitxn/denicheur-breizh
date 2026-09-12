import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureObservation, CaptureRun, LabMetadata } from "@denicheur-breizh/collector-contracts";
import { RepairPanel } from "./RepairPanel";
import type { RepairPlan } from "./api";
import { DetailStatus, FieldStateList } from "./fields";
import { initialDraft } from "./draft";
import { usePreferences } from "./preferences";

const parent: CaptureRun = { id: "parent", request: { ...initialDraft, provider: "firecrawl", name: "Original search" }, status: "partial", strategy: "firecrawl-agent-expanded-v3", model: "test", coverage: "incomplete", discovered: 3, captured: 1, failed: 2, pending: 0, pagesVisited: 1, observedEnd: true, duplicates: 0, warnings: [], cost: 3, costUnknown: false, unit: "credits", createdAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-12T12:01:00.000Z" };
const url = (id: number) => `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`;
const unresolved = { status: "unresolved" as const, reason: "Provider did not recover this field.", evidence: [] };
const plan: RepairPlan = { runId: parent.id, provider: "firecrawl", strategy: "firecrawl-gallery-walk-v7", eligible: true, total: 2, requiresCapture: 2, items: [
  { listingId: "leboncoin:1", url: url(1), title: "House one", fields: ["description", "imageUrls"], locallyResolved: ["description"], fieldStates: { description: unresolved, imageUrls: unresolved } },
  { listingId: "leboncoin:2", url: url(2), title: "House two", fields: ["rooms"], locallyResolved: [], fieldStates: { rooms: unresolved } },
] };
const metadata: LabMetadata = { live: false, sources: [], providers: [{ id: "firecrawl", label: "Firecrawl", configured: true, model: "test", strategy: plan.strategy }], budgets: [{ provider: "firecrawl", configured: true, unit: "credits", limit: 5000, remaining: 4000, spent: 1000, reserved: 0, unknownCalls: 0, balance: null, checkedAt: null, expiresAt: null, note: "" }] };
function mount(onCreated = vi.fn(), run = parent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><RepairPanel run={run} onCreated={onCreated} /></QueryClientProvider>), onCreated };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fetchPlan(meta = metadata, available = plan, post?: () => Response) {
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? post?.() ?? response({ ...parent, id: "child" }) : response(String(path).endsWith("/meta") ? meta : available));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
beforeEach(() => { sessionStorage.clear(); usePreferences.setState({ locale: "en", theme: "system" }); });

describe("targeted repair", () => {
  it("repairs only selected gaps and reuses the billable request after an uncertain response and reload", async () => {
    let attempts = 0;
    const fetcher = fetchPlan(metadata, plan, () => ++attempts === 1 ? response({ error: { code: "uncertain", message: "Response lost" } }, 503) : response({ ...parent, id: "child" }));
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    const all = await screen.findByRole("checkbox", { name: "Select all listings to repair" });
    expect(all).toBeChecked();
    expect(screen.getByText("Capture strategy: Gallery walkthrough (v7)")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /House one/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /House two/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /House two/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Fields to repair" })).getByRole("checkbox", { name: "Description" }));
    const start = screen.getByRole("button", { name: "Create repair capture" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost");
    expect(first.onCreated).not.toHaveBeenCalled();
    first.unmount();
    const second = mount();
    fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    await screen.findByRole("checkbox", { name: /House one/ });
    expect(screen.getByRole("checkbox", { name: /House two/ })).not.toBeChecked();
    expect(within(screen.getByRole("group", { name: "Fields to repair" })).getByRole("checkbox", { name: "Description" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create repair capture" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create repair capture" }));
    await waitFor(() => expect(second.onCreated).toHaveBeenCalledWith("child"));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0][0]).toBe("/api/v1/runs/parent/repair");
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ listingIds: ["leboncoin:1"], fields: ["imageUrls"] });
    expect(posts[0][1]!.headers).toEqual(posts[1][1]!.headers);
    expect((posts[0][1]!.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("allows evidence-only repair without credits while blocking any selected paid gap", async () => {
    fetchPlan({ ...metadata, providers: metadata.providers.map(item => ({ ...item, configured: false })), budgets: metadata.budgets.map(item => ({ ...item, remaining: 0, unknownCalls: 1 })) });
    mount(); fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    await screen.findByRole("checkbox", { name: /House two/ });
    expect(screen.getByRole("button", { name: "Create repair capture" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /House two/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Fields to repair" })).getByRole("checkbox", { name: "Images" }));
    expect(screen.getByText("This selection resolves from saved evidence, with no paid calls.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create repair capture" })).toBeEnabled();
    fireEvent.click(within(screen.getByRole("group", { name: "Fields to repair" })).getByRole("checkbox", { name: "Description" }));
    expect(screen.getByRole("button", { name: "Create repair capture" })).toBeDisabled();
  });

  it("keeps a conflicting saved intent explicit without generating a replacement request key", async () => {
    const fetcher = fetchPlan(metadata, plan, () => response({ error: { code: "idempotency_conflict", message: "Saved strategy differs from this request." } }, 409));
    const { onCreated } = mount(); fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    const start = await screen.findByRole("button", { name: "Create repair capture" });
    await waitFor(() => expect(start).toBeEnabled()); fireEvent.click(start);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved strategy differs");
    expect(screen.getByText(/Check capture history and the original repair before starting a new attempt/)).toBeVisible();
    fireEvent.click(start);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts[0][1]!.headers).toEqual(posts[1][1]!.headers);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("does not offer completed listings or create work when the plan has no gaps", async () => {
    const fetcher = fetchPlan(metadata, { ...plan, eligible: false, items: [], total: 0, requiresCapture: 0 });
    mount(); fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    expect(await screen.findByText("This capture has no unresolved detail fields.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create repair capture" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("repairs an already populated but contradicted field locally even when the original capture finished with no empty fields", async () => {
    const conflictReason = "Saved DPE A contradicts the native page, which explicitly shows DPE C.";
    const conflictPlan: RepairPlan = { ...plan, total: 1, requiresCapture: 0, items: [{ listingId: "leboncoin:1", url: url(1), title: "House with conflicting DPE", fields: ["energyClass"], locallyResolved: ["energyClass"], fieldStates: { energyClass: { status: "unresolved", reason: conflictReason, evidence: [{ url: url(1), text: "DPE C", kind: "page" }] } } }] };
    const fetcher = fetchPlan({ ...metadata, providers: metadata.providers.map(item => ({ ...item, configured: false })), budgets: metadata.budgets.map(item => ({ ...item, remaining: 0 })) }, conflictPlan);
    const { onCreated } = mount(vi.fn(), { ...parent, status: "completed", captured: 3, failed: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Review fields to repair" }));
    expect(await screen.findByRole("checkbox", { name: "DPE" })).toBeChecked();
    expect(screen.getByText("This selection resolves from saved evidence, with no paid calls.")).toBeVisible();
    fireEvent.click(screen.getByText("Field states", { selector: "summary" }));
    expect(screen.getByText(conflictReason)).toBeVisible();
    const start = screen.getByRole("button", { name: "Create repair capture" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("child"));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/api/v1/runs/parent/repair");
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ listingIds: ["leboncoin:1"], fields: ["energyClass"] });
  });

  it("distinguishes unresolved, absent and not applicable fields without presenting processed details as complete", () => {
    const evidence = [{ url: url(1), text: "No energy rating displayed for this land plot.", kind: "page" as const }];
    const fieldStates: CaptureObservation["fieldStates"] = { description: unresolved, energyClass: { status: "not_applicable", reason: "Land plot has no dwelling.", evidence }, sellerName: { status: "absent", reason: "Source does not show a seller name.", evidence }, location: { status: "observed", reason: "Location is visible on the detail page.", evidence } };
    render(<><DetailStatus observation={{ ...plan.items[0], id: "leboncoin:1", runId: parent.id, externalId: "1", source: "leboncoin", provider: "firecrawl", observedAt: parent.updatedAt, data: {}, detailStatus: "captured", missingFields: [], absentFields: ["sellerName"], evidence, fieldStates }} /><FieldStateList states={fieldStates} /></>);
    expect(screen.getByText("Incomplete capture")).toBeVisible();
    expect(screen.queryByText("Processing finished")).not.toBeInTheDocument();
    expect(screen.getByText("Not applicable")).toBeVisible();
    expect(screen.getByText("Absent from source")).toBeVisible();
    expect(screen.getByText("Land plot has no dwelling.")).toBeVisible();
    expect(screen.getByText("Observed with evidence")).toBeVisible();
  });

  it("keeps the inherited price timestamp while showing the repaired GES time without synthesizing legacy field states", () => {
    const originalAt = "2026-09-11T10:00:00.000Z";
    const repairedAt = "2026-09-12T16:00:00.000Z";
    const states = Object.freeze({
      gesClass: { status: "observed" as const, reason: "GES B is visible in the new page.", evidence: [], observedAt: originalAt },
      location: { status: "observed" as const, reason: "Location retained from its field evidence.", evidence: [], observedAt: originalAt },
      rooms: unresolved,
    });
    render(<FieldStateList states={states} fieldObservedAt={{ priceEuros: originalAt, gesClass: repairedAt }} observedAt={repairedAt} />);
    const fieldTime = (label: string) => screen.getByText(label, { selector: "strong" }).closest("div")!.querySelector("time");
    expect(fieldTime("Price")).toHaveAttribute("datetime", originalAt);
    expect(fieldTime("GES")).toHaveAttribute("datetime", repairedAt);
    expect(fieldTime("Location")).toHaveAttribute("datetime", originalAt);
    expect(fieldTime("Rooms")).toHaveAttribute("datetime", repairedAt);
    const price = screen.getByText("Price", { selector: "strong" }).closest("div")!;
    expect(within(price).getByText("No individual assessment recorded for this field.")).toBeVisible();
    expect(within(price).queryByText("Observed with evidence")).not.toBeInTheDocument();
    expect(Object.keys(states)).toEqual(["gesClass", "location", "rooms"]);
  });
});
