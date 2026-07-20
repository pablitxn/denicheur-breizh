# Denicheur local API

Express service that is the single data boundary shared by the Chrome extension and web app. It binds to `127.0.0.1:4310` by default. In production, reads remain public while every non-read request requires the operator Bearer token. Only this process opens SQLite or calls OpenAI.

## Configuration

The package scripts load the ignored workspace-root `.env` and an optional `apps/api/.env`. Supported variables are documented in `.env.example`:

- `OPENAI_API_KEY` stays in the server process and is never returned or logged.
- `OPERATOR_TOKEN` is required in production and protects every method other than `GET`, `HEAD`, and `OPTIONS`. It must be a high-entropy server secret and must never be embedded in a web or extension bundle.
- `OPENAI_FILTER_MODEL` defaults to the pinned `gpt-5-mini-2025-08-07` snapshot.
- `DENICHEUR_DB_PATH` defaults to `.data/denicheur.sqlite`. Use `:memory:` for isolated tests.
- `FILTER_API_HOST` defaults to `127.0.0.1`; container deployments must explicitly use `0.0.0.0` and enforce their ingress/network policy.
- `FILTER_API_PORT` defaults to `4310`.
- `FILTER_API_ALLOWED_ORIGINS` optionally replaces the development CORS policy with an exact allowlist.
- `MEDIA_STORAGE_MODE` defaults to `disabled` for development and must be `minio` in production.
- `MEDIA_S3_ENDPOINT`, `MEDIA_S3_BUCKET`, `MEDIA_S3_REGION`, `MEDIA_S3_ACCESS_KEY_ID`, and `MEDIA_S3_SECRET_ACCESS_KEY` configure the private S3-compatible store when media mirroring is enabled.
- `MEDIA_S3_FORCE_PATH_STYLE` defaults to `true`, as required by the provided local MinIO service.

Without an explicit allowlist, only local Vite origins and the repository's pinned Chrome extension origin are accepted. In production, requests without an `Origin` header still need `Authorization: Bearer …` for any non-read method; CORS is not treated as authentication.

The checked-in MinIO values are development-only defaults, not production credentials. To enable the local mirror, copy `.env.example` to `.env`, change `MEDIA_STORAGE_MODE` to `minio`, and start the private bucket before the API:

```sh
docker compose --env-file apps/api/.env -f compose.media.yml up -d
docker compose --env-file apps/api/.env -f compose.media.yml ps -a
pnpm exec turbo run dev --filter=@denicheur-breizh/api
```

The one-shot bootstrap container creates or updates the `denicheur-breizh-media` bucket, scoped user, and least-privilege policy on every `up`. The operation is idempotent, the bucket remains private, and the host API/console ports bind only to `127.0.0.1`. MinIO data persists in the `denicheur-media-data` volume when the Compose project is stopped.

With that local Compose project already healthy, run the opt-in real-MinIO integration suite with:

```sh
pnpm --filter @denicheur-breizh/api test:integration:minio
```

The suite uses the `MEDIA_S3_*` values loaded from `.env`/`apps/api/.env`, refuses non-loopback endpoints, and creates uniquely named test objects that it removes afterward. It covers S3 put/get streaming/delete plus worker recovery, conditional `ETag` delivery, and coordinated cleanup. Normal `test:run` execution leaves this suite skipped and does not contact MinIO.

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

- `GET /health` checks SQLite without calling OpenAI and reports media status plus `pending/processing/ready/failed` counters; MinIO degradation keeps HTTP `200` while a SQLite failure returns `503`.
- `POST /v1/maintenance/collected-data/clear` transactionally clears collected iteration data after an exact confirmation. A local CLI request refuses active checkpoints; the configured extension may clear a stale active checkpoint only while it holds the crawler's exclusive runner lease.
- `PUT /v1/ingestion/runs/:runId` upserts a run checkpoint and up to 20 sparse listings transactionally.
- `GET /v1/runs` and `GET /v1/runs/:runId` expose runs and the listing snapshot actually observed by that run.
- `GET /v1/listings` supports cursor pagination plus source, run, status, decision, property, price, surface, and energy filters.
- `GET /v1/listings/:source/:externalId` includes run observations and immutable evaluation history.
- `GET /v1/media/:assetId/thumbnail.webp` and `GET /v1/media/:assetId/gallery.webp` stream ready private objects through the API with immutable cache headers and conditional `ETag` responses.
- `GET /v1/recipes`, `GET /v1/recipes/active`, `PUT /v1/recipes/:id`, and `POST /v1/recipes/:id/activate` manage explicitly versioned recipes. At most one version is active.
- `POST /v1/runs/:runId/evaluations` loads that run's listing snapshots and a recipe version, calls the server-side evaluator, and persists each successful batch independently. Evaluation records include `runId`, so a later run never reuses an older run's result.
- `POST /v1/realtime/session` accepts a browser WebRTC offer as `application/sdp` and returns OpenAI's SDP answer. The API builds the Realtime session and authenticates the upstream request; the browser never receives `OPENAI_API_KEY`.
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
