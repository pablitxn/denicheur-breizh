import { captureRequestSchema, dataFields } from "@denicheur-breizh/collector-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderStepContext } from "../adapter.js";
import { createFirecrawlProvider } from "./firecrawl.js";
import { detailGaps } from "../capture-quality.js";
import { redactProviderValue } from "./http.js";
import { CAPTURE_POLICY_VERSION, captureOutputJsonSchema, captureRepairOutputJsonSchema, parseCaptureOutput } from "./output.js";
import { createXaiProvider } from "./xai.js";
import { leboncoinSource } from "../sources.js";

const listingUrl = "https://www.leboncoin.fr/ad/ventes_immobilieres/123";
const searchUrl = "https://www.leboncoin.fr/recherche?category=9&locations=Rennes";
function output() {
  return { observations: [{ url: listingUrl, data: { title: "Maison", features: null, imageUrls: null }, detailStatus: "captured", missingFields: [], absentFields: [],
    evidence: [{ url: listingUrl, text: "Maison", kind: "page" }], error: null }], nextPages: [], exhausted: true, warnings: [], incomplete: false };
}
function context(provider: "xai" | "firecrawl", kind: "details" | "discover" = "details"): ProviderStepContext {
  return {
    request: captureRequestSchema.parse({ provider, name: "Fixture", mode: kind === "details" ? "urls" : "search", urls: [listingUrl], searchUrl }),
    source: { id: "leboncoin", label: "Leboncoin", domains: ["leboncoin.fr"], fields: dataFields },
    work: { id: "work-1", kind, urls: [kind === "details" ? listingUrl : searchUrl] },
    instructions: "Use the requested native URL.", remainingBudget: provider === "xai" ? 25 : 5000,
    signal: new AbortController().signal,
    onRemoteJob: vi.fn().mockResolvedValue(undefined), onEvidence: vi.fn().mockResolvedValue(undefined),
    onProgress: vi.fn().mockResolvedValue(undefined), onUsage: vi.fn().mockResolvedValue(undefined),
  };
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function fetchQueue(...responses: Response[]) {
  const fetcher = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
}
function xaiResponse(payload: unknown, extra: Record<string, unknown> = {}) {
  return { id: "response-1", status: "completed", usage: { cost_in_usd_ticks: "123000000" },
    output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }], ...extra };
}

