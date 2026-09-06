# Extension lifecycle and performance review — 2026-09-06

Scope: extension dashboard, popup, crawler owner lifecycle and local crawler/evaluation persistence. Baseline: `bb70a16`. Synthetic tests only; no live collection, real-data reset or deployment. Existing WXT/React architecture, design tokens and FR/ES/EN interface remain in place.

## Confirmed issues addressed

| Priority | Trigger and impact | Change | Evidence |
| --- | --- | --- | --- |
| P1 | A crawler starts with historical records; a background evaluation updates those records; the next capture writes its older full collection. Either interleaving could discard an evaluation or a new capture. | Shared exclusive `denicheur:crawler:state` Web Lock covers read/transform/write. Evaluation transforms current records; crawler applies only its changes against its last acknowledged baseline. | `src/storage/chromeStorage.ts:168`, `src/sync/syncService.ts:434`; storage tests exercise both write orders, delayed storage acknowledgement, and actual evaluation responses arriving after capture. |
| P1 | A response captured before clear arrives afterward and could restore old data/run state. | Clear increments a persisted generation in the same locked write. Every crawler write checks its starting generation. Evaluation transforms current matching records/run and cannot recreate cleared entries. | `src/storage/chromeStorage.ts:246`; stale-generation and delayed-evaluation tests. UI reloads stored run/records after a rejected optimistic write. |
| P1 | A plan refresh reads outbox state, an evaluation is appended while the recipe is saving, then the refresh overwrites the queue. Conversely, evaluation enqueue reads state before loading its plan and can discard ingestion appended in the meantime. Both cases were reproduced with failing deterministic tests. | Short exclusive `denicheur:sync:state` transactions transform current storage. Cache refresh changes only its cache fields; enqueue validates, deduplicates and computes its job against current state. Ingestion/evaluation responses update only the matching current job/attempt. | `src/sync/storage.ts:37`, `src/sync/syncService.ts:68`, `:79`, `:227`, `:494`; both original regression assertions now pass. Controller scheduling remains unchanged. |
| P1 | Another dashboard closes while collecting, configuring, evaluating or waiting for CAPTCHA; observers can remain disabled indefinitely. A query-then-save recovery can race a replacement owner. | Recovery waits for the exclusive runner lease and keeps it through read and persistence. It checks expected run ID and cancellation before writing. All active states recover to interrupted/cancelled after ownership ends. | `src/ui/DashboardApp.tsx:1395`; six active-state cases, replacement/terminal cases and aborted observer test. `tests/e2e/extension/state-coordination.spec.ts` covers owner-tab closure. |
| P2 | Every progress update allocated a records array and shared nested mutable records with observers. UI work scaled with collection size even when only progress changed. | Frozen detached snapshots cache the collection and reuse unchanged record snapshots. Dashboard updates its records only when the observer collection changes; listing cards are memoized. Background evaluation updates therefore survive later progress-only ticks. | `src/automation/runnerSnapshot.ts:14`; 1,000 progress ticks with 500 records produce **one records-array identity**. Replacing one record retains the other record identities. Nested mutation attempts throw and cannot alter runner data. This measures allocations/identity, not wall-clock speed. |
| P2 | Cancellation can arrive during a tab read, followed by creation/navigation of another tab. | Check cancellation again after asynchronous tab reads and before creation/navigation. Persist owning dashboard ID for navigation. | `src/automation/scrapeRunner.ts`; deterministic cancellation during `getCurrent` leaves created, updated and removed tab lists empty. |
| P2 | Start shows “Starting…” throughout a live run; a second dashboard offers controls it cannot own; popup may open a different dashboard; empty sync history claims success. | Live/paused labels, pending cancel/resume states, foreign-owner explanation and “Open active dashboard”; popup prefers verified owner tab. No-sync-history has a neutral explicit label; mixed queue counts say tasks. | Dashboard and popup tests plus translated message catalog. Native fixture runtime assertions updated to “Collection in progress.” |

