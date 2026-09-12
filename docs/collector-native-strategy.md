# Firecrawl native navigation strategies

The lab keeps each run's provider, strategy and model immutable. A resumed run resolves those saved values, even if today's defaults differ. Providers are never mixed. New Firecrawl captures can explicitly select `firecrawl-agent-scrape-v1`, `firecrawl-agent-native-v2` or `firecrawl-agent-expanded-v3`.

## Implemented: Agent native homepage v2

V1 submits the current search page to `/v2/agent`; pagination returned by that job becomes separate work. V2 still uses Firecrawl Agent (`spark-2`) and the existing job/usage ledger, but starts each discovery job at `https://www.leboncoin.fr/`. Its prompt asks the agent to configure the native homepage/search controls, verify every filter and preserve its browser session while clicking observed pagination controls throughout that job. It prioritizes collecting listing identities; incomplete details remain separate fresh JSON `/scrape` work with the same provider.

This is an instruction to Firecrawl's hosted agent, not a deterministic browser driver. Trace evidence and reference comparison must establish what actually happened. Neither a successful HTTP response, an agent's end claim nor the displayed total proves complete coverage. Unfinished work returns observed continuation URLs and a partial flag. A later continuation starts a new Agent job and rebuilds the native search; the API does not promise browser continuity across Agent jobs.

Both versions explicitly prohibit bounties, external tasks/tickets, feedback/support submissions, seller contact, CAPTCHA solving and access-control bypass. A challenge must preserve evidence and stop affected extraction. V2 has no hard-coded listing/page cap and no automatic switch to another strategy or provider. It uses the same remaining `maxCredits` allowance, remote-job recovery and cumulative billing rules as v1. The UI records the chosen version with the run.

Every new paid provider POST first saves a `provider_request` artifact with its exact effective body (including source instructions, prompt, schema and request controls), endpoint, strategy, model when known, and `capturePolicyVersion: collector-capture-policy-v2`. Request headers are excluded and credential echoes are redacted. `stage: prepared` means the artifact precedes dispatch; it does not itself prove that the request was sent. Resume GETs do not fabricate a new request artifact. Earlier captures predate this instrumentation and must be described as such rather than assigned reconstructed prompts. Firecrawl's internal JSON scrape model is not exposed, so that request artifact records `model: null`.

## Implemented detail experiment: expanded v3

`firecrawl-agent-expanded-v3` retains V1 discovery and adds native description preparation to fresh detail Scrape requests. Its source adapter supplies JavaScript which finds the Description heading and clicks the visible `Voir plus` button within that heading's section, followed by a short rendering wait. Other buttons and sections are left alone. Firecrawl executes these actions before extraction and retains the action result with the raw response. A click is not a completeness assertion: collapsed source markdown still invalidates the returned description, even if the JSON model calls it captured. V1 and V2 are unchanged and the new strategy must be selected explicitly.

This bounded Scrape action does not introduce a persistent browser session or solve search pagination. It is a separate experiment prompted by live evidence that plain Scrape returned the collapsed description while its JSON extractor claimed success. The action contract is documented in the [official Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape).

## Deferred: a deterministic native browser driver

The extension is useful as a reference for homepage → category/location/text → results filters → native next control, DOM stabilization, duplicate-page detection, and challenge detection. Reuse pure selectors/extractors with a Playwright navigation driver, not the extension's Chrome messaging/storage runner. Do not inherit its result/page/storage caps or description truncation.

A future `firecrawl-native-session-v4` should persist a browser session separately from an Agent job. The geo-sensitive option is:

1. `POST /v2/scrape` with the homepage, `formats:["markdown"]`, `maxAge:0`, `storeInCache:false`, `location:{country:"FR",languages:["fr-FR","fr"]}` and `profile:{name:"collector-lbc-<runId>",saveChanges:true}`.
2. Persist `data.metadata.scrapeId` before interacting. Call `POST /v2/scrape/{scrapeId}/interact` with controlled `code`, `language:"node"`, `timeout:60` and an `origin` label. The remote `page` is a Playwright Page. Observe controls, apply and verify filters, click actual next-page controls, checkpoint each page and open details in the same context. No AI `prompt` calls are needed.
3. Stop with `DELETE /v2/scrape/{scrapeId}/interact`, storing `sessionDurationMs` and `creditsBilled`. One session needs one billing operation across its page work; never count its cumulative charge once per page.

The standalone alternative now uses `POST /v2/interact`, `POST /v2/interact/{id}/execute`, `GET /v2/interact?status=active` and `DELETE /v2/interact/{id}`. Older `/v2/browser` examples are legacy. Create supports explicit `ttl` (30–3600 seconds), `activityTtl` (10–3600), `streamWebView` and a named `profile`; it does not document `location`, `proxy` or `maxCredits`. Session state is saved to a profile on close. A closed session ID cannot be reused; a replacement session loads the same profile and resumes from the durable checkpoint. Keep CDP/access URLs private.

Current published billing is 2 credits/browser-minute for code only, or 7 if prompts are used, prorated by seconds with a one-minute minimum; scrape is billed separately. Reserve the session allowance and reconcile the actual close response. If final billing is unavailable, retain unknown usage rather than recording zero. TTL is a renewable resource bound, not a global result limit. Live tests must confirm whether a French initial scrape preserves the network/session conditions needed by Leboncoin; session persistence does not guarantee access through an IP/geographical restriction.

Official references checked 2026-09-12:

- [Agent](https://docs.firecrawl.dev/features/agent)
- [Scrape parameters](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Interact](https://docs.firecrawl.dev/api-reference/endpoint/scrape-execute)
- [Stop interaction and billing](https://docs.firecrawl.dev/api-reference/endpoint/scrape-browser-delete)
- [Standalone session creation](https://docs.firecrawl.dev/api-reference/endpoint/browser-create)
- [Standalone code execution](https://docs.firecrawl.dev/api-reference/endpoint/browser-execute)
- [Standalone session deletion](https://docs.firecrawl.dev/api-reference/endpoint/browser-delete)
