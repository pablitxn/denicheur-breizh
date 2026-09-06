# Denicheur local API

Express service that is the single data boundary shared by the Chrome extension and web app. It binds to `127.0.0.1:4310` by default. In production, every `/v1` read and mutation requires the operator Bearer token; only CORS preflight and the health endpoint remain public. Only this process opens SQLite or calls OpenAI.

## Configuration

The package scripts load the ignored workspace-root `.env` and an optional `apps/api/.env`. Supported variables are documented in `.env.example`:

- `NODE_ENV` defaults to `development`; setting it to `production` activates fail-closed startup validation.
- `API_REPLICA_COUNT` defaults to `1` outside production. Production must set it explicitly to `1`; multiple API replicas remain unsupported while delivery budgets are process-local.
- `OPENAI_API_KEY` stays in the server process and is never returned or logged.
- `OPERATOR_TOKEN` is required in production and protects every route except `OPTIONS` requests and `GET`/`HEAD /health`. It must be a high-entropy server secret and must never be embedded in a web or extension bundle.
- `OPENAI_FILTER_MODEL` defaults to the pinned `gpt-5-mini-2025-08-07` snapshot.
- `OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` and `OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` provide operator-maintained pricing inputs for budget accounting; they are not fetched from the provider.
- `OPENAI_GLOBAL_BUDGET_WINDOW_MS`, `OPENAI_GLOBAL_MAX_PROVIDER_CALLS`, `OPENAI_GLOBAL_MAX_INPUT_TOKENS`, `OPENAI_GLOBAL_MAX_OUTPUT_TOKENS`, and `OPENAI_GLOBAL_MAX_COST_MICRO_USD` bound every Responses API call in a rolling SQLite-backed deployment window.
- `OPENAI_REALTIME_ENABLED` defaults to `false`. Realtime can be enabled only for local development; production rejects it because this API cannot meter the complete session.
- `EVALUATION_MAX_PROVIDER_CALLS`, `EVALUATION_MAX_INPUT_TOKENS`, `EVALUATION_MAX_OUTPUT_TOKENS`, and `EVALUATION_MAX_COST_MICRO_USD` are server ceilings for one durable evaluation execution.
- `DENICHEUR_DB_PATH` defaults to `.data/denicheur.sqlite`. Production must mount this path on persistent storage and rejects `:memory:`; use `:memory:` only for isolated tests. The API creates a missing database directory owner-only (`0700`) and requires any pre-existing mount directory to already be `0700` and owned by the runtime user (`node` in the image); it never changes a shared parent directory. Database, rollback journal, WAL, and SHM files are hardened to `0600`, and startup fails closed on unsafe ancestors, symbolic links, hard links, or paths it cannot validate.
- `FILTER_API_HOST` defaults to `127.0.0.1`; container deployments must explicitly use `0.0.0.0` and enforce their ingress/network policy.
- `FILTER_API_PORT` defaults to `4310`.
- `FILTER_API_ALLOWED_ORIGINS` optionally replaces the development CORS policy with an exact allowlist.
- `MEDIA_STORAGE_MODE` defaults to `disabled` for development and must be `minio` in production.
- `MEDIA_S3_ENDPOINT`, `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`, `MEDIA_S3_ACCESS_KEY_ID`, and `MEDIA_S3_SECRET_ACCESS_KEY` configure the private S3-compatible store when media mirroring is enabled. Production requires an `https://` endpoint.
- `MEDIA_S3_FORCE_PATH_STYLE` defaults to `true`, as required by the provided local MinIO service.
- `MEDIA_MAX_ASSETS_PER_RUN`, `MEDIA_MAX_PENDING_JOBS`, `MEDIA_MAX_RESERVED_BYTES`, and `MEDIA_RESERVED_BYTES_PER_ASSET` bound media admission transactionally; processed sizes are re-admitted before any object upload.
- `MEDIA_DELIVERY_RATE_LIMIT_MAX`, `MEDIA_DELIVERY_MAX_CONCURRENT`, and `MEDIA_DELIVERY_MAX_BYTES_PER_MINUTE` bound media responses over a 60-second window.

