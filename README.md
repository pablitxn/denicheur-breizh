# dénicheur·breizh

Turborepo workspace for the real-estate decision ecosystem. The current web app
lives in `apps/web`, and shared UI foundations live in `packages/design-system`.

## Local

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
# set VITE_ENABLE_REALTIME=true and add OPENAI_API_KEY only for the optional voice experiment
pnpm dev
```

The app uses the in-repo mock API by default. Set `VITE_API_BASE_URL` when a backend is available; API calls are isolated in `apps/web/src/api/denicheurApi.ts`.

## Workspace

- `apps/web`: Vite + React + TypeScript app.
- `apps/extension`: WXT + React Chrome extension PoC for user-assisted LeBonCoin crawling.
- `apps/api`: localhost-only Express API for OpenAI-backed listing evaluation.
- `packages/design-system`: shared design tokens, component CSS, and React UI primitives.
- `turbo.json`: build graph for `build`, `typecheck`, `test:run`, `dev`, and `preview`.

The app imports `@denicheur-breizh/design-system/styles.css` once in `apps/web/src/main.tsx`, then consumes shared primitives from `@denicheur-breizh/design-system`.

## Realtime Spanish-to-French voice agent

The optional `Voix` / `Voz` experiment starts a minimal WebRTC voice translator with `gpt-realtime-2`. It is hidden by default; enable it with `VITE_ENABLE_REALTIME=true` only in a Vite dev/preview environment that also has `OPENAI_API_KEY`.

- Browser audio uses `RTCPeerConnection`: microphone input is added as a local audio track and model audio plays through a remote audio element.
- The app opens an `oai-events` data channel and sends `session.update` to configure a Spanish-to-French interpreter prompt.
- The local server endpoint is `POST /api/realtime/session`. It accepts the browser SDP offer as `application/sdp`, then posts to `https://api.openai.com/v1/realtime/calls` with multipart `FormData` fields named `sdp` and `session`.
- `OPENAI_API_KEY` is only read server-side by the Vite middleware.

## Checks

```bash
pnpm check          # types + unit/integration tests + production builds
pnpm test:e2e       # web + extension in bundled Chromium, no OpenAI spend
pnpm test:coverage  # per-app Vitest coverage summaries
pnpm check:all      # deterministic gate: check + E2E
```

The opt-in live test exercises the complete extension → content script → local
API → OpenAI → Chrome storage path. It reads the existing ignored root `.env`
and makes a real API request:

```bash
pnpm test:e2e:live
```

## Chrome extension PoC

The extension lives in `apps/extension` and writes crawler state to `chrome.storage.local`.

For a stable manual smoke test, build once and load the production directory:

```bash
pnpm --filter @denicheur-breizh/extension build
```

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `apps/extension/.output/chrome-mv3`. This build carries the pinned
extension ID expected by the local API and does not require a WXT watcher.

For active extension development instead, keep the following command running
and load `apps/extension/.output/chrome-mv3-dev` only after it has regenerated:

```bash
pnpm --filter @denicheur-breizh/extension dev
```

The dashboard accepts native search filters instead of a copied Leboncoin URL.
Each run creates and focuses its own home tab, completes the visible site form,
submits the search once, applies the remaining filters on the results page, and
uses the native pagination control until it reaches the requested cap (up to
100 unique listings) or the site exposes no next page. Every observed page is
checkpointed and cross-page duplicates are removed before details are opened.
It opens detail pages sequentially in temporary tabs when **Collect detail pages**
is enabled. Existing Leboncoin tabs are never reused or modified. The extension
may accept one unambiguous cookie banner, but it does not bypass access controls.

The crawler deliberately limits action and typing speed, waits between detail
pages, and avoids concurrent extraction. This pacing is not a guarantee against
restrictions. Optional filters that are unavailable in the current Leboncoin UI
are reported as warnings and do not stop the run. A captcha pauses the run on
the affected tab until the user solves it manually and explicitly chooses
**Resume** in the dashboard. DataDome, temporary-restriction, and
unusual-activity screens produce a terminal `blocked-activity` state with no
reload or automatic retry.

For any live smoke test, do not pre-open, construct, or navigate Leboncoin tabs;
the extension owns its home, search, and detail tabs for the run. Do not reload
a restriction or switch profiles/networks to work around it. The conservative
one-listing Computer Use procedure is documented in
[`tests/manual/leboncoin-one-listing-smoke.md`](tests/manual/leboncoin-one-listing-smoke.md).
The long, multipage acceptance procedure is documented in
[`tests/manual/leboncoin-seventy-listing-smoke.md`](tests/manual/leboncoin-seventy-listing-smoke.md).

## Intelligent listing filter

The extension can collect up to 100 listings and sends detailed records to the
local Express API in sequential batches of at most 20. The API evaluates
structured personal criteria through OpenAI. Intelligence remains a
backend-only capability: the API key stays in the server environment and is
never bundled with the extension.

```bash
# OPENAI_API_KEY is read from the ignored workspace .env
pnpm --filter @denicheur-breizh/api dev
pnpm --filter @denicheur-breizh/extension dev
```

The API listens on `127.0.0.1:4310` by default. Copy the relevant `.env.example`
files only when overriding the model, port, allowed origins, or extension API URL.
Keep this unauthenticated v1 bound to localhost; it is not intended for public
deployment.

## Structure

- `apps/web/src/api/`: typed API boundary, query keys, React Query hooks.
- `apps/api/src/`: request validation, OpenAI evaluation, deterministic scoring, and HTTP transport.
- `apps/web/src/assets/`: typed mock data that mirrors the expected backend resources.
- `apps/web/src/components/`: app shell and app-specific visual components.
- `apps/web/src/features/`: MVP views for map, property list, scoring catalog, and builder.
- `apps/web/src/state/`: local UI state with Zustand.
