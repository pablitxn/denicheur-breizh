# Web dashboard

The React dashboard talks directly to `http://127.0.0.1:4310` under local Vite development. The isolated Playwright bundle explicitly uses `http://127.0.0.1:14310`.

## Production gateway contract

`Dockerfile.web` accepts only `VITE_API_BASE_URL=/api`, so a production browser never calls the private API origin and never receives its operator token. The nginx runtime admits requests only after a trusted ingress proves them, proxies `/api/*` to the configured private API, removes the `/api` prefix, and injects the operator Bearer identity server-side.

The container requires:

- `WEB_API_UPSTREAM`: an `http://` or `https://` origin containing a DNS hostname or IPv4 address and optional valid port, with no path, query, fragment, or credentials;
- `WEB_OPERATOR_TOKEN_FILE`: an absolute path to a readable regular file containing the same 32–512 character RFC 6750 bearer token configured as API `OPERATOR_TOKEN`;
- `WEB_GATEWAY_AUTH_TOKEN_FILE`: a different absolute, readable file containing a high-entropy 32–512 character unpadded base64url token shared only with the authenticated ingress;
- `WEB_API_CA_FILE`: optional absolute CA-bundle path for HTTPS upstreams. It defaults to the image system bundle and nginx always verifies the upstream certificate.

Both token files should be mounted read-only and readable by UID/GID `101`, which runs both the entrypoint and nginx. Never reuse the operator token as the gateway token. Do not provide either token through an environment variable, `VITE_` variable, build argument, image layer, or command-line argument.

The ingress must authenticate every dashboard request through VPN or SSO, remove any client-supplied `X-Denicheur-Ingress-Token`, and set that header to the gateway token before proxying to this container. It must not expose a route that bypasses the ingress and reaches port `8080` directly. The gateway token proves the request traversed that trusted enforcement point; it is not a browser credential or an end-user session. Direct, missing, malformed, and forged requests receive `401`, including static dashboard paths and `/api/*`. Only `/healthz` remains public for container liveness.

The operator token authenticates the web service to the API and is used only after the ingress gate succeeds. The gateway strips `X-Denicheur-Ingress-Token` before the API hop, so neither trust credential crosses its intended boundary.

Startup renders a mode-`0600` nginx include under `/tmp`, validates the complete nginx configuration, clears its shell variables, and only then launches nginx. Missing or malformed settings stop the container. `GET /healthz` is nginx liveness; it does not claim that the API is ready.

The gateway overwrites client `Authorization`, strips `Origin`, `Referer`, `Cookie`, and the ingress proof on the API hop, hides credential-like response headers, disables proxy buffering and downstream caching, and ensures `/api` media paths take precedence over the static-file matcher.

## Verification

```bash
pnpm --filter @denicheur-breizh/web test:run
pnpm --filter @denicheur-breizh/web typecheck
pnpm --filter @denicheur-breizh/web build
pnpm --filter @denicheur-breizh/web test:container
```

The container test builds `denicheur-breizh-web:gateway-test`, proves missing and malformed runtime configuration fails closed, validates a correctly rendered nginx configuration, and checks the served static directory for operator-token configuration names. Through real containers it also proves direct and forged requests return `401`, the trusted ingress request succeeds, ingress proof is stripped upstream, and `/healthz` remains public. Set `WEB_GATEWAY_TEST_IMAGE` to choose another disposable test tag; pass `--reuse-image` after `--` to reuse an already-built image.