Without an explicit allowlist, only local Vite origins and the repository's pinned Chrome extension origin are accepted. Local mode remains unauthenticated only while `OPERATOR_TOKEN` is unset. As soon as a token is configured in any environment, every API read and mutation requires `Authorization: Bearer …`; only CORS `OPTIONS` and `GET`/`HEAD /health` remain public. Requests without an `Origin` header are not exempt, because CORS is not authentication. Production refuses to start without a 32–512 character operator token, `API_REPLICA_COUNT=1`, `MEDIA_STORAGE_MODE=minio`, complete `MEDIA_S3_*` configuration, and an HTTPS media endpoint. If production also has `OPENAI_API_KEY`, both pricing variables must be explicit non-zero integers.

The local web dashboard polls `GET /v1/health/details` so it can preserve the database, media, and OpenAI status UX. Like every `/v1` route, that endpoint requires the Bearer token whenever `OPERATOR_TOKEN` is configured. In production, the checked-in web gateway reads the operator token from `WEB_OPERATOR_TOKEN_FILE`, injects it server-side for same-origin `/api` requests, and never exposes it to the browser bundle. The user-facing deployment still needs a private network or an independent user-authenticated ingress; the service credential authenticates the web service, not each end user. Never put `OPERATOR_TOKEN` in a `VITE_` variable.

### Evaluation resource budgets

Resource budgets are operational ceilings, not live provider quotes. Values are non-negative integer micro-USD and token counts; `1 USD = 1,000,000 micro-USD`.

| Variable | Default | Scope |
|---|---:|---|
| `OPENAI_GLOBAL_BUDGET_WINDOW_MS` | `60000` | Rolling SQLite-backed provider window. |
| `OPENAI_GLOBAL_MAX_PROVIDER_CALLS` | `200` | Maximum reserved Responses API calls in the window. |
| `OPENAI_GLOBAL_MAX_INPUT_TOKENS` | `1000000` | Maximum estimated/consumed input tokens in the window. |
| `OPENAI_GLOBAL_MAX_OUTPUT_TOKENS` | `1000000` | Maximum estimated/consumed output tokens in the window. |
| `OPENAI_GLOBAL_MAX_COST_MICRO_USD` | `3000000` | Maximum estimated/consumed cost in the window (`3 USD`). |
| `EVALUATION_MAX_PROVIDER_CALLS` | `200` | Maximum reserved provider calls per execution. |
| `EVALUATION_MAX_INPUT_TOKENS` | `1000000` | Maximum estimated/consumed input tokens per execution. |
| `EVALUATION_MAX_OUTPUT_TOKENS` | `1000000` | Maximum estimated/consumed output tokens per execution. |
| `EVALUATION_MAX_COST_MICRO_USD` | `3000000` | Maximum estimated/consumed cost per execution (`3 USD`). |
| `OPENAI_INPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` | `0` | Current input price supplied by the operator. |
| `OPENAI_OUTPUT_PRICE_MICRO_USD_PER_MILLION_TOKENS` | `0` | Current output price supplied by the operator. |

A create-execution request may include a lower `budget`, but it cannot raise the server ceilings. The API estimates the complete execution before queueing and returns `422 EVALUATION_EXECUTION_BUDGET_EXCEEDED` when that estimate is over any limit. Before each Responses API request, the evaluator reserves conservative capacity in the global rolling window and, for durable executions, in the execution budget. A reservation that no longer fits fails before the upstream request with `429 OPENAI_GLOBAL_BUDGET_EXHAUSTED` or `429 EVALUATION_EXECUTION_BUDGET_EXHAUSTED`. Completed reservations are settled against provider-reported usage. If actual usage unexpectedly exceeds its reservation, the overage remains visible and blocks later calls instead of being hidden, but the already-completed provider call cannot be undone. Update both price inputs from current provider terms whenever the model or pricing changes; zero-price development mode still enforces call and token ceilings, but does not provide meaningful cost accounting.

