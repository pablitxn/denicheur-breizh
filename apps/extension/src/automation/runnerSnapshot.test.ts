import { describe, expect, it } from "vitest";
import { IDLE_RUN } from "../storage/chromeStorage";
import type { ScrapeRun, ScrapedPropertyRecord } from "../lib/types";
import { RunnerSnapshotCache } from "./runnerSnapshot";

function record(index: number): ScrapedPropertyRecord {
  return {
    id: String(index),
    source: "leboncoin",
    listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${index}`,
    title: `Listing ${index}`,
    features: ["Garden"],
    imageUrls: ["https://example.test/image.jpg"],
    scrapedAt: "2026-09-06T12:00:00Z",
    searchRunId: "snapshot-run",
    status: "listing",
    rawTextSample: "Synthetic listing",
  };
}

describe("runner observer snapshots", () => {
  it("emits one collection identity for 1,000 progress ticks over 500 stored records", () => {
    const cache = new RunnerSnapshotCache();
    const records = Array.from({ length: 500 }, (_, index) => record(index));
    const identities = new Set<readonly ScrapedPropertyRecord[]>();
    const run: ScrapeRun = { ...IDLE_RUN, status: "collecting-details" };

    for (let index = 0; index < 1_000; index += 1) {
      run.collected = index;
      const snapshot = cache.create(run, records);
      identities.add(snapshot.records);
      expect(snapshot.run.collected).toBe(index);
    }

    expect(identities.size).toBe(1);
    expect([...identities][0]).not.toBe(records);
  });

  it("reuses unchanged records and preserves old snapshots when one listing is replaced", () => {
    const cache = new RunnerSnapshotCache();
    const first = record(1);
    const second = record(2);
    const previous = cache.create(IDLE_RUN, [first, second]);
    const updated = { ...first, title: "Updated title", features: [...first.features, "Garage"] };

    const next = cache.create(IDLE_RUN, [updated, second]);

    expect(next.records).not.toBe(previous.records);
    expect(next.records[0]).not.toBe(previous.records[0]);
    expect(next.records[1]).toBe(previous.records[1]);
    expect(previous.records[0].features).toEqual(["Garden"]);
    expect(next.records[0].features).toEqual(["Garden", "Garage"]);
  });

  it("prevents observers from mutating nested records or the runner's mutable run", () => {
    const cache = new RunnerSnapshotCache();
    const records = [record(1)];
    const run: ScrapeRun = {
      ...IDLE_RUN,
      message: { id: "run.collectedDetailsProgress", values: { count: 1 } },
      filterWarnings: [{ field: "sort", message: { id: "warning.native" } }],
    };
    const snapshot = cache.create(run, records);

    expect(() => snapshot.records[0].features.push("Mutation")).toThrow(TypeError);
    expect(() => { snapshot.records[0].title = "Mutation"; }).toThrow(TypeError);
    expect(() => snapshot.run.filterWarnings.push({ field: "mutation", message: "Mutation" })).toThrow(TypeError);
    expect(() => { snapshot.run.filterWarnings[0].field = "mutation"; }).toThrow(TypeError);

    run.collected = 2;
    run.filterWarnings.push({ field: "rooms", message: "Another warning" });
    expect(snapshot.run.collected).toBe(0);
    expect(snapshot.run.filterWarnings).toHaveLength(1);
    expect(records[0].features).toEqual(["Garden"]);
    expect(records[0].title).toBe("Listing 1");
    expect(Object.isFrozen(records[0])).toBe(false);
  });
});
