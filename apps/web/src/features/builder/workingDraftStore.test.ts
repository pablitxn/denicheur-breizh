import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkingDraftStore } from "./workingDraftStore";

const key = "builder-durability-test";
type Draft = { value: { name: string } };
const first: Draft = { value: { name: "First draft" } };
const changed: Draft = { value: { name: "Changed draft" } };

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

describe("working draft durability", () => {
  it("resumes a draft created in another tab before its storage event arrives", () => {
    const store = createWorkingDraftStore<Draft>(key);
    expect(store.getSnapshot().drafts).toEqual({});
    window.localStorage.setItem(key, JSON.stringify({ first: changed }));
    store.open("first", first);

    expect(store.getSnapshot()).toMatchObject({ drafts: { first: changed }, activeKey: "first" });
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ first: changed });
  });

  it("retains edits when storage access is blocked, including after view subscriptions change", () => {
    let blocked = true;
    const store = createWorkingDraftStore<Draft>(key, () => {
      if (blocked) throw new DOMException("Blocked", "SecurityError");
      return window.localStorage;
    });
    const unsubscribe = store.subscribe(() => undefined);
    store.put("first", first);
    store.select("first");
    unsubscribe();
    const unsubscribeAgain = store.subscribe(() => undefined);

    expect(store.getSnapshot()).toMatchObject({ drafts: { first }, activeKey: "first", sessionOnly: true });
    blocked = false;
    store.retry();
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ first });
    expect(store.getSnapshot().sessionOnly).toBe(false);
    unsubscribeAgain();
  });

  it("never resurrects a removed draft when its storage deletion fails", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    const remove = vi.spyOn(window.localStorage, "removeItem").mockImplementation(() => { throw new Error("Blocked"); });
    expect(store.remove("first", first)).toBe(true);
    expect(window.localStorage.getItem(key)).toContain("First draft");
    const unsubscribe = store.subscribe(() => undefined);
    expect(store.getSnapshot()).toMatchObject({ drafts: {}, sessionOnly: true });

    remove.mockRestore();
    store.retry();
    expect(window.localStorage.getItem(key)).toBeNull();
    expect(store.getSnapshot()).toMatchObject({ drafts: {}, sessionOnly: false });
    unsubscribe();
  });

  it("preserves a newer draft when publication finishes for an older version", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    store.put("first", changed);
    expect(store.remove("first", first)).toBe(false);
    expect(store.getSnapshot().drafts.first).toEqual(changed);
  });

  it("merges other drafts without replacing an active editor until a conflict is resolved", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    store.select("first");
    const unsubscribe = store.subscribe(() => undefined);
    window.localStorage.setItem(key, JSON.stringify({ first: changed, other: first }));
    window.dispatchEvent(new StorageEvent("storage", { key }));

    expect(store.getSnapshot()).toMatchObject({ drafts: { first, other: first }, conflicts: { first: { incoming: changed } } });
    store.retry();
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ first: changed, other: first });
    store.resolve("first", "incoming");
    expect(store.getSnapshot()).toMatchObject({ drafts: { first: changed, other: first }, conflicts: {} });
    unsubscribe();
  });

  it("keeps the local version only after the user explicitly resolves a conflict", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    store.select("first");
    window.localStorage.setItem(key, JSON.stringify({ first: changed }));
    store.retry();
    store.resolve("first", "local");

    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ first });
    expect(store.getSnapshot().conflicts).toEqual({});
  });

  it("recovers a separately keyed copy when another tab published or deleted the active draft", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    store.select("first");
    window.localStorage.removeItem(key);
    store.retry();
    expect(store.getSnapshot().conflicts.first).toEqual({ incoming: undefined });
    expect(window.localStorage.getItem(key)).toBeNull();
    store.resolve("first", "local");

    const recoveredKey = store.getSnapshot().activeKey!;
    expect(recoveredKey).toMatch(/^first:recovered:/);
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ [recoveredKey]: first });
    expect(store.getSnapshot().drafts.first).toBeUndefined();
  });

  it("retries a quota-limited edit without losing unrelated persisted drafts", () => {
    const store = createWorkingDraftStore<Draft>(key);
    store.put("first", first);
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    store.put("second", changed);
    expect(store.getSnapshot()).toMatchObject({ drafts: { first, second: changed }, sessionOnly: true });
    write.mockRestore();
    store.retry();
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ first, second: changed });
  });
});
