# Local development and operations

[Project overview](../README.md) · [API reference](../apps/api/README.md) · [Production and image provenance](production.md)

Run all commands below from the repository root. The main workflow needs the API, web app and unpacked Chrome extension. OpenAI and MinIO are optional for local development.

## Requirements

| Tool | Version |
|---|---|
| Node.js | `>=26 <27` (26.10.0 in `.nvmrc` and containers) |
| pnpm | `12.7.0` |
| Google Chrome | `116+` for the extension |

From the repository root, install the pinned package manager and workspace dependencies:

```bash
npm install --global pnpm@12.7.0
pnpm install
```

See the [September 2026 dependency upgrade](dependency-upgrade-2026-09.md) for the dated migration record. Docker Compose is required only for the optional media mirror and container verification.

Start the API and web workspace:

```bash
pnpm dev
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API's public minimal health endpoint is available at [http://127.0.0.1:4310/health](http://127.0.0.1:4310/health); the local dashboard uses `/v1/health/details` for operational status.

In a second terminal, start the extension watcher:

```bash
pnpm dev:extension
```

For an unpacked installation, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/.output/chrome-mv3-dev` after WXT has generated it.

> [!TIP]
> The core workspace works without OpenAI. Add a key only when you want AI listing evaluation or the optional voice experiment.

## Optional configuration

The defaults work locally without environment files. The API scripts load the ignored root `.env`, followed by `apps/api/.env`. To configure OpenAI or override the API settings:

```bash
cp -n apps/api/.env.example apps/api/.env
```

`cp -n` preserves an existing configuration. Set `OPENAI_API_KEY` in `apps/api/.env`. The key is read only by the API and must never use a `VITE_` or `WXT_` prefix.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Enables fail-closed production startup validation when set to `production`. |
| `API_REPLICA_COUNT` | `1` outside production | Production requires an explicit value of `1`; multiple API replicas remain unsupported while delivery budgets are process-local. Collected-data cleanup itself is fenced durably in SQLite. |
| `OPERATOR_TOKEN` | unset | Required in production; authenticates every API read/mutation except health and CORS preflight. |
| `OPENAI_API_KEY` | unset | Enables server-side listing evaluation; Realtime also requires the separate local-only opt-in below. |
| `OPENAI_FILTER_MODEL` | pinned in `apps/api/.env.example` | Selects the server-side evaluation model. |
| `OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` / `OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` | `0` | Operator-maintained pricing used for evaluation cost budgets; production with an OpenAI key requires explicit non-zero values. |
| `OPENAI_GLOBAL_BUDGET_WINDOW_MS` | `60000` | Rolling SQLite-backed window for every Responses API call; reservations survive API restarts. |
| `OPENAI_GLOBAL_MAX_PROVIDER_CALLS` / `OPENAI_GLOBAL_MAX_INPUT_TOKENS` / `OPENAI_GLOBAL_MAX_OUTPUT_TOKENS` | `200` / `1000000` / `1000000` | Provider-call and token ceilings across durable and synchronous evaluation routes. |
| `OPENAI_GLOBAL_MAX_COST_MICRO_USD` | `3000000` | Maximum estimated/consumed Responses API cost per global window (`3 USD`). |
| `OPENAI_REALTIME_ENABLED` | `false` | Local-only Realtime server opt-in; production rejects `true` because complete session usage cannot be metered here. |
| `EVALUATION_MAX_PROVIDER_CALLS` / `EVALUATION_MAX_INPUT_TOKENS` / `EVALUATION_MAX_OUTPUT_TOKENS` | `200` / `1000000` / `1000000` | Server ceilings for one durable evaluation execution. |
| `EVALUATION_MAX_COST_MICRO_USD` | `3000000` | Maximum estimated/consumed cost per execution (`3 USD`). |
| `FILTER_API_HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` only inside an authenticated container/network boundary. |
| `FILTER_API_PORT` | `4310` | Changes the localhost API port. |
| `DENICHEUR_DB_PATH` | `.data/denicheur.sqlite` | Private SQLite path; production must mount it on persistent storage and rejects `:memory:`. |
| `FILTER_API_ALLOWED_ORIGINS` | local web + pinned extension | Replaces the exact CORS allowlist. |
| `MEDIA_STORAGE_MODE` | `disabled` | Enables asynchronous image mirroring when set to `minio`; production requires it. |
| `MEDIA_S3_ENDPOINT` | unset | S3-compatible endpoint; production requires HTTPS, while local Compose uses `http://127.0.0.1:9000`. |
| `MEDIA_S3_BUCKET` | unset | Private media bucket; the provided bootstrap creates `denicheur-breizh-media`. |
| `MEDIA_S3_REGION` | unset | S3 signing region; local MinIO uses `us-east-1`. |
| `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` | unset | Server-only media credentials; the example values are local-development defaults. |
| `MEDIA_S3_FORCE_PATH_STYLE` | `true` | Uses path-style requests for MinIO compatibility. |
| `MEDIA_MAX_ASSETS_PER_RUN` / `MEDIA_MAX_PENDING_JOBS` | `500` / `1000` | Admission ceilings for distinct run assets and queued work. |
| `MEDIA_MAX_RESERVED_BYTES` / `MEDIA_RESERVED_BYTES_PER_ASSET` | `5368709120` / `20971520` | Total media capacity budget and initial reservation per asset; actual staged bytes are re-admitted before upload. |
| `MEDIA_DELIVERY_RATE_LIMIT_MAX` / `MEDIA_DELIVERY_MAX_CONCURRENT` / `MEDIA_DELIVERY_MAX_BYTES_PER_MINUTE` | `120` / `8` / `268435456` | Request, concurrency, and byte budgets for API-served media. |
| `VITE_API_BASE_URL` | `http://127.0.0.1:4310` locally; `/api` in the production image | Points the browser at the API. `Dockerfile.web` rejects any production-image value other than the same-origin `/api`. |
| `VITE_ENABLE_REALTIME` | `false` | Reveals the experimental voice workspace; the local API must also opt in with `OPENAI_REALTIME_ENABLED=true`. |
| `WEB_API_UPSTREAM` | unset | Required by the production web container; private HTTP(S) origin such as `http://api:4310`, without credentials or a path. |
| `WEB_OPERATOR_TOKEN_FILE` | unset | Required absolute path to the operator-token secret mounted read-only in the web container. The token is never a build argument or browser variable. |
| `WEB_GATEWAY_AUTH_TOKEN_FILE` | unset | Required absolute path to a separate high-entropy token shared only with the trusted VPN/SSO ingress. It must not reuse the operator token. |
| `WEB_API_CA_FILE` | system CA bundle | Optional absolute CA-bundle path used with an HTTPS API upstream; certificate verification cannot be disabled. |
| Extension API URL / operator token | local runtime storage | Configured in the extension dashboard; never embedded in its build. |

