# Dependency upgrade — September 2026

Version and registry checks were performed on 26 September 2026.

## Application and test dependencies

All workspace manifests were compared against the public npm registry. Existing exact pins remain exact; dependency ranges retain their original caret or tilde policy. Workspace links are unchanged.

| Dependency family | Previous | Updated |
| --- | --- | --- |
| TypeScript | 5.9.3 | 7.0.2 |
| Vite / React plugin | 7.3.6 / 5.2.0 | 8.3.1 / 6.1.1 |
| WXT / web-ext | 0.20.27 / implicit runner | 0.21.4 / explicit 10.7.0 |
| Vitest / V8 coverage | 4.1.10 | 5.0.2 |
| jsdom / jest-dom | 27.4.0 / 6.9.1 | 30.1.1 / 7.0.1 |
| React / React DOM | 19.2.7 | 19.3.0 |
| MapLibre GL | 5.24.0 | 6.11.2 |
| Lucide React | 0.554.0 | 1.48.0 |
| OpenAI SDK | 6.46.0 | 7.23.0 |
| Playwright | 1.61.1 | 1.63.0 |
| Turbo | 2.10.4 | 2.11.4 |
| AWS S3 SDK / Sharp | 3.1089.0 / 0.35.3 | 3.1141.0 / 0.35.4 |
| Zod | 4.4.3 | 4.6.5 |
| TanStack Query / Zustand | 5.101.2 / 5.0.14 | 5.104.0 / 5.0.15 |

Smaller runtime and type-package updates are recorded in the manifests and lockfile. Dependencies already on their newest stable release retain their version.

pnpm 12 defaults to a 48-hour minimum release age. The workspace explicitly allows only the exact recent stable releases selected in this update, including pnpm 12.7.0 and its platform binaries so automatic package-manager selection also works; later versions still pass through the default gate. These temporary exceptions can be removed after 28 September 2026. The existing trust policy remains enabled.

Two deprecated transitive packages remain in the latest `web-ext` / `addons-linter` dependency tree: `eslint@9.39.4` and `whatwg-encoding@3.1.1`. They have no reported advisories in the completed audit. Their upstream version constraints are preserved instead of forcing incompatible majors into the extension validator.

### Compatibility changes

- TypeScript 7 removes `baseUrl`: client configurations now use explicit relative path aliases. Web tests explicitly include Node types, and the extension uses Vite's client declarations for CSS and asset imports. No new compiler checks are disabled.
- MapLibre 6 requires an explicit worker. Vite bundles the worker and its imports through `?worker&url`, and the application registers that URL before creating a map. Existing startup-error recovery is preserved.
- WXT 0.21 accepts Vite 8 and has an optional `web-ext` peer. The extension declares the runner explicitly so its development command remains available. Obsolete Vite and isolated-element overrides are removed.
- OpenAI SDK 7 requires Node 22 or newer; the selected Node 26 runtime satisfies that requirement. Application model choices and provider budgets are preserved.
- The full-page gallery database test has a 15-second timeout for its large fixture under V8 coverage; its query-count performance bound and data assertions are unchanged.
- Vite 8's bundler needs a direct build-time development guard to remove the local API URL from production output. The web client preserves its development and E2E URLs while production continues to use the same-origin gateway; the existing container check remains enforced.