The global window covers durable executions, synchronous run evaluations, compatibility filtering, retries, and image-to-text fallbacks. The execution ceiling adds durable per-execution isolation. Global reservations and their integer micro-USD accounting are stored in the application SQLite database, admitted under an immediate transaction, and retained across API restarts until their creation time leaves the window. Production still supports exactly one API replica because other coordination controls remain single-replica. This ledger cannot see other applications using the same OpenAI account, so the provider account must retain an independent spend limit. Realtime is disabled by default and cannot be enabled in production because the API observes session creation, not the complete downstream usage.

### Media admission and delivery budgets

Per-run admission is checked before mutation, while global queue and storage ceilings are checked against the complete post-ingestion topology before the transaction commits. Pending assets reserve `MEDIA_RESERVED_BYTES_PER_ASSET`; staging atomically replaces that reservation with the three actual object sizes and fails before upload if the global cap would be exceeded. Completion must match the metadata that passed staging admission.

The current API has one configured operator identity, so its global queue and byte ceilings are also the effective per-operator ceilings. A future multi-operator deployment must partition usage by authenticated identity before sharing this admission policy.

| Variable | Default | Scope and rejection |
|---|---:|---|
| `MEDIA_MAX_ASSETS_PER_RUN` | `500` | Distinct assets ever admitted by one run; `429 MEDIA_RUN_BUDGET_EXCEEDED`. |
| `MEDIA_MAX_PENDING_JOBS` | `1000` | Global pending/processing plus GC work; `429 MEDIA_QUEUE_BUDGET_EXCEEDED`. |
| `MEDIA_MAX_RESERVED_BYTES` | `5368709120` | All active and orphaned known/reserved bytes until GC commits; `507 MEDIA_STORAGE_BUDGET_EXCEEDED`. |
| `MEDIA_RESERVED_BYTES_PER_ASSET` | `20971520` | Reservation for each not-ready asset; it cannot exceed the total budget. |
| `MEDIA_DELIVERY_RATE_LIMIT_MAX` | `120` | Media requests per limiter key in 60 seconds; `429 MEDIA_DELIVERY_RATE_LIMITED`. |
| `MEDIA_DELIVERY_MAX_CONCURRENT` | `8` | Simultaneous media streams per API process; `429 MEDIA_DELIVERY_CONCURRENCY_LIMITED`. |
| `MEDIA_DELIVERY_MAX_BYTES_PER_MINUTE` | `268435456` | Reserved response bytes per API process and minute; `429 MEDIA_DELIVERY_BYTES_LIMITED`. |

GC leases remain in `deleting` state across process restarts and are reclaimed in place only after expiry, so relinking cannot cancel a deletion between workers. Every asset incarnation receives a durable storage generation and new uploads use generation-scoped object keys; an expired worker can therefore finish a delayed delete only against the retired incarnation, never against a later upload. Compatible ready assets still share objects when their keys are canonical for their recorded generation. Pre-generation legacy keys remain readable and protected while referenced, but are never adopted by a new upload.

Startup reconciles legacy listing media, historical per-run admissions, jobs, and orphan tombstones in one transaction. The same admission limits apply before commit. An upgrade that would create or worsen an overage fails closed with the relevant `MEDIA_MAX_*` variable in the error and leaves no partial media topology; raise that limit or clean the legacy collected data, then restart. Existing overages that the reconciliation does not grow are grandfathered so an idempotent replay or a size-reducing stage can proceed, while any new growth remains rejected.

