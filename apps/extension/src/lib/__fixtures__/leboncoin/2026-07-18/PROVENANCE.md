# Sanitized coordinate-state fixture provenance

- Capture date: 2026-07-18.
- Page kind: one real Leboncoin listing detail already open in the user's existing Chrome session.
- Challenge state: the page showed neither a captcha nor a temporary-access restriction.
- Inspection boundary: the already-loaded `script#__NEXT_DATA__` value was inspected without network requests or additional page navigation.
- Observed path: `props.pageProps.ad.location`.
- Observed precision fields: `source`, `type`, and `origin_type` were `city`; `provider` was `here`; `is_shape` was `true`; the embedded feature type was `Point`.
- Precision decision: this is source-provided locality evidence, not a verified property position.
- Deterministic replacements: listing identity and content were removed; city, postcode, latitude, and longitude were replaced with neutral valid fixture values. Structural field names and precision markers were retained.
- Removed content: every other application-state branch, account value, token, image, description, and unrelated page field.