Paths beginning `src/` above are relative to `apps/extension/`.

## Concurrency boundaries

- Chrome storage has no compare-and-swap here. Cross-context exclusion uses real Web Locks in the extension origin, shared by the dashboard and service worker. The new browser test explicitly verifies worker-held lock exclusion in the dashboard and release afterward.
- The new lock covers crawler records/run/filter migrations and their writers. Locked helpers call internal unlocked helpers; no recursive acquisition. Network requests execute outside the lock. Storage acknowledgement completes before the lock is released or the crawler baseline advances.
- Without Web Locks, coordinated reads requiring migration and writes fail explicitly before changing data. There is no process-local fallback pretending to protect other contexts. Unit tests verify stored data remains intact.
- This is not a universal transaction wrapper for arbitrary `chrome.storage` access. Future crawler and outbox writers must use the respective helpers. The outbox now has a separate short storage lock; no network fetch or crawler read runs inside it. Controller scheduling remains unchanged.
- Coordinated reset acquires crawler then outbox locks and increments both generations while clearing both datasets in one storage write. Other operations release each lock before obtaining the other. Legacy outbox migration uses an internal unlocked reader while retaining its lock. Late pre-reset reconcile/enqueue/response work cannot restore queue entries, acknowledgements or errors.
- A closed/reloaded runner is intentionally marked interrupted; browser navigation and CAPTCHA execution do not silently resume after the owning JavaScript context is gone.

## Validation recorded by this pass

- Entire extension suite after the outbox corrections: **22 files / 332 tests passed**.
- Extension TypeScript and E2E TypeScript checks passed.
- Additional persistence regression verifies a rejected write does not advance the baseline and a later retry still includes the record delta.
- `git diff --check` passed.
- Final integration rebuilt the extension with the outbox corrections and passed **44/44 Chromium E2E flows in 6.9 minutes**, including both state-coordination tests for the real worker/page state lock and collecting-owner closure, plus cancellation, CAPTCHA, ingestion and web persistence.
- Runtime teardown now waits for the terminal snapshot's local storage acknowledgement before checking the matching API state. CAPTCHA assertions target the banner indicator separately from the disabled action button. A failed fixture preserves its screenshot and cancels only its own crawler before the same automatic synchronization check; the original failure remains visible.

Outbox regression coverage uses controlled storage callbacks and deferred synthetic fetch responses, not timing sleeps:

- Plan refresh overlaps evaluation append, and evaluation plan read overlaps collection reconciliation; neither queue loses entries.
- An ingestion fetch remains pending while evaluation is appended and the collection changes. The old acknowledgement cannot delete the newer fingerprint; both ingestion requests finish and the evaluation stays queued.
- Ingestion success/failure and evaluation response arrive after coordinated reset; cleared state remains intact.
- Older ingestion/evaluation responses cannot overwrite newer attempts. Concurrent identical evaluations deduplicate, while another locale/scope is preserved.
- Evaluation enqueue started before reset is rejected after its delayed plan read. A legacy outbox migration overlapping reset completes without deadlock or old-queue resurrection.
- An unavailable Web Locks capability causes an explicit failure while retaining stored outbox data.

## Remaining bounded opportunities

1. **P2 — collection read/write cost.** `src/storage/chromeStorage.ts:109` still migrates all records and serializes old/new values for comparison; `:240` normalizes the full record payload on writes. These costs now sit inside a correctness lock and remain bounded by the existing 500-record retention. Profile real payload size and lock duration before adding a storage version marker or moving to per-record persistence. Progress-only reads already avoid the collection.
2. **P3 — locale and external-site coverage.** New interface text has FR/ES/EN entries and catalog validation; browser ownership fixtures use English. Live Leboncoin DOM and real CAPTCHA behavior were not exercised or bypassed. Existing fixture coverage remains the evidence boundary.