Collected-data cleanup uses a singleton SQLite lease and fencing token. The lease blocks ingestion, media claims, staging, and completion across every process sharing that database from the object-key snapshot through the SQLite reset. A crashed cleanup remains fail-closed; retrying after the five-minute lease deadline atomically takes ownership and performs the same idempotent deletion before writers resume. A deployment whose replicas use different SQLite files cannot share this fence.

Concurrency and byte-delivery budgets remain process-local. Production therefore fails closed unless the deployment explicitly declares `API_REPLICA_COUNT=1`; replicas must not be raised until those controls move to distributed coordination. Keep independent ingress/storage monitoring and capacity limits. These controls complement the fixed source-download safeguards (allowlisted HTTPS host, timeout, byte, and pixel caps) rather than replacing them.

The checked-in MinIO values are development-only defaults, not production credentials. To enable the local mirror, copy `.env.example` to `.env`, change `MEDIA_STORAGE_MODE` to `minio`, and start the private bucket before the API:

```sh
docker compose --env-file apps/api/.env -f compose.media.yml up -d
docker compose --env-file apps/api/.env -f compose.media.yml ps -a
pnpm exec turbo run dev --filter=@denicheur-breizh/api
```

The one-shot bootstrap container creates or updates the `denicheur-breizh-media` bucket, scoped user, and least-privilege policy on every `up`. The operation is idempotent, the bucket remains private, and the host API/console ports bind only to `127.0.0.1`. MinIO data persists in the `denicheur-media-data` volume when the Compose project is stopped.

Production rejects non-TLS media endpoints. Terminate TLS at MinIO and include its internal CA in the API trust store when necessary. Development and tests retain support for loopback `http://` MinIO.

With that local Compose project already healthy, run the opt-in real-MinIO integration suite with:

```sh
pnpm --filter @denicheur-breizh/api test:integration:minio
```

The suite uses the `MEDIA_S3_*` values loaded from `.env`/`apps/api/.env`, refuses non-loopback endpoints, and creates uniquely named test objects that it removes afterward. It covers S3 put/get streaming/delete plus worker recovery, conditional `ETag` delivery, and coordinated cleanup. Normal `test:run` execution leaves this suite skipped and does not contact MinIO.

## Stable catalog and history reads

`GET /v1/listings`, `/v1/runs`, and `/v1/evaluation-executions` use immutable pagination snapshots. The first page fixes the matching rows, their order, total, and JSON payload. Further pages preserve those values across inserts, sort/filter changes, evaluation updates, and budget/status changes. Starting again without a cursor sees the latest committed revision. Changing the page size is allowed; changing the endpoint, filters, or sort requires a fresh first page. Cursor values are opaque and can survive an API restart against the same SQLite database.

Snapshots expire 15 minutes after creation; accesses do not extend the deadline. Retention is bounded by 64 snapshots, 500,000 total ordered entries, and 512 MiB of logical payload references. One retained result is limited to 100,000 rows or 128 MiB; larger results return `422 PAGINATION_SNAPSHOT_TOO_LARGE` and require narrower filters. Results fitting in a single response do not retain a snapshot and remain subject to the endpoint page limit. Ordinary endpoints allow up to 100 records; map pages allow up to 1,000 compact records. Least-recently-used eviction can expire a cursor earlier under pressure. Expired or evicted cursors return `410 PAGINATION_CURSOR_EXPIRED`; legacy offset cursors return `410 PAGINATION_CURSOR_RESTART_REQUIRED`. Clients must discard their partially accumulated traversal and restart from page one on either 410 response. Invalid or mismatched cursors return 400. Response shapes and requests without cursors remain compatible.

