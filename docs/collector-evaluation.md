# Collector evaluation

The evaluator compares each provider independently against an attested reference snapshot. It never supplies reference IDs or extension results to a provider. A successful API request, a provider's assertion of exhaustion, or matching result counts alone does not establish complete capture.

## Preparing a reference

The importer accepts an unmodified array of extension records or this envelope:

```json
{
  "name": "Quimper sale — complete native search",
  "source": "leboncoin",
  "searchUrl": "https://www.leboncoin.fr/recherche?category=9&locations=Quimper",
  "capturedAt": "2026-09-12T12:00:00.000Z",
  "complete": true,
  "pages": [
    "https://www.leboncoin.fr/recherche?category=9&locations=Quimper"
  ],
  "notes": "All pages reviewed. Native search exhausted; listing IDs reconciled during the observation window.",
  "requiredFields": ["title", "priceEuros", "propertyType", "location", "surfaceM2"],
  "records": [
    {
      "id": "1234567890",
      "source": "leboncoin",
      "listingUrl": "https://www.leboncoin.fr/ad/ventes_immobilieres/1234567890",
      "status": "detailed",
      "title": "Example only — replace with actual captured data",
      "priceEuros": 250000,
      "propertyType": "maison",
      "location": "Quimper",
      "surfaceM2": 100,
      "rawTextSample": "Replace with actual observed source evidence."
    }
  ]
}
```

The example is illustrative and must not be used as live evidence. List every native page or reference partition actually inspected. Provide the actual capture timestamp and describe the exhaustion check and any reconciled changes. An optional `filters` object must use the same collector filters as the evaluated run; mismatched filters make the comparison inconclusive even when the URLs match.

The extension limits still apply while producing its export. Reaching 100 results or its retained-record limit does not prove exhaustion. Export each reference capture promptly. When partitioning is necessary, document that the partitions collectively cover the original search, union their IDs and reconcile overlaps before marking the reference complete.

The collector now treats a captured detail as a complete account of the source's requested fields: each has a value or an explicit, observed source-absence assertion. Missing fields, invalid DPE/GES labels and warning-confirmed collapsed descriptions trigger one targeted detail request through the same provider. If that request remains incomplete, the listing and run stay partial; another attempt requires explicit resume. Resume also audits historical captures whose old `captured` status concealed gaps. Earlier raw responses and evidence remain available.

A newer complete detail replaces the stored data snapshot, including galleries, features and explicitly absent fields. It does not union recommendation images or obsolete values into the current result. A later partial card or failed request preserves the last complete snapshot and its timestamp while retaining the new evidence.

For captures made before these quality checks, run `pnpm --filter @denicheur-breizh/collector-api cli reprocess RUN_ID` after the execution has stopped. The corresponding endpoint is `POST /v1/runs/:id/reprocess` with an empty JSON object. This operation reads only that execution's recorded `step_result` artifacts, validates existing listing identities, provider provenance, detail fields and listing evidence, and repairs snapshots using the latest valid recorded detail. It never contacts a provider or changes billing. Running, queued or remotely pending executions must finish or be resolved first.

The replay also checks associated Firecrawl Scrape markdown by listing URL and response order. A collapsed Description disclosure disproves a complete-description claim even when the model's JSON text has no ellipsis. If no earlier complete detail exists, the listing is marked failed with the affected missing field. An earlier complete snapshot remains usable when a later request was partial. Original artifacts, snapshots before repair and the replay audit remain in exports. The original observation timestamp is retained when present in the response artifact; older responses use their immutable artifact receipt time, not the replay time. Changes invalidate prior coverage certification, and evaluation must be run again against an independent reference.

When the stored source page contains an expanded or explicitly bounded Description section, its full text replaces any model summary. This repair also applies to pending or failed observations: only the description's missing/absence flags are cleared, other missing fields and their failure remain visible, and other partial model values are not promoted. Internal paragraphs and subheadings are retained without a length limit; captions and content outside the section are excluded. The replay audit identifies the source artifact and reports `repairedDescriptions` separately from downgraded complete statuses.