Upstream migration references: [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [Vite 8](https://vite.dev/guide/migration), [WXT](https://wxt.dev/guide/resources/upgrading), [Vitest 5](https://vitest.dev/guide/migration/), [MapLibre 6](https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/), and [OpenAI SDK changelog](https://github.com/openai/openai-node/blob/master/CHANGELOG.md).

## Toolchain and container images

| Component | Previous | Updated | Compatibility work |
| --- | --- | --- | --- |
| Node.js | 24 in CI, Docker and `.nvmrc`; engines allowed 24–26 | 26.10.0 in CI, Docker and `.nvmrc`; engines require 26 | Align production, development and Node type definitions on the latest Current runtime. |
| pnpm | 11.17.0 | 12.7.0 | Align all pins and persist the Docker installation target for pnpm 12 pre-run verification. |
| Package-manager bootstrap | Bundled Corepack | `npm install --global pnpm@12.7.0` | Node 26 does not bundle Corepack. Bootstrap remains explicit and version-pinned. |
| Dockerfile frontend | Previous `docker/dockerfile:1` digest | 1.26.0, pinned by refreshed digest | Preserve reproducible local Docker builds. |
| nginx | 1.29 Alpine | 1.31.6 Alpine, pinned by digest | Retain the existing mainline release family and runtime gateway configuration. |
| Cosign | Previous Chainguard digest | Cosign 3.1.3 in the refreshed Chainguard `latest-dev` digest | Existing private-registry signing and verification flags remain accepted. |
| Kaniko | Archived Google 1.23.2 debug image | OSS Container Tools 1.28.5 debug image, pinned by digest | Update CI and both provenance producers/verifiers together. Preserve executor paths, registry authentication, TLS checks, flags and resource quotas. |

All selected image digests were resolved from their public registries. Node and nginx use multi-platform indexes; the API's native Sharp verification still requires Linux x64 in production. Both Dockerfiles copy every workspace manifest before installation, keeping workspace membership unchanged when the source tree is copied. Docker build stages retain `pnpm_config_supported_architectures` for Linux/x64/glibc after the targeted install, so pnpm 12 does not reject build or deploy commands because the platform configuration differs. The Kaniko debug image retains the BusyBox shell required by GitLab's script runner. No preview feature profile or telemetry endpoint is enabled.

Node 26.10.0 is the current release, not yet the LTS line. This is an intentional major runtime upgrade. The official [Node release](https://nodejs.org/en/blog/release/v26.10.0), [Corepack installation documentation](https://github.com/nodejs/corepack#default-installs), [pnpm 12 migration notes](https://github.com/pnpm/pnpm/releases/tag/v12.0.0), [nginx change log](https://nginx.org/en/CHANGES), and [maintained Kaniko release](https://github.com/osscontainertools/kaniko/releases/tag/v1.28.5) document the upstream changes.

## Infrastructure limit: MinIO Community

`compose.media.yml` retains its existing MinIO server and client versions. The [server repository](https://github.com/minio/minio) was archived on 25 April 2026, and the [client repository](https://github.com/minio/mc) on 14 July 2026. There is no maintained upstream Community image upgrade to select.

Live manifest checks for the compose server image, `minio/minio:RELEASE.2025-09-07T16-13-09Z`, returned `pull access denied`. Equivalent checks at `quay.io/minio/minio` and `quay.io/minio/mc` returned HTTP 401. Existing local images may still start, but a fresh media-stack installation is not verified and must not be presented as up to date.

Resolving this requires choosing a maintained S3-compatible service or supported distribution, testing its authentication and media lifecycle behavior, and planning a data migration with a restore test. This dependency update does not switch storage engines, modify credentials, start or stop the existing media service, or touch its volume.

## Tooling validation

- `node scripts/ci/check-image-provenance-ci.mjs --self-test`: passed after updating the pinned Node, pnpm and Kaniko references.
- `node scripts/ci/test-provision-gitlab-cosign.mjs`: passed.
- Cosign 3.1.3 container: accepted all existing sign, attest, verify and verify-attestation flags. The existing `--private-infrastructure` and `--tlog-upload` options are deprecated but still accepted by the CLI; the existing signing policy is preserved.
- Kaniko 1.28.5 container: BusyBox shell, executor and CA bundle checks passed; an isolated scratch-image build using the CI snapshot/reproducibility flags emitted a valid digest with pushes and cache writes disabled.
- Maintained Kaniko image signature: verified with Cosign against the project GitHub Actions identity and issuer, including certificate and transparency-log checks.
- Registry manifest resolution: passed for the selected Node, nginx, Dockerfile frontend and maintained Kaniko image digests.
- `DOCKER_DEFAULT_PLATFORM=linux/amd64 node apps/web/scripts/test-production-container.mjs`: passed with a freshly built Node 26 / nginx 1.31.6 image. Validates fail-closed configuration, ingress authentication, header filtering, same-origin API forwarding and the absence of runtime-secret names or development API addresses in browser assets. Its temporary containers, network and token files were removed.
- Full Kubernetes CI builds, image publication and production deployment are not performed by this upgrade task. The first protected pipeline must still validate the new builder on the configured runner.

## Application validation

- All 14 TypeScript configurations pass with TypeScript 7.0.2 and the upgraded dependencies.
- All nine workspace builds pass, including WXT production output and the MapLibre worker bundle. The E2E build also passes.
- Unit and integration suites: 1,194 tests pass across 100 test files, including the added production API fallback regression. Two opt-in MinIO integration tests are skipped; no live OpenAI calls are made.
- The collector native-audit regression test and design-token check pass.
- `pnpm audit --json`: zero reported vulnerabilities, including development dqependencies.
- `pnpm outdated -r --json`: empty result; no outdated direct workspace dependencies.
- `pnpm install --frozen-lockfile` succeeds with the full workspace architecture configuration; normal `pnpm typecheck` and `pnpm build` commands pass without local overrides.
- `pnpm test:coverage` passes with the upgraded Vitest/V8 coverage provider.
- A standalone production-dependency deployment of the API passes imports, in-memory SQLite migrations/readiness and actual Sharp WebP generation on Node 26.10.0 / macOS ARM64.
- The API Docker image builds and runs on Linux x64 with Node 26.10.0 as non-root user 1000. Its frozen install, portable deploy and native Sharp/WebP checks pass. An isolated container returns HTTP 200 for health, detailed readiness and listing reads; it uses test-mode in-memory storage because the production contract requires persistent storage and configured media. No network, credentials, host ports or volumes are used for that smoke test.
- Collector browser suite: all 27 tests pass with Playwright 1.63.0 and Chromium 153.0.8010.12.
- Web and extension browser suite: all 48 tests pass in the final complete run, with retries disabled. Together with the collector, all 75 browser tests pass.

### Browser-test investigation

The first complete web/extension run passed 46 tests and failed two collection scenarios with `Could not establish connection. Receiving end does not exist.` In both traces, the affected new tab received an HTTP 200 document response but never emitted Playwright's page-initialization event. This is consistent with an intermittent browser/automation initialization failure; a specific Chromium or Playwright root cause was not established.

Both scenarios subsequently passed eight isolated executions with CDP protocol logging and no retries. The final complete suite then passed all 48 tests without protocol logging or retries. No extension code, fixture behavior or browser-test timeouts were changed to make these pass. The initial failures remain recorded here rather than being treated as a confirmed product fix.