Listing snapshots share immutable payload versions between revisions, filters, and sort orders, so polling does not copy every description, gallery, and evaluation again. A separate cache tracks and caps stored payload bytes at 512 MiB, reserving 128 MiB of headroom before a new fill and reclaiming unreferenced versions/LRU snapshots when needed. These are payload budgets, not exact SQLite file-size limits: indexes, pages and WAL add overhead, and freed pages are reusable without shrinking the file. Expiry cleanup runs at startup and pagination reads. When no snapshots expire during a request, the unchanged map path performs only an indexed expiry check and revision read; it does not scan or serialize the catalog. Expiry reclamation can also clean obsolete payload versions during that request. Revision updates are triggered transactionally on relevant SQLite writes. JSON snapshots do not pin media objects: an image removed from the current catalog may subsequently be garbage-collected and return 404 even while its old JSON metadata remains in a valid cursor. Clients retain their normal unavailable-image fallback.

`GET /v1/listings/metadata` returns `{ revision, total, sources: [{ source, count }] }` for the entire catalog. `GET /v1/listings/map?limit=500` returns compact records with coordinates, card fields, one cover asset and evaluation decision/score/date; descriptions, full galleries and evaluation evidence remain on detail reads. Both endpoints support `ETag` / `If-None-Match` with 304 responses. Map ETags identify a particular page, and only the first-page conditional request can avoid traversal of an unchanged complete catalog. The browser can poll metadata, reuse its complete map cache when that first-page ETag is unchanged, and request details when a property is opened. Bearer authentication and the existing CORS policy still apply; CORS permits `If-None-Match` and exposes `ETag`.

Listing sorts also support `title`, `surfaceM2`, `score` and `source`, in addition to `updatedAt`, `scrapedAt` and `priceEuros`. Missing values sort last in both directions, and zero remains a real value. Title and source use deterministic SQLite binary ordering, with source/external ID ties; this is not locale-aware alphabetical collation. The `sources` array uses repeated query parameters, each validated against the supported source enum (currently only `leboncoin`). The API rejects combining `source` with `sources`.

New snapshot creation still orders and stores one reference per matching row synchronously. This is an explicit consistency/performance tradeoff: the first projection fill also materializes the matching JSON once. If much larger catalogs or write rates make these pauses material, move SQLite work off the request event loop or precompute ordered views before increasing the caps. The SQLite transaction lasts only for one request, never across HTTP calls. Snapshot reads own their immediate transaction and are not called from inside repository write transactions.

## Durable execution counters

Migration 11 extracts each persisted item's decision and failed-step contribution once, then rebuilds execution counters from those scalar values. A completed checkpoint atomically replaces its previous contribution; retries/replays cannot double-count it. New checkpoints validate only the incoming result and do not read/parse the preceding result history. Finalization aggregates indexed scalar columns once to verify totals and terminal status. Existing lease ownership, cancellation, transaction boundaries and provider budget ledgers remain in force. Migration fails closed on unknown persisted decisions or missing/non-array step collections instead of silently discarding their contribution.

## Synthetic performance evidence

See [the 2026-09-06 benchmark report](../../docs/api-read-performance-2026-09-06.md) for reproducible commands, datasets, before/after timings, database/WAL bytes, validation and limitations.

## Commands

```sh
pnpm exec turbo run dev --filter=@denicheur-breizh/api
pnpm exec turbo run test:run --filter=@denicheur-breizh/api
pnpm exec turbo run typecheck --filter=@denicheur-breizh/api
pnpm exec turbo run build --filter=@denicheur-breizh/api
pnpm --filter @denicheur-breizh/api start
```

The Turbo commands build workspace dependencies such as `@denicheur-breizh/i18n` first. Run `start` only after the filtered build command.

## Data API