Raw arrays default to `complete: false`. Importing cannot infer that all native pages were traversed. Each original record, including fields not represented by the collector schema, is retained verbatim in the imported evidence. Descriptions and image URL arrays are not truncated. Duplicate identities remain auditable; conflicting duplicate data make evaluation inconclusive until a reconciled snapshot is imported.

`listingUrl` is authoritative for canonical identity. The importer maps extension `detailed`, `listing` and `failed` states to captured, pending and failed detail states. It never converts an absent property in JSON into evidence that the field is absent on the website.

To explicitly document source absence, add a field to the record's `absentFields` array only after checking the listing. Fields absent from the reference but neither observed nor explicitly marked absent remain unknown. A required field in that state makes the reference inconclusive.

## Reading the metrics

| Metric | Numerator / denominator |
|---|---|
| Identity coverage | Expected canonical IDs recovered / unique expected canonical IDs |
| Detail processing | Captured detail records / all discovered identities |
| Field completeness | Present returned values / reference fields with observed values |
| Returned field accuracy | Exactly matching values / returned values that can be assessed, including values invented for explicitly absent source fields |
| Image coverage | Reference image URLs recovered / unique reference image URLs |

Metrics retain raw counts. A denominator of zero is **not assessable**, not zero accuracy or 100% success. Missing records remain in the identity and field denominators. The evaluator checks all fields observed in the reference, including descriptions, characteristics and images, in addition to verifying that required fields have a known presence/absence state.

Whitespace, Unicode normalization and letter case are normalized for text. Numeric values receive no tolerance. Feature lists compare as sets. Image URLs and ordering are compared exactly, including the cover image. URL coverage also has its separate metric so one missing image remains visible among hundreds.

Provider identity, source, run ID and URL-derived listing identity must agree. Data from another provider or run cannot fill a missing result. Attributable listing evidence is required. Missing detail work, unretrieved records, inconsistent run counters, failed details and unobserved search exhaustion prevent a complete verdict.

Cost per useful listing counts reference listings that have complete matching data and evidence before review. Provider-reported charges and conservative estimates derived from account balance changes are separate report fields. When an estimate exists, the per-listing figure includes it and is explicitly labeled. Unknown billing is never treated as free; an unresolved bill makes the per-listing figure unknown. Duration requires both valid start and end timestamps.

## Reviews and source changes

Reviews carry the reference/run/listing IDs, field, resolution, nonempty note, source evidence URL and review timestamp. They annotate discrepancies without deleting them or changing denominators.

- `confirmed_match` can document equivalent returned text with evidence from the corresponding listing. It cannot create a missing listing, field or evidence, and cannot legitimize a value for a field explicitly absent from the source.
- `confirmed_error` preserves the error as unresolved for completeness.
- `source_changed` and `source_absent` document temporal changes. The result remains inconclusive until a new reconciled reference is imported and the comparison is rerun.

A match review against an unrelated listing is ignored. A review without a note, valid evidence URL or matching run/reference is ignored. Never remove an expected listing simply because a provider missed it; first establish the actual website change with evidence.

## Verdicts

- **verified_complete:** every reference identity and expected observation is accounted for, all work has finished, exhaustion was observed and no blocking discrepancies remain. The reference's completeness is attested; the evaluator does not independently certify the entire website.
- **incomplete:** missing IDs, fields, evidence, unresolved differences, pending work or failed details. **99 of 100 is incomplete.**
- **technical_limitation:** a completed attempt encountered a recorded provider/site technical block.
- **inconclusive:** reference or query cannot be validated, source changes need reconciliation, the run is unfinished, the budget expired or billing/provenance is uncertain.

Known-URL extraction must request the full reference identity set. Extracting a shortlist is a different test from discovering a complete native search. Do not choose a winner if neither provider meets the complete-search requirement.

The JSON report and Markdown export include counts, discrepancies, reasons, cost and observation-window context. Simulated test results validate this methodology and the application; only paid live runs against independently prepared references demonstrate actual provider access to Leboncoin.
