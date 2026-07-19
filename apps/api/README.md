# Denicheur local API

Local-only Express service that is the single data boundary shared by the Chrome extension and web app. It binds to `127.0.0.1:4310` by default and is intentionally unauthenticated, so it must not be exposed publicly. Only this process opens SQLite or calls OpenAI.

## Configuration

The package scripts load the ignored workspace-root `.env` and an optional `apps/api/.env`. Supported variables are documented in `.env.example`:

- `OPENAI_API_KEY` stays in the server process and is never returned or logged.
- `OPENAI_FILTER_MODEL` defaults to the pinned `gpt-5-mini-2025-08-07` snapshot.
- `DENICHEUR_DB_PATH` defaults to `.data/denicheur.sqlite`. Use `:memory:` for isolated tests.
- `FILTER_API_PORT` defaults to `4310`.
- `FILTER_API_ALLOWED_ORIGINS` optionally replaces the development CORS policy with an exact allowlist.

Without an explicit allowlist, only local Vite origins and the repository's pinned Chrome extension origin are accepted. Requests without an `Origin` header remain available for local CLI use.

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

- `GET /health` checks SQLite without calling OpenAI and reports only whether OpenAI is configured.
- `POST /v1/maintenance/collected-data/clear` transactionally clears collected iteration data after an exact confirmation. A local CLI request refuses active checkpoints; the configured extension may clear a stale active checkpoint only while it holds the crawler's exclusive runner lease.
- `PUT /v1/ingestion/runs/:runId` upserts a run checkpoint and up to 20 sparse listings transactionally.
- `GET /v1/runs` and `GET /v1/runs/:runId` expose runs and the listing snapshot actually observed by that run.
- `GET /v1/listings` supports cursor pagination plus source, run, status, decision, property, price, surface, and energy filters.
- `GET /v1/listings/:source/:externalId` includes run observations and immutable evaluation history.
- `GET /v1/recipes`, `GET /v1/recipes/active`, `PUT /v1/recipes/:id`, and `POST /v1/recipes/:id/activate` manage explicitly versioned recipes. At most one version is active.
- `POST /v1/runs/:runId/evaluations` loads that run's listing snapshots and a recipe version, calls the server-side evaluator, and persists each successful batch independently. Evaluation records include `runId`, so a later run never reuses an older run's result.
- `POST /v1/realtime/session` accepts a browser WebRTC offer as `application/sdp` and returns OpenAI's SDP answer. The API builds the Realtime session and authenticates the upstream request; the browser never receives `OPENAI_API_KEY`.
- `POST /v1/listings/filter` remains available as the compatibility endpoint for direct batches.

Listings use `source + externalId` as their stable identity and expose it as `source:externalId`. Canonical scalar fields come from the newest observation that contains them, while richer descriptions and array values are retained. Canonical state is rebuilt from timestamp-ordered run snapshots, so out-of-order delivery is deterministic. Repeating an ingestion batch is idempotent, while the run-to-listing observation remains available for provenance.

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