- Public `GET /health` returns only aggregate `{ status, service }` readiness without calling OpenAI. Authenticated `GET /v1/health/details` adds database state, media status plus `pending/processing/ready/failed` counters, and whether OpenAI is configured. A SQLite failure or degraded configured media store returns `503` on both endpoints; disabled media remains ready in local mode.
- `POST /v1/maintenance/collected-data/clear` clears collected iteration data after an exact confirmation under a durable SQLite fence spanning object deletion and the final transaction. A local CLI request refuses active checkpoints; the configured extension may clear a stale active checkpoint only while it holds the crawler's exclusive runner lease.
- `PUT /v1/ingestion/runs/:runId` upserts a run checkpoint and up to 20 sparse listings transactionally.
- `GET /v1/runs` lists runs; `GET /v1/runs/:runId` returns only bounded summary counts.
- `GET /v1/runs/:runId/listings` returns the snapshots observed by that run in opaque keyset-cursor pages of at most 100, without per-row evaluation/media history lookups.
- `GET /v1/listings` supports cursor pagination plus source, run, status, decision, property, price, surface, and energy filters.
- `GET /v1/listings/:source/:externalId` includes run observations and immutable evaluation history.
- `GET /v1/media/:assetId/thumbnail.webp` and `GET /v1/media/:assetId/gallery.webp` stream ready private objects through the API with immutable cache headers and conditional `ETag` responses.
- `GET /v1/recipes`, `GET /v1/recipes/active`, `PUT /v1/recipes/:id`, and `POST /v1/recipes/:id/activate` manage explicitly versioned recipes. At most one version is active.
- `POST /v1/runs/:runId/evaluations` loads that run's listing snapshots and a recipe version, calls the server-side evaluator, and persists each successful batch independently. Evaluation records include `runId`, so a later run never reuses an older run's result.
- `POST /v1/realtime/session` is disabled by default and always disabled in production. Local development may opt in with `OPENAI_REALTIME_ENABLED=true`; the API then accepts a browser WebRTC offer as `application/sdp`, authenticates upstream, and returns the SDP answer without exposing `OPENAI_API_KEY`.
- `POST /v1/listings/filter` remains available as the compatibility endpoint for direct batches.

Listings use `source + externalId` as their stable identity and expose it as `source:externalId`. Canonical scalar fields come from the newest observation that contains them, while richer descriptions and array values are retained. Canonical state is rebuilt from timestamp-ordered run snapshots, so out-of-order delivery is deterministic. Repeating an ingestion batch is idempotent, while the run-to-listing observation remains available for provenance.

Image ingestion stays non-blocking: original Leboncoin URLs are preserved, media jobs are recovered from SQLite, and the in-process worker stores the original plus 480 px and 1280 px WebP variants. The web app falls back to the original URL while an asset is pending or failed. Cleanup deletes the corresponding MinIO objects before committing the SQLite reset; if object storage is unavailable, the API returns `503` and preserves SQLite for an idempotent retry.

SQLite migrations are applied automatically and recorded in `schema_migrations`. The local database directory is ignored by Git.

To clear collected listings, runs, observations, and evaluations without deleting the live SQLite file or its WAL, keep the API running and run `pnpm db:clean` from the workspace root. The loaded extension coordinates its local reset with the API process that owns SQLite, so custom database paths and `:memory:` work without opening a second connection. Recipe versions and schema migrations are preserved. `pnpm --filter @denicheur-breizh/api db:clean` invokes the same live maintenance endpoint without changing extension storage. Use `pnpm db:clean:extension` when API-persisted data must remain available to the web app.

## Evaluation compatibility contract

`POST /v1/listings/filter` accepts one recipe and 1–20 normalized listings. The request must include an exact `locale` of `fr`, `es`, or `en`; the response echoes it. OpenAI writes summaries and criterion reasons in the requested language, while evidence remains a verbatim excerpt from the source listing. The service validates result completeness and exact evidence before calculating the final score and decision.

Contract shape:

```ts
interface FilterListingsRequest {
  runId: string;
  locale: "fr" | "es" | "en";
  recipe: IntelligenceRecipe;
  listings: FilterListingInput[];
}
```

Successful responses include the same batch metadata:

```ts
interface FilterListingsResponse {
  runId: string;
  locale: "fr" | "es" | "en";
  recipeId: string;
  recipeVersion: number;
  evaluator: { provider: "openai"; model: string; version: string };
  results: ListingEvaluationResult[];
}
```
