import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translateExtension } from "../i18n/messages";
import { CRAWLER_STORAGE_KEYS, IDLE_RUN } from "../storage/chromeStorage";
import { requestImmediateSync } from "../sync/runtime";
import { EMPTY_SYNC_STATE, SYNC_STORAGE_KEY } from "../sync/storage";
import { PopupApp } from "./PopupApp";

vi.mock("./theme", () => ({ useThemePreference: vi.fn() }));
vi.mock("../sync/runtime", () => ({ requestImmediateSync: vi.fn() }));
vi.mock("../i18n", () => ({
  LocaleSelector: () => null,
  useExtensionI18n: () => ({
    formatNumber: String,
    resolveText: () => ({ text: "Ready" }),
    t: (id: Parameters<typeof translateExtension>[1], values?: Parameters<typeof translateExtension>[2]) =>
      translateExtension("en", id, values),
  }),
}));

type StorageCallback = (values: Record<string, unknown>) => void;
type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let root: Root;
let container: HTMLDivElement;
let storage: Record<string, unknown>;
let listeners: Set<StorageListener>;
let get: ReturnType<typeof vi.fn<(keys: string[], callback: StorageCallback) => void>>;
let queryTabs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage = {
    [CRAWLER_STORAGE_KEYS.run]: { ...IDLE_RUN, collected: 4 },
    [CRAWLER_STORAGE_KEYS.records]: [],
    [SYNC_STORAGE_KEY]: structuredClone(EMPTY_SYNC_STATE),
  };
  listeners = new Set();
  get = vi.fn((keys, callback) => callback(Object.fromEntries(keys.map((key) => [key, storage[key]]))));
  queryTabs = vi.fn().mockResolvedValue([]);
  vi.stubGlobal("chrome", {
    runtime: { lastError: undefined, getURL: () => "chrome-extension://test/dashboard.html" },
    storage: {
      local: {
        get,
        set: (patch: Record<string, unknown>, callback: () => void) => {
          Object.assign(storage, patch);
          callback();
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => listeners.add(listener),
        removeListener: (listener: StorageListener) => listeners.delete(listener),
      },
    },
    tabs: { query: queryTabs, create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    windows: { update: vi.fn().mockResolvedValue({}) },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderPopup() {
  await act(async () => root.render(<PopupApp />));
}

function button(text: string) {
  const result = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(text));
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

async function changeStorage(changes: Record<string, chrome.storage.StorageChange>) {
  await act(async () => {
    for (const listener of listeners) listener(changes, "local");
  });
}

describe("popup feedback and live state", () => {
  it("does not claim synchronization before the first successfully transferred batch", async () => {
    await renderPopup();
    expect(container.textContent).toContain("No completed sync yet");
    expect(container.textContent).not.toContain("Collected data synced");

    storage[SYNC_STORAGE_KEY] = { ...EMPTY_SYNC_STATE, lastSuccessAt: "2026-09-06T12:00:00Z" };
    await changeStorage({ [SYNC_STORAGE_KEY]: { newValue: storage[SYNC_STORAGE_KEY] } });

    expect(container.textContent).toContain("Collected data synced");
    expect(container.textContent).not.toContain("No completed sync yet");
  });

  it("opens the owning dashboard instead of a different existing dashboard during an active run", async () => {
    storage[CRAWLER_STORAGE_KEYS.run] = { ...IDLE_RUN, status: "collecting-details", dashboardTabId: 22 };
    queryTabs.mockResolvedValueOnce([{ id: 11, windowId: 1 }, { id: 22, windowId: 2 }]);
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await renderPopup();

    await act(async () => button("Open dashboard").click());

    expect(chrome.tabs.update).toHaveBeenCalledWith(22, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it("shows rejected synchronization without hiding progress and clears the alert after retry", async () => {
    vi.mocked(requestImmediateSync).mockRejectedValueOnce(new Error("Background unavailable"));
    await renderPopup();

    await act(async () => button("Sync now").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Background unavailable");
    expect(container.querySelector("progress")?.value).toBe(4);
    expect(button("Sync now").disabled).toBe(false);

    vi.mocked(requestImmediateSync).mockResolvedValueOnce({ ok: true, state: structuredClone(EMPTY_SYNC_STATE) });
    await act(async () => button("Sync now").click());

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows unsuccessful background responses even when sync state still says idle", async () => {
    vi.mocked(requestImmediateSync).mockResolvedValueOnce({
      ok: false,
      error: "Connection unavailable",
      state: structuredClone(EMPTY_SYNC_STATE),
    });
    await renderPopup();

    await act(async () => button("Sync now").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection unavailable");
  });

  it("refreshes only the changed state and ignores filter-only notifications", async () => {
    await renderPopup();
    get.mockClear();

    storage[CRAWLER_STORAGE_KEYS.run] = { ...IDLE_RUN, collected: 7 };
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: storage[CRAWLER_STORAGE_KEYS.run] } });
    expect(get.mock.calls.map(([keys]) => keys)).toEqual([[CRAWLER_STORAGE_KEYS.run]]);
    expect(container.querySelector("progress")?.value).toBe(7);
    get.mockClear();

    await changeStorage({ [SYNC_STORAGE_KEY]: { newValue: EMPTY_SYNC_STATE } });
    expect(get.mock.calls.map(([keys]) => keys)).toEqual([[SYNC_STORAGE_KEY]]);
    get.mockClear();

    await changeStorage({ [CRAWLER_STORAGE_KEYS.filters]: { newValue: {} } });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not replace new progress with an older storage response that finishes later", async () => {
    await renderPopup();
    const pendingReads: StorageCallback[] = [];
    get.mockImplementation((_keys, callback) => { pendingReads.push(callback); });
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });

    await act(async () => pendingReads[1]({ [CRAWLER_STORAGE_KEYS.run]: { ...IDLE_RUN, collected: 8 } }));
    await act(async () => pendingReads[0]({ [CRAWLER_STORAGE_KEYS.run]: { ...IDLE_RUN, collected: 5 } }));

    expect(container.querySelector("progress")?.value).toBe(8);
  });

  it("retains the last loaded progress when a refresh fails and offers a retry", async () => {
    await renderPopup();
    get.mockImplementationOnce((_keys, callback) => {
      Object.assign(chrome.runtime, { lastError: { message: "Storage unavailable" } });
      callback({});
      Object.assign(chrome.runtime, { lastError: undefined });
    });

    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Storage unavailable");
    expect(container.querySelector("progress")?.value).toBe(4);
    expect(button("Retry")).toBeDefined();
  });

  it("ignores an older refresh failure after newer progress succeeds", async () => {
    await renderPopup();
    const pendingReads: StorageCallback[] = [];
    get.mockImplementation((_keys, callback) => { pendingReads.push(callback); });
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });

    await act(async () => pendingReads[1]({ [CRAWLER_STORAGE_KEYS.run]: { ...IDLE_RUN, collected: 8 } }));
    await act(async () => {
      Object.assign(chrome.runtime, { lastError: { message: "Old read failed" } });
      pendingReads[0]({});
      Object.assign(chrome.runtime, { lastError: undefined });
    });

    expect(container.querySelector("progress")?.value).toBe(8);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears a recovered field's error without clearing errors from unrelated fields", async () => {
    await renderPopup();
    get.mockImplementationOnce((_keys, callback) => {
      Object.assign(chrome.runtime, { lastError: { message: "Progress unavailable" } });
      callback({});
      Object.assign(chrome.runtime, { lastError: undefined });
    });
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: {} } });

    await changeStorage({ [SYNC_STORAGE_KEY]: { newValue: EMPTY_SYNC_STATE } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Progress unavailable");

    storage[CRAWLER_STORAGE_KEYS.run] = { ...IDLE_RUN, collected: 9 };
    await changeStorage({ [CRAWLER_STORAGE_KEYS.run]: { newValue: storage[CRAWLER_STORAGE_KEYS.run] } });

    expect(container.querySelector("progress")?.value).toBe(9);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the popup open with actionable feedback when dashboard navigation fails", async () => {
    queryTabs.mockRejectedValueOnce(new Error("Tabs unavailable"));
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await renderPopup();

    await act(async () => button("Open dashboard").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The dashboard could not be opened");
    expect(button("Open dashboard").disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });
});
