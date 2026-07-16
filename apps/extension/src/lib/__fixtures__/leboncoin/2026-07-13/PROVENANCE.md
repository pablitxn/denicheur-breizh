# Sanitized real-DOM fixture provenance

- Capture date: 2026-07-13.
- Browser locale: not captured; the page declared French content. The session timezone was Europe/Paris.
- Page kinds: one real results page and two real details opened from visible first-result links. The second detail contributes a focused diagnostic-scale snapshot.
- Challenge state: neither page showed a captcha, DataDome interstitial, or temporary-access restriction.
- Navigation: the results page was opened from a visible recent-search control; the detail was opened from the first visible result. No crafted listing URL, reload, automatic scroll, retry, or challenge interaction was used.
- Results observations: the primary list contained repeated visible links for the same listing, an ad placeholder, and a separate professional carousel inside `main`. The accessibility snapshot exposed `Sponsorisé` inside the placeholder, but direct computed-style inspection reported that label branch as `visibility: hidden`; it was therefore pruned while the empty outer `li[role="none"]` sentinel was retained. No sponsored/organic duplicate of the same listing was observed.
- Detail fields visibly present: URL/ID, title, total price, price per square metre, property type, rooms, bedrooms, living surface, land surface, location including neighbourhood, seller name/type, publication date/time, description, two gallery images, and `Jardin`.
- Detail fields visibly absent: DPE and GES grades. They remain `undefined`; no grade was introduced during sanitization.
- Second-detail diagnostic observation: the visible A–G scales selected DPE `B` and GES `A` using the bordered, shadowed grade element. The focused sanitized fixture preserves that current selected-state structure and removes all unrelated content.
- Visibility pruning: hidden responsive branches were removed before styles and scripts. The retained real lazy-loading attributes belong only to excluded carousel/recommendation images; positive lazy-image extraction remains covered by the synthetic extractor regression.
- Removed content: scripts, styles, iframes, forms, contact/favourite controls, tracking pixels, seller registration number, account activity, application state, unrelated page chrome, and unrelated listings beyond one professional-carousel and one similar-listing exclusion sentinel.
- Deterministic replacements: listing IDs/paths, search URL details, seller/account name, location/address, title, description, prices, surfaces, publication date/time, reference, and every image URL.
- Reserved image host: all fixture images use `https://fixtures.invalid/`; tests never request them.