## Optional local media mirror

To keep listing images in the private local MinIO bucket, copy the API example environment, enable its media mode, and start the dedicated Compose project. The example credentials and loopback HTTP endpoint are for development; use the [production contract](production.md) for a deployment.

```bash
cp -n apps/api/.env.example apps/api/.env
# In apps/api/.env, set MEDIA_STORAGE_MODE=minio.
docker compose --env-file apps/api/.env -f compose.media.yml up -d
docker compose --env-file apps/api/.env -f compose.media.yml ps -a
pnpm dev
```

MinIO serves its S3 API at [http://127.0.0.1:9000](http://127.0.0.1:9000) and its local console at [http://127.0.0.1:9001](http://127.0.0.1:9001); both published ports are bound to loopback only. The bootstrap service exits successfully after creating the private `denicheur-breizh-media` bucket and a user restricted to listing, reading, writing, and deleting objects in that bucket. Re-running the command is safe and preserves objects in the named volume.

The extension still sends the original Leboncoin URLs. Ingestion returns without waiting for downloads; the API worker validates and stores each original plus 480 px and 1280 px WebP variants. The web app uses API-served variants when ready and keeps the source URL as a temporary fallback. `pnpm db:clean` removes mirrored objects before clearing the catalog in SQLite and fails safely with `503` if MinIO cannot be reached.

Once the local MinIO Compose project is healthy, its real S3 integration suite is explicitly opt-in:

```bash
pnpm --filter @denicheur-breizh/api test:integration:minio
```

The command loads the configured local `MEDIA_S3_*` values and refuses non-loopback endpoints. Regular test runs skip this suite without contacting MinIO.

Stop the service without deleting stored media:

```bash
docker compose --env-file apps/api/.env -f compose.media.yml down
```

## Chrome extension

The extension turns a repeatable native search into structured local evidence:

1. It opens and owns the Leboncoin tabs required for the run.
2. It fills the visible native search form and follows native pagination.
3. It checkpoints every observed page and deduplicates canonical listing IDs.
4. It optionally opens detail pages sequentially to collect richer fields.
5. It buffers progress in `chrome.storage.local` and synchronizes idempotently to the API.

The crawler is deliberately paced and sequential. It may accept one unambiguous cookie banner, but it will not evade site controls:

- unavailable optional filters become warnings;
- CAPTCHA pauses until the user solves it and chooses **Resume**;
- DataDome, temporary restriction, or unusual activity produces a terminal `blocked-activity` state;
- restriction pages are never reloaded or retried automatically.

### Stable unpacked build

Build the extension once:

```bash
pnpm --filter @denicheur-breizh/extension build
```

Load `apps/extension/.output/chrome-mv3` in `chrome://extensions`. This build contains the pinned extension identity expected by the default API allowlist and does not require a watcher.

### Clear collected data

To clear the extension iteration, its catalog synchronization state, and the API catalog rendered by the web app while preserving filters, recipes, language, and theme:

```bash
pnpm db:clean
```

The API must be running and Chrome must have the current unpacked build loaded. The reset holds the crawler's exclusive lease, waits for any in-flight extension sync, refuses to race a live collection, and only reports success after the extension iteration and API catalog are empty. The immutable source-record archive and its unacknowledged capture outbox are preserved; see the [archive lifecycle](source-record-archive.md). Its internal 15-second deadline finishes before the CLI timeout, so a timed-out command cannot start a late cleanup.

To clear only the extension's local iteration data while preserving API-persisted listings:

```bash
pnpm db:clean:extension
```

Manual acceptance procedures:

- [Conservative one-listing smoke test](../tests/manual/leboncoin-one-listing-smoke.md)
- [Long multipage smoke test](../tests/manual/leboncoin-seventy-listing-smoke.md)

## Quality gates

Install Playwright's Chromium once when setting up a new test machine:

```bash
pnpm exec playwright install chromium
```

Then run the checks appropriate to your change:

```bash
pnpm check          # typecheck + design tokens + unit/integration tests + production builds
pnpm test:e2e       # deterministic web/API/MV3/SQLite E2E with sanitized fixtures
pnpm test:coverage  # per-package Vitest coverage summaries
pnpm check:all      # complete deterministic gate: check + E2E
```

The deterministic E2E suite runs against the real built Chrome extension, HTTP API, SQLite persistence, and web app without spending OpenAI credits.

The opt-in live AI test makes a real OpenAI request using the ignored root `.env`:

```bash
pnpm test:e2e:live
```

This validates the OpenAI-backed extension → API → storage path. It is separate from the manual live-site smoke tests above.

The live OpenAI test is opt-in and can incur provider charges. The live-site acceptance procedures use real Leboncoin pages; deterministic tests use sanitized fixtures. Neither kind of result should be presented as proof of the other.

## Storage and network boundaries

The API is the only owner of the main SQLite database. The extension buffers catalog updates in `chrome.storage.local` and sends idempotent batches of at most 20 listings. Its independent source-capture outbox preserves accepted extractor output before catalog normalization. Re-ingesting the same `source + externalId` does not duplicate the listing, and sparse newer observations do not erase richer earlier fields.

Local-first describes ownership of stored research data, not an entirely offline application:

| Feature | Network behavior |
|---|---|
| Core workspace | Browser clients communicate with the local API. The map fetches OpenStreetMap tiles; unmirrored listing photos can load from their source URLs. |
| Collection | A user-started extension run navigates the visible Leboncoin interface. |
| AI evaluation | The API sends the selected recipe and listing evidence to OpenAI, validates the response, and stores the result locally. Evaluation failures do not delete captured listings. |
| Media mirror | The API downloads allowlisted Leboncoin CDN images and stores originals plus WebP variants in private MinIO; browsers retrieve ready variants through the API. |
| Realtime voice | A separately enabled local experiment establishes a browser WebRTC session with OpenAI. Production disables it. |

`OPERATOR_TOKEN` also enables authentication in development when set. Direct Vite access assumes that it is unset; the [production gateway](production.md#web-gateway) injects that service credential without exposing it to the browser. The [API reference](../apps/api/README.md) documents contracts, budgets and persistence details.

## Optional voice experiment

Set `VITE_ENABLE_REALTIME=true` for the web app and `OPENAI_REALTIME_ENABLED=true` plus `OPENAI_API_KEY` for the local API to reveal the **Voice** workspace. It is a Spanish-to-French interpreter using OpenAI Realtime. The API authenticates session creation; the browser never receives the API key. The experiment is separate from the property-research workflow and is refused in production because session creation alone cannot meter complete downstream usage.

## Independent capture laboratory

The xAI / Firecrawl laboratory runs its own frontend (`5175`), API (`4315`), SQLite database and evidence store:

```bash
pnpm dev:collector
```

It compares each provider independently with an extension reference; a completed request or 99% recall does not establish complete capture. It does not write to the main catalog. Setup, credentials, commands and limitations are in the [collector guide](collector-lab.md), with a [demo walkthrough](collector-demo.md) and [evaluation methodology](collector-evaluation.md). The regular `dev`, `dev:all`, and `dev:extension` commands keep their existing applications.
