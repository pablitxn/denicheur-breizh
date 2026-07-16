# Real-DOM fixture sanitization contract

The regression fixtures in this directory must come from a Leboncoin results
page and detail page that the user opened manually and could already view
without a captcha or temporary restriction. A blocked interstitial is evidence
for stop behavior, not a substitute for either required fixture.

## Capture boundary

- Capture once from an already-open, working Chrome tab.
- Do not navigate, reload, scroll automatically, enumerate additional ads, or
  trigger lazy network requests during capture.
- Keep only the smallest DOM roots needed for the visible results cards or the
  visible listing detail.
- Preserve element order, semantic elements, accessibility attributes,
  `data-*` selector hooks, `loading`, `srcset`, and lazy-image attributes that
  influence extraction.
- Before removing CSS, remove every branch that computed visibility marks as
  hidden or inactive at capture time (including responsive alternatives), and
  record that visibility pruning in provenance. This keeps the fixture's text
  equivalent to the visible DOM rather than making hidden text visible.
- Then remove scripts, styles, inline event handlers, iframes, forms, contact
  controls, tracking pixels, application state payloads, and unrelated page
  chrome.

## Deterministic replacements

Apply each replacement consistently across HTML and expected output:

- listing IDs and URL paths → deterministic numeric fixture IDs;
- query strings, fragments, tracking parameters and opaque tokens → removed;
- seller/account names → neutral fixture names;
- precise address, commune and postal code → neutral fixture location;
- title and description → neutral French fixture copy with the same field
  presence and broadly similar length, while preserving every
  extractor-sensitive token class, order and polarity (property type, rooms,
  surfaces, DPE/GES, feature words and their negations);
- image URLs → `https://fixtures.invalid/leboncoin/fixture-*.jpg` while retaining
  `src`, `srcset`, `data-src` and `data-srcset` placement;
- publication date/time → deterministic French fixture text in the same visible
  format;
- prices and surfaces → deterministic values that preserve the observed French
  separators and decimal notation;
- phone numbers, email addresses, IP addresses and restriction IDs → removed.

Do not add a field, label, selector or value that was absent in the captured
DOM. Missing scalar fields remain absent and must extract as `undefined`.
Regression tests must stub or abort the reserved fixture-image host; fixtures
must never contact Leboncoin or any external image CDN.

## Required artifacts

The eventual dated directory must contain:

```text
YYYY-MM-DD/
  search-results.sanitized.html
  listing-detail.sanitized.html
  expected.json
  PROVENANCE.md
```

`PROVENANCE.md` records only non-sensitive facts: capture date, browser locale,
page kind, whether a sponsored duplicate was present, which fields were visibly
present or absent, and the deterministic replacement map categories. It must
not retain the original URL, listing ID, seller, address, description, images,
IP address, cookies, tokens, or challenge identifier.

`expected.json` is compared field by field. It includes explicit `null` markers
only as fixture metadata for values expected to be `undefined` in TypeScript;
the extractor itself must never convert those markers into stored values.
