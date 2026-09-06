import type { ScrapeRun, ScrapedPropertyRecord } from "../lib/types";

export interface RunnerSnapshot {
  readonly run: Readonly<ScrapeRun>;
  readonly records: readonly ScrapedPropertyRecord[];
}

/**
 * Runner updates replace changed records instead of mutating them. Reuse detached
 * record snapshots by identity so progress-only notifications do not copy the
 * collection or invalidate React's record-derived state. Runtime freezing also
 * protects nested fields from observers without freezing the runner's own data.
 */
export class RunnerSnapshotCache {
  private recordsSource?: readonly ScrapedPropertyRecord[];
  private recordsSnapshot: readonly ScrapedPropertyRecord[] = Object.freeze([]);
  private readonly recordSnapshots = new WeakMap<ScrapedPropertyRecord, ScrapedPropertyRecord>();

  create(run: ScrapeRun, records: readonly ScrapedPropertyRecord[]): RunnerSnapshot {
    if (records !== this.recordsSource) {
      this.recordsSnapshot = Object.freeze(records.map((record) => {
        let snapshot = this.recordSnapshots.get(record);
        if (!snapshot) {
          snapshot = freezeDeep(structuredClone(record));
          this.recordSnapshots.set(record, snapshot);
        }
        return snapshot;
      }));
      this.recordsSource = records;
    }

    return Object.freeze({
      run: freezeDeep(structuredClone(run)),
      records: this.recordsSnapshot,
    });
  }
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeDeep(nested);
  return value;
}
