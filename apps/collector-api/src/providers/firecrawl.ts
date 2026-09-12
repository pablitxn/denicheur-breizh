import { setTimeout as delay } from "node:timers/promises";
import { ProviderError, type CaptureProvider, type ProviderStepContext, type ProviderStepResult, type ProviderUsage } from "../adapter.js";
import { asRecord, nonNegativeNumber, ProviderTransportError, requestJson, type FetchLike } from "./http.js";
import { captureOutputJsonSchema, captureRepairOutputJsonSchema, parseCaptureOutput, parseRepairCaptureOutput, providerPrompt, recordProviderRequest, rethrowProviderError } from "./output.js";
import { normalizeScrapeDescription, scrapeEvidenceWarnings } from "./scrape-quality.js";
import { repairObservationFromEvidence } from "../detail-repair-evidence.js";
import { dataFields } from "@denicheur-breizh/collector-contracts";

export type FirecrawlStrategy = "firecrawl-agent-scrape-v1" | "firecrawl-agent-native-v2" | "firecrawl-agent-expanded-v3" | "firecrawl-detail-repair-v4" | "firecrawl-native-inventory-v5" | "firecrawl-gallery-audit-v6" | "firecrawl-gallery-walk-v7";
export interface FirecrawlProviderOptions { apiKey: string; fetcher?: FetchLike; pollIntervalMs?: number; strategy?: FirecrawlStrategy }
const baseUrl = "https://api.firecrawl.dev/v2";

