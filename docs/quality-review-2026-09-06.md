# UX, performance and code review — 2026-09-06

Reviewed local `main` at `781710c`, then implemented the improvements below. Scope: web workspace, MV3 dashboard/popup, listing API and the deterministic browser suite. This is a local quality pass; provider-backed evaluation, current live Leboncoin extraction and deployment are separate validation surfaces.

## Changes delivered

| Area | Problem | Result |
| --- | --- | --- |
| Property sorting | Descending price/surface/score order brought missing values to the top. | Unknown values remain last in both directions; zero is still a valid value. |
| Property loading | A background failure hid cached results; failed detail requests silently showed partial summaries. | Existing cards/table stay usable, with localized failure notices and targeted retry. |
| Recipe editor | Changing a criterion ID changed its React key and lost keyboard focus on each keystroke. | Stable editor identity preserves focus while typing and preserves remaining rows after deletion. |
| Connection status | Cached successful health data kept the header connected after requests failed. | The indicator reflects current failure and subsequent recovery. |
| Evaluation setup | Failed run details also claimed there were no detailed snapshots. | Unavailable and empty states are distinct, with a retry for unavailable details. |
| Map | Asynchronous map startup failures had no recovery; filters disappeared on navigation/reload. | Localized startup error and retry, a fresh canvas container per attempt, loading state, and URL-backed source/type filters. |
| Extension updates | Every progress/sync notification loaded and migrated the full stored collection. | Reads are limited to changed fields; latest requests own both their data and error state. |
| Popup actions | Synchronization/navigation failures could be invisible. | Explicit recoverable errors and pending states; refresh failure keeps the last progress visible. |
| Extension settings | Background configuration refreshes and pending saves could erase edits. | Hydration/save guards preserve dirty URL/token drafts, expose external-update conflicts and keep edits after failed writes. |
| Listing API | A full page prepared one evaluation and one media query per property. | Related data is batched within the requested page, preserving gallery order, shared assets and detailed response contracts. |
| Evaluation consistency | Decision filters broke ties differently from listing cards/details. | One deterministic latest-evaluation ordering is used across these reads. |
| Browser test lifecycle | A test could close its MV3 context before the terminal snapshot reached the API. | Runtime tests wait for matching terminal status/counts in the API; broken automatic sync fails its owning test. |

UX review included keyboard/focus, accessible loading/error messages, cached-data continuity and responsive navigation, using the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) as a reference and the existing design system.

## Measured performance

Synthetic SQLite in memory: 1,000 listings with evaluation data and two media URLs each, page size 100, 30 warmups followed by 100 reads. No real database or provider requests.

| Measurement | Before | After |
| --- | ---: | ---: |
| Prepared SQL statements per page | 202 | 4 |
| Median repository read | 5.97 ms | 2.90 ms |
| p95 repository read | 7.79 ms | 3.60 ms |

These are paired local measurements, not production latency or whole-page timings. A second run under concurrent test load measured 3.34 ms median and 4.54 ms p95. The SQL-call reduction is covered by a regression test; timing is intentionally not a pass/fail assertion. The batched SQL still performs indexed latest-evaluation lookups inside SQLite.

Reproduce from the repository root:

```sh
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/listingReads.ts
```

Run-only storage notifications now perform one read in the dashboard (previously three) and popup (previously two), without reading or migrating records. Sync-only popup updates also need one read. Record updates still migrate records, and the active crawler still clones its record collection during progress notifications.

The map engine was already lazy-loaded. Its roughly 1,053 kB raw / 285 kB gzip chunk is not part of non-map navigation. The map feature/geometry chunk is roughly 473 kB raw / 145 kB gzip. This pass does not claim a bundle-size reduction.

A separate synthetic Chromium pass rendered the property table with intercepted listing responses and no database writes:

| Catalog size | Listing page requests on load | DOM elements | Longest observed main-thread task |
| ---: | ---: | ---: | ---: |
| 100 | 1 | 2,079 | None over 50 ms |
| 1,000 | 10 | 19,179 | 73 ms |
| 5,000 | 50 | 95,179 | 355 ms |

This is one diagnostic pass with simple records and no property photos/evaluations, not a Core Web Vitals score or percentile. It confirms that rendering grows with the entire catalog and makes windowing a concrete next optimization. Desktop table layout was visually inspected from this run.

## Next priorities

These were the remaining priorities at commit `bb70a16`. All four are implemented in the [expanded audit and validation pass](quality-audit-2026-09-06.md); the list below preserves the original findings and acceptance scope.

1. **Bound rendering and refresh work for large catalogs.** `apps/web/src/api/denicheurApi.ts:listAllProperties` fetches every page; Properties and map result lists render every matching item. The table profile above already shows 95,179 DOM elements at 5,000 records. Add windowing or explicit pagination while preserving complete filtering, sorting, selection and keyboard access; extend the profile to images, filter/sort interactions, memory and refresh payloads. Do not silently cap results at 100. Run/execution history currently reads only its first 100-item page and also needs explicit pagination.
2. **Keep cursor traversal stable during writes.** Canonical listing, run and execution pagination uses `OFFSET`. Inserts or sort-field changes between pages can repeat or skip rows; client deduplication removes duplicates but cannot recover skipped rows. Define a snapshot/keyset contract and test concurrent insertion/update traversal before changing the shared API contract.
3. **Aggregate evaluation counters without reparsing history.** `repository.ts:refreshEvaluationExecutionCounters` loads and parses all completed results after each item. Profile a large completed execution, then maintain or query counters transactionally while retaining retry/cancel/budget consistency.
4. **Make draft persistence failures visible.** `builderModel.ts:persistWorkingDraft` silently catches unavailable/quota-exceeded storage. The editor remains usable, but leaving the view can lose its in-memory draft. Return persistence status and preserve a session fallback; verify blocked storage and quota failures explicitly.

Avoid extracting files merely to reduce line counts. Useful future boundaries are repository listing-read helpers, crawler progress subscriptions and editor state ownership; extract them alongside concrete changes and contract tests.

## Validation

Final `pnpm check:all` passed:

- TypeScript across all packages and E2E tests; design-token checks.
- 720 unit/integration tests passed: API 278, extension 297, web 104, contracts 21, i18n 20. Two opt-in MinIO tests were skipped.
- Production API, web and Chrome MV3 builds; isolated E2E builds.
- 41/41 Chromium E2E flows passed in 6.8 minutes, including 320/390/1024 px responsive checks and the new map-recovery flow.
- `git diff --check` passed.

The initial fresh browser baseline passed 39/40 and exposed the MV3 teardown synchronization gap described above; the final complete run includes the corrected teardown barrier. An earlier forced run refreshed all workspace validation caches, and changed web sources were checked again in the final pass.

Regression coverage includes sorting with absent/null/zero values; list/detail recovery; criterion typing and deletion; connection recovery; map startup/retry/filter persistence; stale storage responses; maximum-size galleries; missing/shared assets; deterministic evaluation ties; responsive 320/390/1024 px flows; and MV3 → API → web synchronization using synthetic site fixtures.

Validation did not reset real user data or call OpenAI. No push or deployment was performed.
