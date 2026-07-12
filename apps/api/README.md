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
pnpm --filter @denicheur-breizh/api dev
pnpm --filter @denicheur-breizh/api test:run
pnpm --filter @denicheur-breizh/api typecheck
pnpm --filter @denicheur-breizh/api build
pnpm --filter @denicheur-breizh/api start
```

`GET /health` never calls OpenAI. `POST /v1/listings/filter` accepts one recipe and 1–20 normalized listings. OpenAI returns only per-criterion verdicts; this service validates their completeness and evidence before calculating the final score and decision.
