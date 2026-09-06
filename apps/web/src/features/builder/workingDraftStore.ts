export interface DraftConflict<T> {
  incoming: T | undefined;
}

export interface WorkingDraftSnapshot<T> {
  drafts: Record<string, T>;
  activeKey?: string;
  sessionOnly: boolean;
  conflicts: Record<string, DraftConflict<T>>;
  revision: number;
}

/**
 * Keeps unsaved writes and deletion tombstones alive across view navigation.
 * Storage events and a fresh read before writes protect observed conflicts.
 * localStorage read/merge/write is not atomic across tabs: simultaneous writes
 * may still race. This is draft recovery, not a collaborative editing protocol.
 */
export function createWorkingDraftStore<T>(
  storageKey: string,
  storage = () => window.localStorage,
  isValid?: (value: unknown) => value is T,
) {
  let snapshot: WorkingDraftSnapshot<T> = { drafts: {}, sessionOnly: false, conflicts: {}, revision: 0 };
  let initialized = false;
  let baseline: Record<string, T> = {};
  const pending = new Map<string, T | undefined>();
  const listeners = new Set<() => void>();

  const emit = (next: WorkingDraftSnapshot<T>) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const read = (): Record<string, T> | undefined => {
    try {
      const raw = storage().getItem(storageKey);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid drafts");
      // Refuse the whole envelope instead of deleting or rewriting unknown data.
      // The in-memory editor remains usable and can retry after storage recovery.
      if (isValid && !Object.values(parsed).every(isValid)) throw new Error("Invalid draft entry");
      return parsed as Record<string, T>;
    } catch {
      emit({ ...snapshot, sessionOnly: true });
      return undefined;
    }
  };
  const initialize = () => {
    if (initialized) return;
    initialized = true;
    const stored = read();
    if (stored) {
      baseline = stored;
      snapshot = { ...snapshot, drafts: stored };
    }
  };
  const refresh = () => {
    initialize();
    const incoming = read();
    if (!incoming) return false;
    const drafts = { ...snapshot.drafts };
    const conflicts = { ...snapshot.conflicts };
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(incoming)])) {
      if (same(incoming[key], baseline[key])) continue;
      if (!same(incoming[key], drafts[key]) && (pending.has(key) || snapshot.activeKey === key)) {
        conflicts[key] = { incoming: incoming[key] };
      } else {
        if (incoming[key] === undefined) delete drafts[key];
        else drafts[key] = incoming[key]!;
        delete conflicts[key];
      }
    }
    baseline = incoming;
    emit({ ...snapshot, drafts, conflicts, sessionOnly: pending.size > 0 });
    return true;
  };
  const persist = () => {
    if (!refresh()) return;
    const writable = [...pending.keys()].filter((key) => !snapshot.conflicts[key]);
    if (writable.length === 0) return;
    const stored = { ...baseline };
    for (const key of writable) {
      const draft = pending.get(key);
      if (draft === undefined) delete stored[key];
      else stored[key] = draft;
    }
    try {
      if (Object.keys(stored).length === 0) storage().removeItem(storageKey);
      else storage().setItem(storageKey, JSON.stringify(stored));
      baseline = stored;
      writable.forEach((key) => pending.delete(key));
      emit({ ...snapshot, sessionOnly: pending.size > 0 });
    } catch {
      emit({ ...snapshot, sessionOnly: true });
    }
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) refresh();
  };

  return {
    getSnapshot: () => { initialize(); return snapshot; },
    subscribe: (listener: () => void) => {
      initialize();
      listeners.add(listener);
      if (listeners.size === 1) window.addEventListener("storage", handleStorage);
      refresh();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener("storage", handleStorage);
      };
    },
    select: (activeKey?: string) => {
      refresh();
      emit({ ...snapshot, activeKey });
    },
    open: (key: string, initial: T) => {
      // Re-read before creating: another tab may have started this same version
      // since the library rendered, even before its storage event is delivered.
      refresh();
      if (snapshot.drafts[key] === undefined) {
        pending.set(key, initial);
        emit({ ...snapshot, drafts: { ...snapshot.drafts, [key]: initial }, activeKey: key });
        persist();
      } else {
        emit({ ...snapshot, activeKey: key });
      }
    },
    put: (key: string, draft: T) => {
      refresh();
      pending.set(key, draft);
      emit({ ...snapshot, drafts: { ...snapshot.drafts, [key]: draft } });
      persist();
    },
    remove: (key: string, expected?: T): boolean => {
      refresh();
      // A publication can finish after the user switches views or another tab
      // edits the draft. Only remove the exact version that was published.
      if (snapshot.conflicts[key] || (expected !== undefined && !same(snapshot.drafts[key], expected))) return false;
      const drafts = { ...snapshot.drafts };
      delete drafts[key];
      pending.set(key, undefined);
      emit({ ...snapshot, drafts, activeKey: snapshot.activeKey === key ? undefined : snapshot.activeKey });
      persist();
      return true;
    },
    retry: persist,
    resolve: (key: string, choice: "local" | "incoming") => {
      refresh();
      const conflict = snapshot.conflicts[key];
      if (!conflict) return;
      const conflicts = { ...snapshot.conflicts };
      delete conflicts[key];
      const drafts = { ...snapshot.drafts };
      let activeKey = snapshot.activeKey;
      if (choice === "incoming") {
        if (conflict.incoming === undefined) delete drafts[key];
        else drafts[key] = conflict.incoming;
        pending.delete(key);
        if (activeKey === key && !drafts[key]) activeKey = undefined;
      } else if (conflict.incoming === undefined && drafts[key] !== undefined) {
        // A deleted/published draft must never silently reappear under its old
        // key. Explicit recovery creates an independent draft instead.
        const recoveredKey = `${key}:recovered:${crypto.randomUUID()}`;
        drafts[recoveredKey] = drafts[key]!;
        delete drafts[key];
        pending.delete(key);
        pending.set(recoveredKey, drafts[recoveredKey]);
        if (activeKey === key) activeKey = recoveredKey;
      } else {
        pending.set(key, drafts[key]);
      }
      emit({ ...snapshot, drafts, activeKey, conflicts, revision: snapshot.revision + 1 });
      persist();
    },
  };
}

export type WorkingDraftStore<T> = ReturnType<typeof createWorkingDraftStore<T>>;

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
