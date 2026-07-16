# Leboncoin 70-listing live smoke

This is a live, visual acceptance run for native search, pagination, sequential
detail extraction, cooldown batches, and local persistence. It is not a load
test and must stop immediately on CAPTCHA, DataDome, temporary restriction, or
unusual-activity evidence.

## Preconditions

- Build and reload the already-installed unpacked extension.
- Keep the dashboard tab open for the whole run. Reloading or closing it cancels
  the dashboard-owned runner; the crawl does not resume from a cursor.
- Do not pre-open or manually navigate any Leboncoin tab.
- Use Computer Use only for Chrome. Read the complete Chrome state first, prefer
  accessible controls, and re-read state after every action.

## Configuration

- Mode: `Vente`
- Location: `Finistère`
- Types: `Maison` and `Appartement`
- Price max: `250000`
- Other ranges: empty
- Sort: `Recent`
- Max listings: `70`
- Collect detail pages: enabled
- Delay min/max: `25` / `55` seconds
- Pause every: `5`
- Cooldown: `180` seconds
- Intelligence filter: disabled

Verify every visible value before pressing **Start crawl** exactly once. After
that click, Computer may only observe. The extension owns all Leboncoin tab
creation, navigation, focus, pagination, and successful-detail closure.

With these pacing values, 70 details normally require roughly 80–120 minutes.
Do not reload the dashboard while waiting.

## Acceptance

The smoke passes only when all of the following are visibly verified:

- status is `completed`;
- `Found` is at least `70`;
- `Detailed` is at least `70`;
- `Pages` is greater than `1`;
- `Stored` contains at least 70 records from the run;
- no CAPTCHA or blocked-activity state appeared;
- successful detail tabs were closed and the dashboard regained focus.

`completed` by itself is not sufficient. Report only status, visible metrics,
warnings, and visible records/logs. Do not claim storage, service-worker, or DOM
inspection unless Computer provided that evidence directly.
