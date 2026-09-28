# Production and image provenance

[Project overview](../README.md) · [Local development](local-development.md) · [Web gateway reference](../apps/web/README.md)

This document describes the deployment contract and image-publication controls committed in this repository. It does not assert that a deployment is running or that a specific pipeline has passed. The application uses one operator identity and one API replica; an authenticated ingress is a separate infrastructure responsibility.

## API startup and persistence

`NODE_ENV=production` is fail-closed: the API requires a high-entropy operator token, an explicit `API_REPLICA_COUNT=1`, complete private MinIO configuration over HTTPS, and `MEDIA_STORAGE_MODE=minio`; it also refuses Realtime. Every `/v1` read and mutation then requires the Bearer token; only CORS preflight plus `GET`/`HEAD /health` remain public. Public readiness returns `503` when SQLite or configured media storage is unavailable. If OpenAI is enabled, production startup also requires explicit non-zero input/output pricing so the global and per-execution cost ceilings are meaningful. The SQLite path must be mounted persistently. The API requires its database directory to be owned by the runtime user with mode `0700`; database and companion files use `0600`. Startup rejects unsafe paths rather than changing shared parent directories. See the [API configuration](../apps/api/README.md#configuration) for the full filesystem contract.

The exact [evaluation](../apps/api/README.md#evaluation-resource-budgets) and [media](../apps/api/README.md#media-admission-and-delivery-budgets) budget semantics are documented in the API reference.

## Web gateway

The production web image owns two distinct authenticated boundaries. Its browser bundle is hard-wired to same-origin `/api`; at container startup nginx reads the ingress proof from `WEB_GATEWAY_AUTH_TOKEN_FILE` and the API service identity from `WEB_OPERATOR_TOKEN_FILE`, requires them to be different, and validates `WEB_API_UPSTREAM`. Every request, including static dashboard paths and `/api/*`, must present the exact ingress proof; only `/healthz` remains public for container liveness. After that check succeeds, nginx injects the operator `Authorization: Bearer …` only on the private API hop. Client-supplied authorization, origin, cookies, referer and ingress-proof headers are not forwarded, and credential-like upstream response headers are hidden. The container refuses to start when a secret, upstream, token syntax, port, or HTTPS CA bundle is invalid. Local Vite calls `http://127.0.0.1:4310` directly and assumes the optional `OPERATOR_TOKEN` is unset; the isolated E2E bundle remains at `http://127.0.0.1:14310`.

Mount the same operator secret configured on the API and a separate gateway token as read-only files. Never place either secret in a `VITE_` variable, Docker build argument, image layer, command-line flag, or repository file. A production orchestrator must provide, at minimum:

```text
WEB_API_UPSTREAM=http://api:4310
WEB_OPERATOR_TOKEN_FILE=/run/secrets/denicheur-operator-token
WEB_GATEWAY_AUTH_TOKEN_FILE=/run/secrets/denicheur-gateway-auth-token
```

The operator token is a service identity, not a user session. The VPN/SSO ingress must authenticate every dashboard request, remove any client-supplied `X-Denicheur-Ingress-Token`, then set that header to the gateway token before proxying to the web container. Never expose container port `8080` through a route that bypasses that ingress. Use an HTTPS upstream whenever the API hop crosses a network that is not already isolated and trusted; the gateway verifies `WEB_API_CA_FILE` and offers no TLS downgrade switch.

Use `pnpm --filter @denicheur-breizh/web test:container` to build the real image and verify the fail-closed startup cases, rendered nginx configuration, and absence of secret configuration names from the served bundle. See [the web runtime reference](../apps/web/README.md) for the deployment contract.

## Protected image publication

Container publication runs only for protected branches or tags and requires three externally managed GitLab CI/CD variables:

- `COSIGN_PRIVATE_KEY_FILE` — a protected **File** variable containing an encrypted, externally provisioned Cosign private key, scoped to the `cosign-signing` environment;
- `COSIGN_PUBLIC_KEY_FILE` — a protected **File** variable containing the matching public key;
- `COSIGN_PASSWORD` — a protected, masked/hidden variable containing the private-key decryption password, also scoped to `cosign-signing`.

The canonical push and pull endpoint is `registry.orchid-labs.xyz:32443`; both Kaniko and Cosign validate its public TLS chain and hostname using their system trust by default. If a runner path needs an additional trust anchor, configure `REGISTRY_INTERNAL_CA_FILE` as an optional protected **File** variable containing a PEM CA bundle. Kaniko appends that bundle to system trust and Cosign supplies it through `--registry-cacert`; neither tool has a TLS bypass.

## CI resource policy

All jobs use the `denicheur-breizh-ci` resource group, so this project's pipelines remain serial. Validation and provenance jobs are capped at 1000m CPU plus a 100m helper and 1 GiB memory plus a 128 MiB helper; Kaniko builders receive a scoped 1280 MiB build limit. `TURBO_CONCURRENCY=1` also serializes package tasks inside `check-workspace`, matching the single-CPU runner allocation rather than making API, web and extension tests contend in one pod. Docker dependency installs target only Linux x64 glibc, cap pnpm network concurrency at four and lifecycle child concurrency at one, and Kaniko caches run layers without asynchronously publishing each tiny manifest-copy layer during installation. Local image builds verify all supply-chain policy entries by default; the protected CI builders may trust the lockfile only after their required `check-workspace` job has already verified the exact same revision.

## Signing material

The repository never generates or stores signing material. Provision and rotate that key pair through the infrastructure's secret-management process, scope the private key and password to `cosign-signing`, restrict protected-ref pipelines to trusted maintainers, and never expose private signing material to merge-request or unprotected-branch pipelines. Protect the `cosign-signing` environment as an additional control when the GitLab tier supports protected environments. Only `sign-image-provenance` declares that environment; validation, build and verification jobs fail immediately if the private key or password is mistakenly configured with a broader environment scope.

After externally generating a temporary directory containing `cosign.key`, `cosign.pub` and a single-line `password`, provision the variables with `node scripts/ci/provision-gitlab-cosign.mjs --material-dir <directory>`. The private key and password files must be mode `0600`. The helper refuses overwrites, passes values only through mode-`0600` temporary JSON files, suppresses API bodies, removes debug tracing, rolls back partial variable creation, and removes its payload directory. Run `node scripts/ci/test-provision-gitlab-cosign.mjs` first to exercise the fake-`glab` leak and rollback harness. Remove the external material directory through its approved custody workflow after live metadata confirms the three variables.

## Registry signatures and provenance

For each `api` or `web` image, Kaniko publishes revision and pipeline tags but hands subsequent jobs only the canonical digest reference (`registry/repository@sha256:...`), digest, and build-job ID. `sign-image-provenance` then:

1. validates the protected project/ref identity, optional additional registry CA, encrypted private key and matching public key;
2. reads the immutable subject from the registry and stores a Cosign signature there with exact project, revision, pipeline, build-job, image and builder annotations;
3. stores a signed `https://slsa.dev/provenance/v1` attestation in the registry, binding the same digest to the source revision, Dockerfile, pipeline invocation and digest-pinned Kaniko builder.

`verify-image-cryptography` has no private key. It reads each digest back through `REGISTRY_PULL_HOST`, validates the registry-backed signature and SLSA attestation against `COSIGN_PUBLIC_KEY_FILE`, and requires the exact signed annotations. `verify-image-provenance` then decodes the already verified DSSE envelope and fail-closes unless its subject, digest, project, revision, pipeline, distinct build-job IDs, Dockerfile and builder are exact. Only that final job publishes `verified-images.env` with `API_IMAGE` and `WEB_IMAGE`.

## Deployment boundary

The repository currently has no deploy or promotion job. The deterministic CI policy harness uses a closed allowlist for the current stages and jobs. Any future promotion job must run in an explicitly declared stage after `provenance`, reuse the protected-ref image rules, download `verify-image-provenance` artifacts, and consume both `API_IMAGE` and `WEB_IMAGE`; unreviewed includes, stages, or jobs fail closed. The harness also rejects mutable image references, unpinned CI tool images, registry TLS bypasses, in-repository key generation, missing signature/attestation commands, and several provenance tampering cases.

The private key is the configured trust anchor and signatures are intentionally not sent to the public Rekor service. Key custody, rotation and audit therefore remain infrastructure responsibilities. A successful protected image-publication pipeline proves publication, registry read-back, cryptographic identity and predicate consistency; it does not prove that an image was subsequently deployed.

The CI builder, Cosign verifier and Node/Nginx Docker stages retain readable version tags but are locked to reviewed multi-platform manifest digests.

## Verification commands

```bash
node scripts/ci/check-image-provenance-ci.mjs --self-test
node scripts/ci/test-provision-gitlab-cosign.mjs
pnpm --filter @denicheur-breizh/web test:container
```

The policy harness checks the committed [GitLab pipeline](../.gitlab-ci.yml); the container harness builds and exercises the real web gateway. These checks validate repository behavior. Registry state, secret configuration, ingress enforcement and a deployed image digest require separate live verification.
