# Leboncoin one-listing Computer Use smoke test

This procedure visually validates the installed Denicheur Breizh extension's
native-search flow without attempting to bypass Leboncoin, DataDome, a captcha,
or an unusual-activity restriction. It is a smoke test of the installed
extension, not a replacement for the deterministic Playwright suite.

## Preconditions

1. Build the extension before starting the Chrome smoke:

   ```bash
   pnpm --filter @denicheur-breizh/extension build
   ```

2. Use only the Computer Use skill to operate `com.google.Chrome`; do not open
   the extension dashboard with Browser.
3. If the current production build is already installed, Computer Use may bring
   its dashboard to the foreground or reload it. If a new unpacked build must
   be loaded, ask the user for confirmation immediately before doing so, then
   select only `apps/extension/.output/chrome-mv3`.
4. Do not pre-open a Leboncoin search or detail page. Keep any unrelated Chrome
   tabs outside the smoke untouched.
5. Keep the intelligence filter disabled. Intelligence is evaluated only by
   the local backend and is not part of this smoke.

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
- `Intelligence filter`: disabled.

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

## Visual acceptance and report

On an unrestricted successful run, verify only what is visible in the
dashboard:

- final run state;
- found, detailed, and stored counts;
- the observed search URL, if displayed;
- optional filter warnings;
- visible run records or logs.

Report only those visually verified values. Do not claim to have inspected
`chrome.storage`, the service worker, the page DOM, or internal messages unless
Computer Use displayed direct evidence of them. A synthetic fixture or a green
Playwright run must remain clearly distinguished from this live-site smoke.