export function createFirecrawlProvider(options: FirecrawlProviderOptions): CaptureProvider {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const strategy = options.strategy ?? "firecrawl-agent-scrape-v1";
  const request = (path: string, method: "GET" | "POST" | "DELETE", signal?: AbortSignal, body?: unknown) => requestJson({
    fetch: fetcher, url: `${baseUrl}${path}`, apiKey: options.apiKey, method,
    ...(signal ? { signal } : {}), ...(body === undefined ? {} : { body }),
  });
  async function balanceEvidence(context: ProviderStepContext): Promise<number | null> {
    try {
      const raw = await request("/team/credit-usage", "GET", context.signal);
      await context.onEvidence("firecrawl_balance", raw);
      return nonNegativeNumber(asRecord(asRecord(raw)?.data)?.remainingCredits);
    } catch (error) {
      if (error instanceof ProviderTransportError) await context.onEvidence("firecrawl_balance_error", { status: error.status, response: error.response });
      return null;
    }
  }
  async function scrape(context: ProviderStepContext): Promise<ProviderStepResult> {
    if (context.work.urls.length !== 1) throw new ProviderError("provider_work_invalid", "Firecrawl detail work requires exactly one URL.");
    if (context.remoteJobId && !context.remoteJobId.startsWith("scrape:")) throw new ProviderError("provider_work_invalid", "An Agent job cannot resume detail scrape work.");
    if (!context.remoteJobId && context.remainingBudget < 5) throw new ProviderError("budget_exhausted", "A fresh Firecrawl JSON scrape requires its published 5-credit operation allowance.");
    const before = await balanceEvidence(context);
    const resumed = context.remoteJobId?.startsWith("scrape:") === true;
    const prepare = strategy === "firecrawl-agent-expanded-v3";
    const walk = strategy === "firecrawl-gallery-walk-v7";
    const gallery = strategy === "firecrawl-gallery-audit-v6" || walk;
    const galleryScripts = walk ? context.source.detailGalleryWalkScripts : context.source.detailGalleryAuditScripts;
    const inventory = strategy === "firecrawl-native-inventory-v5" || gallery;
    const repair = strategy === "firecrawl-detail-repair-v4" || inventory;
    const observationScript = inventory ? context.source.detailInventoryEvidenceScript : context.source.detailRepairEvidenceScript;
    if (prepare && !context.source.detailPreparationScript) throw new ProviderError("strategy_source_unsupported", "The selected source has no native detail preparation for this strategy.");
    if (repair && (!context.source.detailRepairScript || !observationScript)) throw new ProviderError("strategy_source_unsupported", "The selected source has no native detail repair and evidence scripts.");
    if (gallery && !galleryScripts) throw new ProviderError("strategy_source_unsupported", "The selected source has no native gallery audit scripts.");
    const body = {
      url: context.work.urls[0], formats: ["markdown", "links", ...(repair ? ["html"] : []), { type: "json", schema: repair ? captureRepairOutputJsonSchema : captureOutputJsonSchema, prompt: providerPrompt(context, "page", repair ? context.work.repairFields ?? dataFields : undefined, inventory, gallery, walk) }],
      maxAge: 0, storeInCache: false, location: { country: "FR", languages: ["fr-FR", "fr"] }, timeout: 300000,
      ...(prepare ? { actions: [{ type: "executeJavascript", script: context.source.detailPreparationScript }, { type: "wait", milliseconds: 750 }] } : {}),
      ...(repair ? { actions: [{ type: "executeJavascript", script: context.source.detailRepairScript }, { type: "wait", milliseconds: 750 }, ...(gallery ? [
        { type: "executeJavascript", script: galleryScripts!.open }, { type: "wait", milliseconds: 750 },
        { type: "executeJavascript", script: galleryScripts!.observeAndClose }, { type: "wait", milliseconds: 500 },
        { type: "executeJavascript", script: galleryScripts!.verifyClosed },
      ] : [{ type: "executeJavascript", script: observationScript }])] } : {}),
    };
    if(!resumed) await recordProviderRequest(context, options.apiKey, { endpoint: `${baseUrl}/scrape`, model: null, strategy, body });
    const raw = resumed
      ? await request(`/scrape/${encodeURIComponent(context.remoteJobId!.slice(7))}`, "GET", context.signal)
      : await request("/scrape", "POST", context.signal, body);
    const response = asRecord(raw);
    const data = asRecord(response?.data);
    const metadata = asRecord(data?.metadata);
    const scrapeId = metadata?.scrapeId ?? metadata?.scrape_id;
    if (typeof scrapeId === "string" && !resumed) await context.onRemoteJob(`scrape:${scrapeId}`);
    await context.onEvidence("firecrawl_scrape", raw);
    const after = await balanceEvidence(context);
    const reported = nonNegativeNumber(response?.creditsUsed) ?? nonNegativeNumber(data?.creditsUsed) ?? nonNegativeNumber(metadata?.creditsUsed);
    // A same-team delta is conservative, not a provider-attributed invoice.
    const balanceDelta = !resumed && before !== null && after !== null && before >= after ? before - after : null;
    const usage: ProviderUsage = { amount: reported ?? balanceDelta, unit: "credits", detail: reported !== null
      ? { basis: "reported", creditsUsed: reported, scrapeId: scrapeId ?? null }
      : { basis: balanceDelta === null ? "unreported" : "account_balance_delta", estimated: balanceDelta !== null,
        before, after, publishedTariffCredits: 5, note: "Conservative account usage during request; may include other activity." } };
    await context.onUsage(usage);
    if (response?.success === false) throw new ProviderError("provider_output_invalid", "Firecrawl could not scrape the requested listing.");
    const result = repair ? parseRepairCaptureOutput(data?.json, usage, context.work.urls[0]!) : parseCaptureOutput(data?.json, usage);
    result.observations = result.observations.map(observation => normalizeScrapeDescription(observation, raw, context.work.urls[0]));
    if (repair) result.observations = result.observations.map(observation => {
      const repaired = repairObservationFromEvidence(observation, raw, context.work.urls[0]!, {nativeInventory:inventory});
      for (const field of ["energyClass", "gesClass"] as const) {
        const before = observation.data[field], after = repaired.data[field];
        if (typeof before === "string" && before.trim() && before !== after && repaired.fieldStates?.[field]?.status !== "unresolved") result.warnings.push(`Native source evidence corrected ${field} from model value ${before} to ${after ?? repaired.fieldStates?.[field]?.status} for ${observation.url}.`);
      }
      return repaired;
    });
    result.warnings.push(...scrapeEvidenceWarnings(raw, context.work.urls[0]));
    result.nextPages = []; result.exhausted = false;
    if (balanceDelta !== null && reported === null) result.warnings.push("Firecrawl scrape usage is estimated from the account balance change.");
    if (usage.amount === null) result.warnings.push("Firecrawl did not report attributable usage for this scrape.");
    return result;
  }
  async function agent(context: ProviderStepContext): Promise<ProviderStepResult> {
    let jobId = context.remoteJobId;
    if (jobId?.startsWith("scrape:")) throw new ProviderError("provider_work_invalid", "A scrape job cannot resume discovery work.");
    if (!jobId) {
      if(strategy === "firecrawl-agent-native-v2" && context.source.id !== "leboncoin") throw new ProviderError("strategy_source_unsupported", "The native-home strategy currently supports Leboncoin only.");
      const prompt = providerPrompt(context, strategy === "firecrawl-agent-native-v2" ? "native-session" : ["firecrawl-detail-repair-v4", "firecrawl-native-inventory-v5", "firecrawl-gallery-audit-v6", "firecrawl-gallery-walk-v7"].includes(strategy) ? "cards-only" : "page", undefined, ["firecrawl-native-inventory-v5", "firecrawl-gallery-audit-v6", "firecrawl-gallery-walk-v7"].includes(strategy), ["firecrawl-gallery-audit-v6", "firecrawl-gallery-walk-v7"].includes(strategy), strategy === "firecrawl-gallery-walk-v7");
      if (prompt.length > 10000) throw new ProviderError("provider_work_invalid", "The Firecrawl Agent prompt exceeds its documented 10,000-character limit.");
      const body = {
        prompt, ...(strategy === "firecrawl-agent-native-v2" ? { urls: ["https://www.leboncoin.fr/"] } : context.work.urls.length ? { urls: context.work.urls } : {}),
        schema: captureOutputJsonSchema, maxCredits: context.remainingBudget, strictConstrainToURLs: false, model: "spark-2", effort: "low",
      };
      await recordProviderRequest(context, options.apiKey, { endpoint: `${baseUrl}/agent`, model: "spark-2", strategy, body });
      const raw = await request("/agent", "POST", context.signal, body);
      const response = asRecord(raw);
      if (typeof response?.id !== "string" || !response.id) {
        await context.onEvidence("firecrawl_agent_start", raw);
        await context.onUsage({ amount: null, unit: "credits", final: false, detail: { outcomeUnknown: true } });
        throw new ProviderError("provider_output_invalid", "Firecrawl accepted no recoverable job ID.", true);
      }
      jobId = response.id;
      await context.onRemoteJob(jobId);
      await context.onEvidence("firecrawl_agent_start", raw);
    }
    let latestUsage: ProviderUsage = { amount: null, unit: "credits", detail: { jobId, basis: "unreported" } };
    const warnings: string[] = [];
    let terminal = false;
    try {
    while (!context.signal.aborted) {
      const raw = await request(`/agent/${encodeURIComponent(jobId)}`, "GET", context.signal);
      const status = asRecord(raw);
      const credits = nonNegativeNumber(status?.creditsUsed);
      if (credits !== null) {
        latestUsage = { amount: credits, unit: "credits", final: status?.status === "completed" || status?.status === "failed" || status?.status === "cancelled", detail: { jobId, basis: "reported", creditsUsed: credits } };
        await context.onUsage(latestUsage);
      }
      await context.onEvidence("firecrawl_agent_status", raw);
      try {
        const trace = await request(`/agent/${encodeURIComponent(jobId)}/trace`, "GET", context.signal);
        await context.onEvidence("firecrawl_agent_trace", trace);
        const traceCredits = nonNegativeNumber(asRecord(trace)?.creditsUsed);
        if (traceCredits !== null && status?.status === "processing") {
          latestUsage = { amount: traceCredits, unit: "credits", final: false, detail: { jobId, basis: "reported_in_progress", creditsUsed: traceCredits } };
          await context.onUsage(latestUsage);
        }
      } catch (error) {
        if (error instanceof ProviderTransportError) await context.onEvidence("firecrawl_trace_error", { status: error.status, response: error.response, jobId });
        if (!warnings.includes("Firecrawl execution trace was unavailable.")) warnings.push("Firecrawl execution trace was unavailable.");
      }
      if (status?.status === "completed") {
        terminal = true;
        // An intermediate trace is not the terminal billed amount.
        if (credits === null) {
          latestUsage = { amount: null, unit: "credits", detail: { jobId, basis: "terminal_usage_unreported" } };
          await context.onUsage(latestUsage);
        }
        const result = parseCaptureOutput(status.data, latestUsage);
        result.warnings.push(...warnings);
        return result;
      }
      if (status?.status === "failed" || status?.status === "cancelled") {
        terminal = true;
        if (credits === null) await context.onUsage({ amount: null, unit: "credits", detail: { jobId, basis: "terminal_usage_unreported" } });
        throw new ProviderError(status.status === "cancelled" ? "provider_cancelled" : "provider_failed", "Firecrawl Agent stopped without completing this page. See the saved provider evidence.", credits === null);
      }
      if (status?.status !== "processing" && status?.status !== "queued" && status?.status !== "pending") {
        throw new ProviderError("provider_output_invalid", "Firecrawl returned an unknown job state; resume the saved job to reconcile it.", true);
      }
      await context.onProgress("Firecrawl is processing the current search page.");
      try { await delay(options.pollIntervalMs ?? 3000, undefined, { signal: context.signal }); }
      catch { if (context.signal.aborted) break; throw new ProviderError("provider_unavailable", "Firecrawl polling was interrupted.", true); }
    }
    throw new ProviderError("provider_cancelled", "Firecrawl polling stopped; the saved remote job must be cancelled or reconciled.", true);
    } catch (error) {
      if (terminal) throw error;
      // A failed GET does not cost credits itself, but its saved Agent can still be billing.
      if (error instanceof ProviderTransportError) await context.onEvidence("provider_error", { status: error.status, response: error.response, outcomeUnknown: true, jobId });
      await context.onUsage({ amount: null, unit: "credits", final: false, detail: { jobId, basis: "remote_job_unreconciled", lastReportedAmount: latestUsage.amount } });
      throw new ProviderError(context.signal.aborted ? "provider_cancelled" : "provider_job_interrupted", "Firecrawl job remains recoverable; resume polling its saved ID to reconcile the final result and charge.", true);
    }
  }
  return {
    id: "firecrawl", model: "spark-2", strategy, configured: Boolean(options.apiKey.trim()),
    async step(context) {
      if (!options.apiKey.trim()) throw new ProviderError("provider_unconfigured", "Configure FIRECRAWL_API_KEY on the collector backend.");
      if (context.remainingBudget <= 0 && !context.remoteJobId) throw new ProviderError("budget_exhausted", "The Firecrawl experiment budget is exhausted.");
      try { return await (context.work.kind === "details" ? scrape(context) : agent(context)); }
      catch (error) { return rethrowProviderError(error, context, "credits"); }
    },
    async cancel(remoteJobId) {
      // Completed /scrape responses cannot be cancelled; preserve them for retrieval.
      if (remoteJobId.startsWith("scrape:")) return;
      await request(`/agent/${encodeURIComponent(remoteJobId)}`, "DELETE", AbortSignal.timeout(30000));
    },
    async balance() {
      const raw = await request("/team/credit-usage", "GET", AbortSignal.timeout(30000));
      const data = asRecord(asRecord(raw)?.data);
      return { remaining: nonNegativeNumber(data?.remainingCredits), expiresAt: null,
        note: "Account credit balance. Billing-period end does not establish promotional-credit expiry." };
    },
  };
}
