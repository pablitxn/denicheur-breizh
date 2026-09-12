import { ProviderError, type CaptureProvider, type ProviderUsage } from "../adapter.js";
import { asRecord, integerTicks, requestJson, type FetchLike } from "./http.js";
import { captureOutputJsonSchema, parseCaptureOutput, providerPrompt, recordProviderRequest, rethrowProviderError } from "./output.js";

export interface XaiProviderOptions { apiKey: string; model?: string; fetcher?: FetchLike }

export function createXaiProvider(options: XaiProviderOptions): CaptureProvider {
  const model = options.model ?? "grok-4.6";
  const fetcher = options.fetcher ?? globalThis.fetch;
  return {
    id: "xai", model, strategy: "xai-web-search-v1", configured: Boolean(options.apiKey.trim()),
    async step(context) {
      if (!options.apiKey.trim()) throw new ProviderError("provider_unconfigured", "Configure XAI_API_KEY on the collector backend.");
      if (context.remainingBudget <= 0) throw new ProviderError("budget_exhausted", "The xAI experiment budget is exhausted.");
      if (context.remoteJobId) throw new ProviderError("provider_resume_unsupported", "The interrupted xAI request must be reconciled before starting another request.", true);
      try {
        const endpoint = "https://api.x.ai/v1/responses";
        const body = { model, input: [{ role: "user", content: providerPrompt(context) }],
            tools: [{ type: "web_search", filters: { allowed_domains: context.source.domains } }],
            text: { format: { type: "json_schema", name: "capture_output", schema: captureOutputJsonSchema, strict: true } },
            max_output_tokens: 16384, max_turns: 5, parallel_tool_calls: false, reasoning: { effort: "low" }, store: false,
        };
        await recordProviderRequest(context, options.apiKey, { endpoint, model, strategy: "xai-web-search-v1", body });
        const raw = await requestJson({ fetch: fetcher, url: endpoint, apiKey: options.apiKey, method: "POST", signal: context.signal, body });
        const response = asRecord(raw);
        const rawUsage = asRecord(response?.usage);
        const ticks = integerTicks(rawUsage?.cost_in_usd_ticks);
        const usage: ProviderUsage = { amount: ticks === null ? null : Number(BigInt(ticks)) / 1e10, unit: "usd",
          detail: { costInUsdTicks: ticks, responseId: response?.id ?? null, model: response?.model ?? model, usage: rawUsage } };
        await context.onUsage(usage);
        await context.onEvidence("xai_response", raw);
        const output = Array.isArray(response?.output) ? response.output : [];
        const messages = output.map(asRecord).filter((item) => item?.type === "message");
        const text = messages.flatMap((message) => Array.isArray(message?.content) ? message.content : [])
          .map(asRecord).filter((item) => item?.type === "output_text" && typeof item.text === "string").map((item) => item!.text).join("");
        const isTruncated = response?.status === "incomplete";
        let payload: unknown;
        try { payload = JSON.parse(text) as unknown; }
        catch { throw new ProviderError(isTruncated ? "provider_output_truncated" : "provider_output_invalid", isTruncated ? "xAI reached its response token limit; this work needs subdivision." : "xAI did not return parseable structured output."); }
        const result = parseCaptureOutput(payload, usage);
        if (isTruncated) { result.incomplete = true; result.exhausted = false; result.warnings.push("xAI marked this response incomplete."); }
        if (!output.some((item) => asRecord(item)?.type === "web_search_call")) {
          result.exhausted = false;
          result.incomplete = true;
          result.warnings.push("The xAI response has no hosted web-search call evidence; coverage is unverified.");
        }
        if (context.work.kind === "details") { result.nextPages = []; result.exhausted = false; }
        return result;
      } catch (error) { return rethrowProviderError(error, context, "usd"); }
    },
  };
}
