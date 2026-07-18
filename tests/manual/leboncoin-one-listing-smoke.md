# Leboncoin one-listing Computer Use smoke test

This procedure visually validates the installed Denicheur Breizh product from
native capture through the local API and the web app, without attempting to
bypass Leboncoin, DataDome, a captcha, or an unusual-activity restriction. It is
not a replacement for the deterministic Playwright suite.

## Preconditions

1. Build the product before starting the Chrome smoke:

   ```bash
   pnpm build
   ```

2. Start `apps/api` and `apps/web` locally with `pnpm dev`. Confirm the web
   connection indicator reports the API and SQLite ready before visiting
   Leboncoin. Keep both processes running for the entire smoke.
3. In the web **Atelier**, save and activate the recipe intended for this run.
   In the extension dashboard, refresh the active recipe and verify the same
   recipe id and version are shown.
4. Use only the Computer Use skill to operate `com.google.Chrome`; do not open
   the extension dashboard with Browser.
5. If the current production build is already installed, Computer Use may bring
   its dashboard to the foreground or reload it. If a new unpacked build must
   be loaded, ask the user for confirmation immediately before doing so, then
   select only `apps/extension/.output/chrome-mv3`.
6. Do not pre-open a Leboncoin search or detail page. Keep any unrelated Chrome
   tabs outside the smoke untouched.
7. OpenAI is optional for the capture-to-web proof. If evaluation fails, record
   the visible error and continue verifying that the listing was persisted.

## Computer Use operating discipline

- The first Chrome action is to read its complete current state.
- Prefer accessibility elements over coordinates. Use a screenshot only when
  the accessibility tree is insufficient.
- Read the current state again after every action; never reuse stale element
  indices or inspect tabs outside this smoke.
- Computer Use may configure and start the dashboard, but after the run starts
  it only observes. It must not construct, navigate, activate, reload, close,
  or otherwise interact with a Leboncoin tab.

The extension owns the run's tabs. It creates and focuses a new
`https://www.leboncoin.fr/` tab, may accept one unambiguous cookie banner,
completes the native search, applies results-page filters, and opens at most one
detail tab at a time. A successfully extracted detail tab is temporary; the
search tab remains open. Existing Leboncoin tabs are not reused or changed.

## Single permitted run

Configure these visible dashboard controls:

- Transaction: `Vente`.
- Location: `Finistère`.
- Property type: `Maison`.
- Price maximum: `120000`.
- Rooms minimum: `2`.
- Rooms maximum: `3`.
- `Max listings`: `1`.
- `Collect detail pages`: enabled.
- `Delay min sec`: `25`.
- `Delay max sec`: `55`.
- `Intelligence filter`: enabled only when the local API has OpenAI configured.

Verify every value visually, then click **Start collection** exactly once. Do not
interact with any Leboncoin tab while the extension runs. The extension uses
bounded action and typing delays plus the configured detail delay; this reduces
request rate but does not guarantee that Leboncoin will allow the run.

An optional result-page filter that is unavailable may appear as a dashboard
warning while the crawl continues. Record the visible field and message; do not
try to compensate by editing the Leboncoin page manually.

## Captcha and restriction handling

If the run enters `paused-captcha`, stop Computer Use immediately and preserve
the focused tab. Computer Use must not solve the captcha or click **Resume**.
The user may solve it manually; only then may the user return to the dashboard
and explicitly click **Resume** once. The extension revalidates the same tab and
pauses again if the captcha remains.

If the run enters terminal `blocked-activity` for DataDome, a temporary
restriction, unusual activity, or another access interstitial, stop immediately:

- do not reload or retry;
- do not open another URL, listing, profile, browser, or network;
- do not clear cookies, rotate IP addresses, disable protections, or attempt
  another workaround;
- leave the affected tab unchanged for manual review.

## Synchronization and visual acceptance

On an unrestricted successful run:

1. Verify the extension dashboard shows the final run state, found/detailed/
   stored counts, the captured external id, listing URL, and any warning.
2. Use **Synchroniser maintenant** / **Sincronizar ahora** / **Sync now** and
   wait until the persistent queue reports no pending batch.
3. Open the web app's **Biens** view. Wait for its five-second refresh or reload
   it once. Locate the listing by `leboncoin:<externalId>`.
4. Verify the web view shows exactly the same external id and listing URL as the
   extension, plus the fields that were visibly captured. Missing fields must
   say `Non disponible`, `No disponible`, or `Not available`; they must not be
   displayed as zero.
5. Restart the local API and web processes, return to **Biens**, and verify the
   same listing remains present. Do not clear the extension buffer as part of
   this check.

Record:

- final run state;
- found, detailed, and stored counts;
- pending synchronization count after the explicit sync;
- recipe id and version shown by Atelier and the extension;
- the exact `source + externalId` and listing URL shown by both surfaces;
- the observed search URL, if displayed;
- optional filter warnings;
- evaluation state, including an honest OpenAI failure if one occurred.

Report only those visually verified values. Do not claim to have inspected
the SQLite file, `chrome.storage`, the service worker, the page DOM, or internal
messages unless Computer Use displayed direct evidence of them. A synthetic
fixture or a green Playwright run must remain clearly distinguished from this
live-site smoke.
