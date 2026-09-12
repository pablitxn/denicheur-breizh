# Isolated extension reference

Use the existing extension as an independent reference for the collector laboratory. The helper starts its own API, SQLite database and browser profile. It never starts a search automatically, and it never marks an export as complete.

```sh
node scripts/collector-reference.mjs
```

The command builds an isolated extension into `apps/extension/.output-collector-reference/chrome-mv3`, opens its dashboard in a fresh bundled Chromium profile, and watches its crawler storage. Keep the terminal open during captures. Press Ctrl+C when finished; the helper closes its own browser/API and retains the evidence.

For a readiness check without visiting a source site:

```sh
node scripts/collector-reference.mjs --smoke --headless
```

Use `--skip-build` after the first build if extension source has not changed. A full build is needed after changing the extension or its shared dependencies. The helper does not edit extension source, its ordinary build output or the existing API source.

## Isolation

Each invocation creates `.data/collector-reference/<timestamp-id>/` with:

| Path | Purpose |
|---|---|
| `profile/` | Fresh Chromium profile; no existing browser cookies or extension storage. |
| `reference.sqlite` | Database owned exclusively by the API at `http://127.0.0.1:4316`. |
| `exports/<run-id>.json` | Latest observation of each reference capture, updated atomically. |
| `exports/<run-id>-<status>-<hash>.json` | Immutable snapshot after completed, failed, cancelled or blocked captures. |
| `latest.json` | Most recently observed run and its export path. |
| `session.json` | Ports, paths, dashboard URL and explicit isolation configuration. |
| `api.log` | Operational logs from this session's API. |
| `dashboard-ready.png` | Dashboard readiness screenshot taken before any capture starts. |

The API is launched directly with `node --import tsx src/server.ts`, without the development command's dotenv loading. Its environment is allowlisted, excludes provider keys, uses a session-specific database path, and disables media storage and OpenAI Realtime. Startup checks require `openAiConfigured=false`, `media.status=disabled` and a ready database.

The extension's compiled default and isolated Chrome storage point to port 4316. Its recipe is disabled and it has no evaluation plan or operator credential. The generated manifest adds declarative network rules that block other local API ports, the productive API host and AI provider endpoints. These rules also apply to extension service-worker requests. Enabling intelligence or changing the runtime API endpoint causes the helper to stop the isolated session.

Ports 4316 and 4317 must be unused; the helper refuses to attach to existing services. CDP at `http://127.0.0.1:4317` exists only for automation of this fresh profile. Close the helper when finished. The usual Chrome profile, API at 4310, collector API at 4315 and ordinary catalog database are not opened or modified.

## Collect and preserve a reference

1. Configure the search in the isolated extension dashboard. Match the provider experiments' category, location, property types, price/surface bounds, seller and ordering.
2. Enable detail-page capture if the reference will evaluate listing details. Keep intelligence disabled.
3. Run the extension normally. Use this browser for any source-site interaction. The helper records observed search-page navigation and exports crawler records whenever storage changes, with a polling backup.
4. Inspect the terminal's saved-run message and the files under `exports/`. Records are grouped by their original `searchRunId`; incremental observations are merged inside that run before export. Starting another capture cannot overwrite the previous run's file.
5. Import the JSON in Capture Lab → Evaluation → Import reference. The importer preserves the search metadata and translates extension records. Keep the original file for its `referenceAudit`, raw filter settings and observed-run metadata.

The helper only reads a whitelist of crawler state keys. It does not export cookies, credentials, unrelated extension storage or the user's normal browser profile. Reference observations remain local and are never sent to xAI or Firecrawl as prompts or fallback results.

## Attest completeness separately

Every automated export contains `complete: false`. The extension's `completed` status means its requested work finished; it does not prove that all native search results were reached.

Before checking “All search pages have been verified” on import:

- Compare listing identities, not only result counts, with the native search.
- Check all pages and the real end of pagination during the recorded observation window.
- Check the extension's 100-listing run limit and 500-record storage retention limit. Reaching a cap cannot establish completeness.
- For larger searches, capture disjoint/exhaustive partitions, preserve every export and deduplicate identities when building a combined reference. Keep the partition criteria and their coverage evidence in the notes.
- Reconcile listings added, removed or modified during the comparison. Reimport a reconciled reference when necessary; a review does not silently erase raw metric differences.
- Distinguish source-absent fields from fields the extension failed to extract. An absent key alone is not evidence that the source omitted the field.

The helper deliberately does not infer exhaustion, fabricate absent fields, or modify the extension's limits. A blocked or partial reference is useful evidence, but cannot certify 100% provider coverage.