describe("xAI adapter", () => {
  it("refuses to dispatch when effective request evidence cannot be saved", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const ctx = context("xai");
    vi.mocked(ctx.onEvidence).mockRejectedValue(new Error("storage unavailable"));
    await expect(createXaiProvider({ apiKey: "test-secret", fetcher }).step(ctx)).rejects.toMatchObject({ code: "evidence_unavailable", billingUnknown: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(ctx.onUsage).not.toHaveBeenCalled();
  });
  it("uses an independent hosted-search request and records billed ticks before normalizing extraction", async () => {
    const fetcher = fetchQueue(json(xaiResponse(output())));
    const ctx = context("xai");
    const result = await createXaiProvider({ apiKey: "test-secret", fetcher }).step(ctx);
    expect(result.usage.amount).toBe(0.0123);
    expect(result.observations[0]?.data.title).toBe("Maison");
    expect(result.observations[0]?.data.imageUrls).toBeUndefined();
    expect(result.observations[0]?.error).toBeUndefined();
    expect(result.exhausted).toBe(false);
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: 0.0123, detail: expect.objectContaining({ costInUsdTicks: "123000000" }) }));
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/responses");
    const request = JSON.parse(String(init?.body));
    expect(request.tools).toEqual([{ type: "web_search", filters: { allowed_domains: ["leboncoin.fr"] } }]);
    expect(request.text.format.strict).toBe(true);
    expect(request).not.toHaveProperty("background");
    expect(request).not.toHaveProperty("max_tool_calls");
    expect(request).not.toHaveProperty("max_cost");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps charged usage and raw output when truncation prevents JSON parsing", async () => {
    const raw = xaiResponse(output(), { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: '{"observations":[' }] }] });
    const ctx = context("xai");
    await expect(createXaiProvider({ apiKey: "test-secret", fetcher: fetchQueue(json(raw)) }).step(ctx)).rejects.toMatchObject({ code: "provider_output_truncated", billingUnknown: false });
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: 0.0123 }));
    expect(ctx.onEvidence).toHaveBeenCalledWith("xai_response", raw);
  });

  it("does not turn missing billing into free usage or lack of a search trace into complete coverage", async () => {
    const raw = xaiResponse(output(), { usage: {}, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output()) }] }] });
    const result = await createXaiProvider({ apiKey: "test-secret", fetcher: fetchQueue(json(raw)) }).step(context("xai", "discover"));
    expect(result.usage.amount).toBeNull();
    expect(result.exhausted).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it("records unknown spend without retrying an interrupted paid request", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("connection reset"));
    const ctx = context("xai");
    await expect(createXaiProvider({ apiKey: "test-secret", fetcher }).step(ctx)).rejects.toMatchObject({ code: "provider_unavailable", billingUnknown: true, retryable: false });
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: null, unit: "usd" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Firecrawl adapter", () => {
  it("recovers the selected native GES despite empty model field-state reasons and exposes the disagreement", async () => {
    const payload = output();
    const observation = { ...payload.observations[0]!, data: { ...payload.observations[0]!.data, gesClass: "G" },
      fieldStates: Object.fromEntries(dataFields.map(field => [field, { status: "observed", reason: "", evidence: [{ url: listingUrl, kind: "page", text: "GES: G" }] }])),
    };
    const raw = { success: true, creditsUsed: 5, data: { json: { ...payload, observations: [observation] }, metadata: { sourceURL: listingUrl }, actions: { javascriptReturns: [{ value: {
      preparation: "leboncoin-detail-repair-v4", phase: "observe", url: listingUrl, blocked: false,
      fields: { gesClass: { value: "C", selected: true, evidence: "GES: C; selected native grade", selector: '[data-qa-id="criteria_item_ges"]' } },
    } }] } } };
    const fetcher = fetchQueue(json({ data: { remainingCredits: 100 } }), json(raw), json({ data: { remainingCredits: 95 } }));
    const ctx = { ...context("firecrawl"), source: leboncoinSource };
    const result = await createFirecrawlProvider({ apiKey: "test-secret", strategy: "firecrawl-detail-repair-v4", fetcher }).step(ctx);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.data.gesClass).toBe("C");
    expect(result.observations[0]?.fieldStates?.gesClass?.status).toBe("observed");
    expect(result.observations[0]?.fieldStates?.title).toMatchObject({ status: "unresolved", reason: expect.stringContaining("quarantined"), evidence: [] });
    expect(detailGaps(result.observations[0]!)).toContain("title");
    expect(detailGaps(result.observations[0]!)).not.toContain("gesClass");
    expect(result.warnings).toContain(`Native source evidence corrected gesClass from model value G to C for ${listingUrl}.`);
    expect(result.warnings.join(" ")).toContain("Quarantined invalid fieldStates");
    expect(result.incomplete).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(ctx.onEvidence).toHaveBeenCalledWith("firecrawl_scrape", raw);
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: 5 }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each([
    ["malformed JSON", '{"observations":'],
    ["omitted listing", { observations: [], nextPages: [], exhausted: true }],
    ["rejected listing", { observations: [{ url: listingUrl, data: { priceEuros: "wrong type" } }], nextPages: [] }],
    ["foreign listing", { observations: [{ ...output().observations[0], url: "https://www.leboncoin.fr/ad/ventes_immobilieres/999" }], nextPages: [] }],
  ])("recovers only same-URL raw facts from %s without another paid request", async (_label, payload) => {
    const raw = { success: true, creditsUsed: 5, data: { json: payload, metadata: { sourceURL: listingUrl }, actions: { javascriptReturns: [{ value: {
      preparation: "leboncoin-detail-repair-v4", phase: "observe", url: listingUrl, blocked: false,
      fields: { gesClass: { value: "C", selected: true, evidence: "GES: C; selected native grade", selector: '[data-qa-id="criteria_item_ges"]' } },
    } }] } } };
    const fetcher = fetchQueue(json({ data: { remainingCredits: 100 } }), json(raw), json({ data: { remainingCredits: 95 } }));
    const ctx = { ...context("firecrawl"), source: leboncoinSource };
    const result = await createFirecrawlProvider({ apiKey: "test-secret", strategy: "firecrawl-detail-repair-v4", fetcher }).step(ctx);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ url: listingUrl, data: { gesClass: "C" }, detailStatus: "failed", error: expect.stringContaining("No valid model observation") });
    expect(result.observations[0]?.data.title).toBeUndefined();
    expect(result.observations[0]?.missingFields).toEqual(dataFields.filter(field => field !== "gesClass"));
    expect(result.incomplete).toBe(true);
    expect(result.warnings.join(" ")).toContain("No valid model observation");
    expect(ctx.onEvidence).toHaveBeenCalledWith("firecrawl_scrape", raw);
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: 5 }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("leaves a v4 fallback unresolved when its saved raw evidence belongs to another listing", async () => {
    const foreign = "https://www.leboncoin.fr/ad/ventes_immobilieres/999";
    const raw = { success: true, creditsUsed: 5, data: { json: null, metadata: { sourceURL: foreign }, actions: { javascriptReturns: [{ value: {
      preparation: "leboncoin-detail-repair-v4", phase: "observe", url: foreign,
      fields: { gesClass: { value: "C", selected: true, evidence: "GES: C", selector: '[data-qa-id="criteria_item_ges"]' } },
    } }] } } };
    const fetcher = fetchQueue(json({ data: { remainingCredits: 100 } }), json(raw), json({ data: { remainingCredits: 95 } }));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", strategy: "firecrawl-detail-repair-v4", fetcher }).step({ ...context("firecrawl"), source: leboncoinSource });
    expect(result.observations[0]?.data).toEqual({});
    expect(result.observations[0]?.missingFields).toEqual(dataFields);
    expect(result.observations[0]?.fieldStates?.gesClass?.status).toBe("unresolved");
  });
  it("uses v4 targeted scripts and field-state schema while reconciling the same single scrape charge", async () => {
    const payload=output();
    const observation={...payload.observations[0]!,data:{...payload.observations[0]!.data,gesClass:null,landSurfaceM2:null},missingFields:["gesClass","landSurfaceM2"]};
    const raw={success:true,creditsUsed:5,data:{json:{...payload,observations:[observation]},html:'<main>Native source evidence</main>',metadata:{sourceURL:listingUrl},actions:{javascriptReturns:[{type:"object",value:{preparation:"leboncoin-detail-repair-v4",phase:"observe",url:listingUrl,criteria:[{label:"Surface totale du terrain",value:"581 m²"}],fields:{gesClass:{value:"B",selected:true,evidence:"GES: B; selected native grade",selector:'[data-qa-id="criteria_item_ges"]'}}}}]}}};
    const fetcher=fetchQueue(json({data:{remainingCredits:100}}),json(raw),json({data:{remainingCredits:95}}));
    const ctx={...context("firecrawl"),source:leboncoinSource,work:{...context("firecrawl").work,repairFields:["gesClass","landSurfaceM2"] as const}};
    const result=await createFirecrawlProvider({apiKey:"test-secret",strategy:"firecrawl-detail-repair-v4",fetcher}).step({...ctx,work:{...ctx.work,repairFields:[...ctx.work.repairFields]}});
    const body=JSON.parse(String(fetcher.mock.calls.find(([,init])=>init?.method==="POST")?.[1]?.body));
    expect(body.formats).toContain("html");
    expect(body.formats.at(-1).schema).toEqual(captureRepairOutputJsonSchema);
    expect(body.formats.at(-1).prompt).toContain("requested fields: gesClass, landSurfaceM2");
    expect(body.actions).toEqual([{type:"executeJavascript",script:leboncoinSource.detailRepairScript},{type:"wait",milliseconds:750},{type:"executeJavascript",script:leboncoinSource.detailRepairEvidenceScript}]);
    expect(result.observations[0]!.data).toMatchObject({gesClass:"B",landSurfaceM2:581});
    expect(result.observations[0]!.fieldStates?.gesClass?.status).toBe("observed");
    expect(result.usage.amount).toBe(5);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
    expect(captureOutputJsonSchema.properties.observations.items.properties).not.toHaveProperty("fieldStates");
  });
  it("supports all-field v4 URL capture and keeps v4 discovery focused on identities/cards", async()=>{
    const details=fetchQueue(json({data:{remainingCredits:100}}),json({success:true,creditsUsed:5,data:{json:output(),metadata:{sourceURL:listingUrl}}}),json({data:{remainingCredits:95}}));
    await createFirecrawlProvider({apiKey:"test-secret",strategy:"firecrawl-detail-repair-v4",fetcher:details}).step({...context("firecrawl"),source:leboncoinSource});
    const detailBody=JSON.parse(String(details.mock.calls[1]?.[1]?.body));
    expect(detailBody.formats.at(-1).prompt).toContain(`requested fields: ${dataFields.join(", ")}`);
    const discovery=fetchQueue(json({id:"v4-discovery"}),json({status:"completed",creditsUsed:8,data:output()}),json({events:[]}));
    await createFirecrawlProvider({apiKey:"test-secret",strategy:"firecrawl-detail-repair-v4",fetcher:discovery}).step(context("firecrawl","discover"));
    const discoveryBody=JSON.parse(String(discovery.mock.calls[0]?.[1]?.body));
    expect(discoveryBody.prompt).toContain("Every observation must remain pending");
    expect(discoveryBody.prompt).toContain("Do not open listing details");
    expect(discoveryBody.schema).toEqual(captureOutputJsonSchema);
    expect(discoveryBody.urls).toEqual([searchUrl]);
  });
  it.each(["firecrawl-agent-scrape-v1", "firecrawl-agent-expanded-v3"] as const)("only expands source detail controls when %s explicitly enables it", async strategy => {
    const fetcher = fetchQueue(json({ data: { remainingCredits: 100 } }), json({ success: true, data: { json: output(), metadata: { creditsUsed: 5, scrapeId: "detail-1" } } }), json({ data: { remainingCredits: 95 } }));
    const ctx = { ...context("firecrawl"), source: leboncoinSource };
    await createFirecrawlProvider({ apiKey: "test-secret", strategy, fetcher }).step(ctx);
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(post?.[1]?.body));
    if (strategy === "firecrawl-agent-expanded-v3") expect(body.actions).toEqual([{ type: "executeJavascript", script: leboncoinSource.detailPreparationScript }, { type: "wait", milliseconds: 750 }]);
    else expect(body).not.toHaveProperty("actions");
    expect(ctx.onEvidence).toHaveBeenCalledWith("provider_request", expect.objectContaining({ strategy, body: expect.objectContaining({ maxAge: 0 }) }));
  });
  it.each(["firecrawl-agent-scrape-v1", "firecrawl-agent-native-v2"] as const)("keeps %s request behavior explicit without switching API products", async strategy => {
    const fetcher = fetchQueue(json({ success: true, id: "strategy-job" }), json({ status: "completed", creditsUsed: 8, data: output() }), json({ events: [] }));
    const provider = createFirecrawlProvider({ apiKey: "test-secret", fetcher, strategy });
    await provider.step(context("firecrawl", "discover"));
    expect(provider.strategy).toBe(strategy);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/agent");
    expect(body.urls).toEqual(strategy === "firecrawl-agent-native-v2" ? ["https://www.leboncoin.fr/"] : [searchUrl]);
    expect(body).toMatchObject({ maxCredits: 5000, model: "spark-2", strictConstrainToURLs: false });
    expect(body).not.toHaveProperty("profile");
    expect(body).not.toHaveProperty("ttl");
    expect(body.prompt).toContain("Never create, submit, fund or request bounties");
    expect(body.prompt).toContain("Do not solve CAPTCHAs");
    if(strategy === "firecrawl-agent-native-v2") {
      expect(body.prompt).toContain("NATIVE HOME STRATEGY v2");
      expect(body.prompt).toContain("Continue pagination inside THIS job");
      expect(body.prompt).not.toContain("Do not traverse nextPages within this operation");
    } else expect(body.prompt).toContain("Do not traverse nextPages within this operation");
  });

  it("returns explicit unvisited page continuations from native v2 without claiming browser continuity across jobs", async () => {
    const payload = { ...output(), exhausted: false, incomplete: true, nextPages: [`${searchUrl}&page=2`] };
    const fetcher = fetchQueue(json({ success: true, id: "native-job" }), json({ status: "completed", creditsUsed: 8, data: payload }), json({ events: [] }));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher, strategy: "firecrawl-agent-native-v2" }).step(context("firecrawl", "discover"));
    expect(result).toMatchObject({ exhausted: false, incomplete: true, nextPages: [`${searchUrl}&page=2`] });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.prompt).toContain("A future continuation is a new Agent job");
  });

  it("persists its Agent ID before polling, reconciles cumulative usage and tolerates unavailable traces", async () => {
    const fetcher = fetchQueue(
      json({ success: true, id: "agent-1" }),
      json({ status: "processing", creditsUsed: 2 }), json({ creditsUsed: 3, events: [] }),
      json({ status: "completed", creditsUsed: 8, data: output() }), json({ error: "trace unavailable" }, 503),
    );
    const ctx = context("firecrawl", "discover");
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher, pollIntervalMs: 0 }).step(ctx);
    expect(ctx.onRemoteJob).toHaveBeenCalledWith("agent-1");
    expect(vi.mocked(ctx.onRemoteJob).mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[1]!);
    expect(vi.mocked(ctx.onUsage).mock.calls.map(([usage]) => usage.amount)).toEqual([2, 3, 8]);
    expect(vi.mocked(ctx.onUsage).mock.calls.map(([usage]) => usage.final)).toEqual([false, false, true]);
    expect(result.usage.amount).toBe(8);
    expect(result.observations).toHaveLength(1);
    expect(result.warnings).toContain("Firecrawl execution trace was unavailable.");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.maxCredits).toBe(5000);
    expect(body.model).toBe("spark-2");
    expect(body.urls).toEqual([searchUrl]);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://api.firecrawl.dev/v2/"))).toBe(true);
  });

  it("resumes a persisted Agent without creating a second charged job, even after budget exhaustion", async () => {
    const fetcher = fetchQueue(json({ status: "completed", creditsUsed: 5, data: output() }), json({ events: [] }));
    const ctx = { ...context("firecrawl", "discover"), remoteJobId: "saved-agent", remainingBudget: 0 };
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step(ctx);
    expect(result.usage.amount).toBe(5);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/agent/saved-agent");
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(ctx.onRemoteJob).not.toHaveBeenCalled();
    expect(ctx.onEvidence).not.toHaveBeenCalledWith("provider_request", expect.anything());
  });

  it("keeps the final reported charge even when completed Agent output is malformed", async () => {
    const ctx = { ...context("firecrawl", "discover"), remoteJobId: "saved-agent" };
    const fetcher = fetchQueue(json({ status: "completed", creditsUsed: 13, data: { unexpected: true } }), json({ events: [] }));
    await expect(createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step(ctx)).rejects.toMatchObject({ code: "provider_output_invalid" });
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({ amount: 13 }));
  });

  it("marks missing final Agent usage unknown rather than using an earlier partial charge", async () => {
    const ctx = { ...context("firecrawl", "discover"), remoteJobId: "saved-agent" };
    const fetcher = fetchQueue(json({ status: "processing", creditsUsed: 2 }), json({ creditsUsed: 3 }), json({ status: "completed", data: output() }), json({ creditsUsed: 3 }));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher, pollIntervalMs: 0 }).step(ctx);
    expect(result.usage.amount).toBeNull();
    expect(vi.mocked(ctx.onUsage).mock.calls.at(-1)?.[0].amount).toBeNull();
  });

  it("treats a polling outage as unresolved remote billing, retaining the previously reported amount only as a lower bound", async () => {
    const ctx = { ...context("firecrawl", "discover"), remoteJobId: "saved-agent" };
    const fetcher = fetchQueue(json({ status: "processing", creditsUsed: 2 }), json({ creditsUsed: 3 }), json({ error: "unavailable" }, 503));
    await expect(createFirecrawlProvider({ apiKey: "test-secret", fetcher, pollIntervalMs: 0 }).step(ctx)).rejects.toMatchObject({ code: "provider_job_interrupted", billingUnknown: true });
    expect(vi.mocked(ctx.onUsage).mock.calls.at(-1)?.[0]).toMatchObject({ amount: null, detail: { jobId: "saved-agent", lastReportedAmount: 3 } });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("scrapes fresh JSON and labels account-balance usage as estimated", async () => {
    const fetcher = fetchQueue(json({ data: { remainingCredits: 200 } }), json({ success: true, data: { json: output(), markdown: "Maison", metadata: { scrapeId: "scrape-1" } } }), json({ data: { remainingCredits: 195 } }));
    const ctx = context("firecrawl");
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step(ctx);
    const request = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(request.maxAge).toBe(0);
    expect(request.storeInCache).toBe(false);
    expect(request.formats).toEqual(["markdown", "links", expect.objectContaining({ type: "json", schema: expect.any(Object) })]);
    expect(ctx.onRemoteJob).toHaveBeenCalledWith("scrape:scrape-1");
    expect(result.usage).toMatchObject({ amount: 5, unit: "credits", detail: { basis: "account_balance_delta", estimated: true } });
    expect(result.nextPages).toEqual([]);
    expect(result.exhausted).toBe(false);
  });

  it("prefers attributed scrape credits to unrelated account spending", async () => {
    const fetcher = fetchQueue(json({ data: { remainingCredits: 200 } }), json({ success: true, creditsUsed: 5, data: { json: output() } }), json({ data: { remainingCredits: 170 } }));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step(context("firecrawl"));
    expect(result.usage).toMatchObject({ amount: 5, detail: { basis: "reported" } });
  });
  it("keeps charged JSON but flags a collapsed raw description even when the model removed its ellipsis", async () => {
    const payload=output();
    const observation={...payload.observations[0]!,data:{...payload.observations[0]!.data,description:"A model summary that looks complete."}};
    const fetcher=fetchQueue(json({data:{remainingCredits:200}}),json({success:true,creditsUsed:5,data:{json:{...payload,observations:[observation]},markdown:"## Description\n\nText cut by the source UI…\n\nVoir plus\n\n## Diagnostics"}}),json({data:{remainingCredits:195}}));
    const ctx=context("firecrawl");
    const result=await createFirecrawlProvider({apiKey:"test-secret",fetcher}).step(ctx);
    expect(result.observations[0]!.data.description).toBe(observation.data.description);
    expect(detailGaps(result.observations[0]!,["description"],result.warnings)).toEqual(["description"]);
    expect(result.usage.amount).toBe(5);
    expect(ctx.onUsage).toHaveBeenCalledWith(expect.objectContaining({amount:5}));
  });
  it("replaces an expanded Scrape model summary with the entire same-response source block without changing billing", async () => {
    const payload=output();
    const description="Apartment description.\n\nA complete additional paragraph omitted from structured extraction.\n\nSurface: 71 m². Annual energy spending: 990–1390 €.";
    const observation={...payload.observations[0]!,data:{...payload.observations[0]!.data,description:"Apartment summary."},missingFields:["description","landSurfaceM2"]};
    const raw={success:true,creditsUsed:5,data:{json:{...payload,observations:[observation]},markdown:`## Description\n\n${description}\n\nVoir moins\n\nPasser la liste des médiasListe des médias\nPhotos (12)`,metadata:{sourceURL:listingUrl}}};
    const fetcher=fetchQueue(json({data:{remainingCredits:200}}),json(raw),json({data:{remainingCredits:195}}));
    const ctx=context("firecrawl");
    const result=await createFirecrawlProvider({apiKey:"test-secret",fetcher}).step(ctx);
    expect(result.observations[0]!.data.description).toBe(description);
    expect(result.observations[0]!.missingFields).toEqual(["landSurfaceM2"]);
    expect(result.usage.amount).toBe(5);
    expect(ctx.onEvidence).toHaveBeenCalledWith("firecrawl_scrape",raw);
    expect(fetcher.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
  });

  it("preserves extracted data if account usage cannot be attributed", async () => {
    const fetcher = fetchQueue(json({ error: "unsupported" }, 403), json({ success: true, data: { json: output() } }), json({ error: "unsupported" }, 403));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step(context("firecrawl"));
    expect(result.usage.amount).toBeNull();
    expect(result.observations).toHaveLength(1);
    expect(result.warnings).toContain("Firecrawl did not report attributable usage for this scrape.");
  });

  it("recovers a saved scrape via GET without claiming its zero-cost retrieval as the original charge", async () => {
    const fetcher = fetchQueue(json({ data: { remainingCredits: 195 } }), json({ success: true, data: { json: output() } }), json({ data: { remainingCredits: 195 } }));
    const result = await createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step({ ...context("firecrawl"), remoteJobId: "scrape:saved-scrape" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.firecrawl.dev/v2/scrape/saved-scrape");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("GET");
    expect(result.usage.amount).toBeNull();
  });

  it("requires enough allowance for the published JSON scrape tariff before starting new paid work", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    await expect(createFirecrawlProvider({ apiKey: "test-secret", fetcher }).step({ ...context("firecrawl"), remainingBudget: 4 }))
      .rejects.toMatchObject({ code: "budget_exhausted", billingUnknown: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("effective provider request evidence", () => {
  it.each(["xai", "firecrawl-agent", "firecrawl-scrape"] as const)("saves the complete redacted %s configuration before its paid POST", async operation => {
    const ctx = context(operation === "xai" ? "xai" : "firecrawl", operation === "firecrawl-agent" ? "discover" : "details");
    ctx.instructions += " Credential accidentally echoed in source instructions: test-secret; Bearer private-echo.";
    const fetcher = operation === "xai" ? fetchQueue(json(xaiResponse(output())))
      : operation === "firecrawl-agent" ? fetchQueue(json({ success: true, id: "audit-agent" }), json({ status: "completed", creditsUsed: 8, data: output() }), json({ events: [] }))
      : fetchQueue(json({ data: { remainingCredits: 100 } }), json({ success: true, creditsUsed: 5, data: { json: output() } }), json({ data: { remainingCredits: 95 } }));
    const provider = operation === "xai" ? createXaiProvider({ apiKey: "test-secret", fetcher }) : createFirecrawlProvider({ apiKey: "test-secret", fetcher });
    await provider.step(ctx);
    const evidenceCalls = vi.mocked(ctx.onEvidence).mock.calls;
    const auditIndex = evidenceCalls.findIndex(([kind]) => kind === "provider_request");
    const paidIndex = fetcher.mock.calls.findIndex(([, init]) => init?.method === "POST");
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    const artifact = evidenceCalls[auditIndex]?.[1] as Record<string, unknown>;
    const [endpoint, init] = fetcher.mock.calls[paidIndex]!;
    expect(artifact).toMatchObject({ endpoint, strategy: provider.strategy, capturePolicyVersion: CAPTURE_POLICY_VERSION, stage: "prepared", workId: ctx.work.id, source: { id: "leboncoin", domains: ["leboncoin.fr"] } });
    expect(artifact.body).toEqual(redactProviderValue(JSON.parse(String(init?.body)), ["test-secret"]));
    expect(artifact.model).toBe(operation === "firecrawl-scrape" ? null : provider.model);
    expect(artifact).not.toHaveProperty("headers");
    expect(JSON.stringify(artifact)).not.toContain("test-secret");
    expect(JSON.stringify(artifact)).not.toContain("private-echo");
    expect(vi.mocked(ctx.onEvidence).mock.invocationCallOrder[auditIndex]).toBeLessThan(fetcher.mock.invocationCallOrder[paidIndex]!);
    expect(evidenceCalls.filter(([kind]) => kind === "provider_request")).toHaveLength(1);
  });
});

describe("provider output", () => {
  it("retains valid observations while rejecting invalid ones and withdrawing the end-of-pages claim", () => {
    const payload = output();
    const result = parseCaptureOutput({ ...payload, observations: [...payload.observations, { ...payload.observations[0], url: "http://insecure.test" }], nextPages: [searchUrl, "https://user:password@example.test"] }, { amount: 1, unit: "credits" });
    expect(result.observations).toHaveLength(1);
    expect(result.nextPages).toEqual([searchUrl]);
    expect(result.incomplete).toBe(true);
    expect(result.exhausted).toBe(false);
  });
});
