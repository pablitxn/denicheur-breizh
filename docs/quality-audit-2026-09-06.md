# Expanded product quality audit — 2026-09-06

This follow-up implements all four “Next priorities” from [the first review](quality-review-2026-09-06.md), committed as `bb70a16`. It also reviews the failure paths between browser UI, MV3 dashboards/service worker, durable evaluation jobs and SQLite. It retains the existing visual identity and French, Spanish and English interfaces.

The scope is the local product and isolated fixtures. No real collection was cleared, no live property collection or model evaluation was requested, and no deployment or push was performed.

## Findings and changes

| Priority | Finding and user impact | Implemented change | Evidence |
| --- | --- | --- | --- |
| P1 | Concurrent canonical writes could duplicate or skip listing/run/execution rows between offset pages. | Versioned opaque cursors freeze matching order, membership and values; expiration has an explicit restart path. | Mutable-sort, insertion, evaluation/media changes, restart, query binding and retention tests. |
| P1 | A crawler snapshot and an evaluation result could overwrite each other's full local collection. | Shared origin Web Lock, synchronous transformations of current storage, crawler record deltas, and a generation check after clear. | Both write orders, rejected writes, late responses and cross-context browser tests. |
| P1 | Plan refresh could erase a queued evaluation; evaluation enqueue could erase pending ingestion; late acknowledgements could overwrite a newer attempt. | Separate brief outbox lock, transforms of current queue state, attempt/fingerprint/execution matching and reset generation. | Deferred fetch/storage barriers reproduce the original losses and verify enqueue, retries, reset and migration interleavings. |
| P1 | Closing a dashboard during collection could leave other dashboards stuck in an active state. | Recover all interruptible states while holding the runner lease; recheck the stored run inside the storage lock. | Owner closure during collection plus existing pause/resume/cancellation flows. |
| P1 | Quota/blocked storage silently lost a draft on view navigation. | Subscribed session fallback, explicit unsaved warning and retry, deletion tombstones, exact submitted-version cleanup after publication. | Blocked storage, navigation, retry, publication after unmount and conflict tests. |
| P2 | Large catalogs fetched every rich page every five seconds and rendered every row/card. | Server pages of 50, all-catalog source facets and sorting, revision-based refresh, compact conditional map catalog, 30-row map sidebar pages. | Browser scale benchmark at 100/1,000/5,000, real API pagination and mobile flows. |
| P2 | Each completed evaluation item reparsed the entire prior result history. | Transactional per-result counter deltas, with migration/backfill and consistency checks. | Worker, retry, budget, cancellation, idempotency and scaling tests. |
| P2 | Run/execution selectors silently stopped after 100 records. | Explicit older-history controls, loaded/total counts, refresh and deep-link selection independent of page one. | Item 101, next-page errors, cached detail retention and old-ID tests. |
| P2 | Observer snapshots shared mutable nested data with the crawler and allocated a new collection for every tick. | Detached snapshots with structural sharing of unchanged records. | Nested mutation isolation; 1,000 ticks with 500 records retain one array identity. |
| P2 | Corrupt local drafts could crash the editor; reopening a version could overwrite an existing draft. | Runtime shape guards preserve corrupt raw storage, editing remains available in session, and opening a version resumes its draft. | Corrupt primitive/criteria entries, incomplete valid drafts and same-version reopening. |
| P2 | “Starting” lasted through an entire collection, and an empty queue could imply a successful synchronization. | Distinct starting/running/resuming/cancelling states, owner dashboard action, and sync wording backed by an actual successful sync. | UI unit tests and MV3 runtime flows. |
| P2 | Refetch/next-page errors could obscure cached results or imply an empty evaluation. | Cached-page continuity, actionable retries, fresh page-one invalidation on explicit refresh, and distinct waiting/error/empty states. | Fast refresh, expired cursor, detail failure and deferred-result tests. |
| P3 | Card ordering lacked controls and Builder tabs lacked standard keyboard behavior. | Card sort selector, source-filter URL state, visible page navigation, selected-detail retention, Arrow/Home/End tabs and live status feedback. | Keyboard, URL/history, desktop and mobile tests; token checks and visual inspection. |

## Catalog performance

The reproducible benchmark is `tests/benchmarks/catalog-ui.mjs`. It opens a local production preview, intercepts every API/media request and rejects external traffic. Fixtures include three small image responses per listing and approximately 2.4 kB of description text. Its numbers describe this controlled fixture, not real photo decoding, a Core Web Vitals percentile, or production latency.

| Catalog | Table DOM elements | Card DOM elements | Rich listing requests at start | Rich listing requests on unchanged five-second refresh | Longest observed initial task |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 892 | 1,130 | 1 | 0 | No task over 50 ms |
| 1,000 | 892 | 1,130 | 1 | 0 | No task over 50 ms |
| 5,000 | 892 | 1,130 | 1 | 0 | No task over 50 ms |

Each view rendered exactly 50 properties. Next-page interactions were 79–105 ms in this run. Initial fixture JSON was approximately 164 kB at all three sizes; unchanged refresh JSON was approximately 3.4 kB for health/selected detail, with metadata returning 304. Only visible/nearby images were requested. Chromium's approximate reported JS heap stayed around 10 MB; this is not a retained-heap leak analysis.

The earlier simple 5,000-row table rendered 95,179 DOM elements, fetched 50 listing pages and observed a 355 ms task. The new fixture is richer, so these are architectural scaling evidence rather than a tightly matched timing experiment. The map retains all matching points for coverage, geography and viewport filtering, but renders at most 30 sidebar rows; full evidence and galleries load on selection.

To reproduce the browser check:

```sh
VITE_API_BASE_URL=http://127.0.0.1:14310 pnpm --filter @denicheur-breizh/web build
node apps/web/node_modules/vite/bin/vite.js preview apps/web --host 127.0.0.1 --port 14173
# In another terminal:
node tests/benchmarks/catalog-ui.mjs
```

The map engine and geography remain lazy chunks. This pass does not claim their bundle sizes disappeared.

## Pagination and resource lifecycle

Listing metadata and the first compact map page accept `If-None-Match`. A 304 retains the previously validated complete catalog. Map refreshes commit only after the full traversal succeeds; expiration restarts once, and a mid-traversal failure preserves the prior complete catalog. Rich page-one results refresh when the catalog revision changes; older pages retain their immutable snapshot and offer an explicit refresh action. Periodic history polling pauses after loading multiple pages to avoid replaying the entire history every few seconds; focus, reconnect and manual refresh remain available.

Snapshot cursors are bound to their endpoint and filters. Legacy offset cursors return an explicit 410 restart response. SQLite owns revision changes for canonical listings, evaluations and media, and for runs/executions. Snapshots are private data in the existing database and are cleared with collected data. Admission, expiration and retention limits prevent unbounded snapshots; an over-budget query returns an error instead of truncating its results.

The snapshot freezes JSON rather than image binaries. Media garbage collection can remove an old replica before a snapshot expires; the existing photo component falls back to its source URL and then an honest unavailable-image state. Selecting a listing requests its current detail. Pinning old media would change collection budgets and is not implied by cursor stability. Snapshot row/byte policy limits govern retained snapshots; single-page listing/map responses also have endpoint and shared payload-cache caps, rather than a promise that every response uses the retained-snapshot limit.

The [API benchmark report](api-read-performance-2026-09-06.md) records the exact datasets, baseline extraction and SQLite/WAL sizes. At 5,000 rich listings, a warm 50-item page improved from 6.65 ms to 1.12 ms. Initial immutable projection construction cost 130.41 ms, while a new revision after 20 listing updates cost 32.30 ms; an unchanged compact map request took 0.05 ms. Snapshot construction still performs synchronous work proportional to matching catalog size. Shared versions avoid copying every description/gallery/evaluation for each revision or sort.

Completing 1,000 synthetic evaluation checkpoints improved from 1,546.65 ms to 116.58 ms. The median of the final ten checkpoints fell from 3.355 ms to 0.096 ms. These measurements exclude provider and media transfer time.

## Extension and editor states

[The extension lifecycle review](extension-lifecycle-review-2026-09-06.md) describes snapshot isolation, owner recovery, storage coordination and remaining runtime boundaries. Storage locks do not span network calls. A failed write does not advance the crawler's merge baseline. A missing lock capability fails visibly instead of pretending to provide cross-context exclusion.

Collection and outbox resets increment their generations and clear both in one storage write, with a fixed lock order. An acknowledgement updates only its matching attempt and cannot delete a newer fingerprint or restore a cleared entry. Identical concurrent evaluation enqueues deduplicate; other scopes remain distinct. The existing background scheduling is preserved.

Builder preserves an active draft across view navigation even when persistence fails. The warning explains that session-only changes cannot survive a page reload or closure. Remote changes to an actively edited draft require a choice; recovery after a remote deletion creates an independent key. Successful publication removes only the exact submitted draft and still performs cleanup after navigation.

Web Storage is not a transactional database. The conflict handling detects observed external changes; perfectly simultaneous read/merge/write operations in separate tabs are not guaranteed atomic. This is an explicit residual boundary, not a claim that arbitrary cross-tab writes are serialized.

## Access and release review

The new API routes remain behind the existing operator authentication middleware, including 304 responses. Existing CORS allows `If-None-Match`, exposes `ETag`, and preserves configured origins. API responses use `private, no-cache`; the frontend gateway retains its no-store behavior and credential stripping. No dependency, lockfile, Dockerfile, host permission, publication or deployment change is required by this patch.

A remote production dependency audit was attempted but did not run successfully. Automatic approval review rejected escalation because the command would transmit the dependency graph to an external registry. No advisories result is available, and this audit does not claim zero known dependency vulnerabilities. Completing that optional check requires explicit authorization for that disclosure.

## Validation and remaining boundaries

Final `pnpm check:all` passed:

- TypeScript across every package and the E2E suite; design-token checks.
- **810 unit/integration tests:** API 309, extension 332, web 128, contracts 21 and i18n 20. Two opt-in MinIO tests were skipped.
- Production API, web and MV3 builds, followed by isolated E2E builds.
- **44/44 Chromium E2E flows in 6.9 minutes**, including real service-worker/page lock coordination, owner closure, cancellation/CAPTCHA transitions, extension → API → web persistence, stable catalog traversal during writes, map pagination, and responsive 320/390/1024 px layouts.
- `git diff --check` and desktop/mobile visual inspection.

The first integrated rerun exposed ambiguous CAPTCHA selectors after the button-label change and a terminal-state assertion that read storage before its asynchronous acknowledgement. The final suite targets the status indicator, waits for the matching local snapshot and then verifies that exact snapshot in the API. Failed fixtures preserve their original evidence and cancel only their own crawler to avoid contaminating later tests; they do not force synchronization or reset the shared test API.

The deterministic suite covers native-site fixtures, real Chromium MV3 contexts, a memory-only API database and the web app. Live Leboncoin DOM/anti-bot changes, real OpenAI execution, real MinIO storage, deployment behavior and production traffic remain outside that evidence. Existing opt-in integration/live tests are available for those environments. No claim of universal performance or production readiness follows from local fixtures alone.
