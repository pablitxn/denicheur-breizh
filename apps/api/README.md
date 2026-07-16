# Denicheur filter API

Local-only Express service for semantic listing classification. It binds to `127.0.0.1:4310` by default and is intentionally unauthenticated, so it must not be exposed publicly.

## Configuration

The package scripts load the ignored workspace-root `.env` and an optional `apps/api/.env`. Supported variables are documented in `.env.example`:

- `OPENAI_API_KEY` stays in the server process and is never returned or logged.
- `OPENAI_FILTER_MODEL` defaults to the pinned `gpt-5-mini-2025-08-07` snapshot.
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

`GET /health` never calls OpenAI. `POST /v1/listings/filter` accepts one recipe and 1–20 normalized listings. The request must include an exact `locale` of `fr`, `es`, or `en`; the response echoes it. OpenAI writes summaries and criterion reasons in the requested language, while evidence remains a verbatim excerpt from the source listing. The service validates result completeness and exact evidence before calculating the final score and decision.

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
