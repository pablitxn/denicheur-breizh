# dénicheur·breizh

Local, single-user real-estate workspace. The Chrome extension captures
Leboncoin listings, the HTTP API persists them in SQLite and evaluates them,
and the web app reads the resulting runs, listings, recipes, and evaluations.

SQLite is private implementation detail of `apps/api`: neither the extension
nor the browser opens the database file. OpenAI is also called only by the API.

```text
Chrome extension ─┐
                  ├─ HTTP on 127.0.0.1 ─> apps/api ─> SQLite
React web app ────┘                         └─────────> OpenAI (optional)
```

## Local

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
cp apps/api/.env.example apps/api/.env
cp apps/extension/.env.example apps/extension/.env
pnpm dev            # API + web
pnpm dev:extension  # WXT extension watcher, in another terminal
```

The defaults bind the API to `127.0.0.1:4310`, persist data under
`apps/api/.data/`, and point both browser clients at that API. There is no
runtime mock fallback: if the API is down, the web app reports the failure and
the extension keeps its pending queue until synchronization succeeds.

## Workspace

- `apps/web`: Vite + React + TypeScript app.
- `apps/extension`: WXT + React Chrome extension PoC for user-assisted LeBonCoin crawling.
- `apps/api`: localhost-only Express API and SQLite owner.
- `packages/contracts`: shared Zod wire contracts for all three applications.
- `packages/design-system`: shared design tokens, component CSS, and React UI primitives.
- `turbo.json`: build graph for `build`, `typecheck`, `test:run`, `dev`, and `preview`.

The app imports `@denicheur-breizh/design-system/styles.css` once in `apps/web/src/main.tsx`, then consumes shared primitives from `@denicheur-breizh/design-system`.

## Realtime Spanish-to-French voice agent

The optional `Voix` / `Voz` experiment starts a minimal WebRTC voice translator with `gpt-realtime-2`. It is hidden by default; enable it in the web app with `VITE_ENABLE_REALTIME=true`. The API process must have `OPENAI_API_KEY` configured.

- Browser audio uses `RTCPeerConnection`: microphone input is added as a local audio track and model audio plays through a remote audio element.
- The app opens an `oai-events` data channel and sends `session.update` to configure a Spanish-to-French interpreter prompt.
- The localhost API endpoint is `POST /v1/realtime/session`. It accepts the browser SDP offer as `application/sdp`, then posts to `https://api.openai.com/v1/realtime/calls` with multipart `FormData` fields named `sdp` and `session`.
- `OPENAI_API_KEY` is read only by `apps/api`; Vite and the browser receive neither the credential nor an ephemeral copy.

## Checks

```bash
pnpm check          # types + unit/integration tests + production builds
pnpm test:e2e       # web + extension in bundled Chromium, no OpenAI spend
pnpm test:coverage  # per-app Vitest coverage summaries
pnpm check:all      # deterministic gate: check + E2E
```

The deterministic suite exercises the real MV3 extension, the HTTP API, SQLite,
and the built web application with sanitized fixtures. The opt-in live test
adds a real OpenAI request; it reads the existing ignored root `.env`:

```bash
pnpm test:e2e:live
```

## Chrome extension

The extension lives in `apps/extension`. `chrome.storage.local` is its durable
offline buffer, not the system of record. Runs and listings are checkpointed
there first, then synchronized idempotently to the API in batches of at most 20.
The popup exposes **Synchroniser maintenant** / **Sincronizar ahora** / **Sync
now** for an explicit retry. Existing local records can be imported without
running the crawler again.

Between manual iterations, clear only the stored listings and previous run while
keeping the configured filters, intelligence recipe, language, and theme:

```bash
npm run db:clean
```

The command opens the installed unpacked extension in Chrome and exits only
after the extension confirms the cleanup. It refuses to clean while a dashboard
still owns an active collection. It never deletes listings already persisted by
the API.

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

## Data and intelligence API

The API owns listings, per-run history, versioned recipes, and evaluation
results. Re-ingesting `source + externalId` merges only present fields, so a
later search summary cannot erase an earlier detailed capture. Evaluation is a
separate operation: an unavailable OpenAI service never removes or blocks a
persisted listing. The legacy `POST /v1/listings/filter` endpoint remains
temporarily available while callers migrate.

```bash
# OPENAI_API_KEY is optional and read only by apps/api
pnpm dev
pnpm dev:extension
```

The API listens on `127.0.0.1:4310` by default. Copy the relevant `.env.example`
files only when overriding the database path, model, port, allowed origins, or
client API URL.
Keep this unauthenticated v1 bound to localhost; it is not intended for public
deployment.

## Structure

- `apps/web/src/api/`: typed API boundary, query keys, React Query hooks.
- `apps/api/src/`: SQLite persistence, request validation, OpenAI evaluation, and HTTP transport.
- `packages/contracts/src/`: shared request, response, pagination, and persistence-facing schemas.
- `apps/web/src/components/`: app shell and app-specific visual components.
- `apps/web/src/features/`: MVP views for map, property list, scoring catalog, and builder.
- `apps/web/src/state/`: local UI state with Zustand.
