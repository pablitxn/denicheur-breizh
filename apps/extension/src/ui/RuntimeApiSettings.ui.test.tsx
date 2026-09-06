import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeApiConfig,
  DEFAULT_API_BASE_URL,
  loadRuntimeApiConfig,
  PRODUCTION_API_BASE_URL,
  RUNTIME_API_STORAGE_KEYS,
  saveRuntimeApiConfig,
  type RuntimeApiConfig,
} from "../api/runtimeConfig";
import { translateExtension } from "../i18n/messages";
import { RuntimeApiSettings } from "./RuntimeApiSettings";

vi.mock("../api/runtimeConfig", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api/runtimeConfig")>(),
  loadRuntimeApiConfig: vi.fn(),
  saveRuntimeApiConfig: vi.fn(),
  clearRuntimeApiConfig: vi.fn(),
}));
vi.mock("../i18n", () => ({
  useExtensionI18n: () => ({
    t: (id: Parameters<typeof translateExtension>[1], values?: Parameters<typeof translateExtension>[2]) =>
      translateExtension("en", id, values),
  }),
}));

type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let root: Root;
let container: HTMLDivElement;
let listeners: Set<StorageListener>;
const savedConfig = { baseUrl: DEFAULT_API_BASE_URL };
const draftUrl = "http://localhost:4311";
const draftText = "test-only-draft";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(loadRuntimeApiConfig).mockResolvedValue(savedConfig);
  listeners = new Set();
  vi.stubGlobal("chrome", {
    storage: {
      onChanged: {
        addListener: (listener: StorageListener) => listeners.add(listener),
        removeListener: (listener: StorageListener) => listeners.delete(listener),
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSettings() {
  await act(async () => root.render(<RuntimeApiSettings />));
}

function input(name: "base-url" | "operator-token") {
  return container.querySelector<HTMLInputElement>(`[name="runtime-api-${name}"]`)!;
}

async function edit(name: "base-url" | "operator-token", value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value);
    input(name).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!;
}

async function notifyConfigChanged() {
  await act(async () => {
    for (const listener of listeners) listener({ [RUNTIME_API_STORAGE_KEYS.baseUrl]: {} }, "local");
  });
}

describe("runtime API settings draft lifecycle", () => {
  it("waits for saved configuration before enabling edits or accepting a submit", async () => {
    const initialLoad = deferred<RuntimeApiConfig>();
    vi.mocked(loadRuntimeApiConfig).mockReturnValueOnce(initialLoad.promise);
    await renderSettings();

    expect(input("base-url").disabled).toBe(true);
    expect(input("operator-token").disabled).toBe(true);
    await submit();
    expect(saveRuntimeApiConfig).not.toHaveBeenCalled();

    await act(async () => initialLoad.resolve({ baseUrl: PRODUCTION_API_BASE_URL }));

    expect(input("base-url").value).toBe(PRODUCTION_API_BASE_URL);
    expect(input("base-url").disabled).toBe(false);
  });

  it("preserves URL and token drafts and explains a background configuration conflict", async () => {
    await renderSettings();
    await edit("base-url", draftUrl);
    await edit("operator-token", draftText);
    vi.mocked(loadRuntimeApiConfig).mockResolvedValueOnce({ baseUrl: PRODUCTION_API_BASE_URL });

    await notifyConfigChanged();

    expect(input("base-url").value).toBe(draftUrl);
    expect(input("operator-token").value === draftText).toBe(true);
    expect(container.textContent).toContain("Your edits are preserved; save to apply them");
    expect(saveRuntimeApiConfig).not.toHaveBeenCalled();
  });

  it("disables editing during save and keeps the draft after a failed update", async () => {
    await renderSettings();
    await edit("base-url", draftUrl);
    await edit("operator-token", draftText);
    const save = deferred<RuntimeApiConfig>();
    vi.mocked(saveRuntimeApiConfig).mockReturnValueOnce(save.promise);

    await submit();
    expect(input("base-url").disabled).toBe(true);
    expect(input("operator-token").disabled).toBe(true);
    await notifyConfigChanged();
    await submit();
    expect(saveRuntimeApiConfig).toHaveBeenCalledOnce();
    await act(async () => save.reject(new Error("Storage unavailable")));

    expect(input("base-url").value).toBe(draftUrl);
    expect(input("operator-token").value === draftText).toBe(true);
    expect(input("operator-token").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Your edits are preserved");
  });

  it("clears a confirmed saved draft and ignores a refresh started before the save", async () => {
    await renderSettings();
    await edit("base-url", draftUrl);
    await edit("operator-token", draftText);
    const oldRefresh = deferred<RuntimeApiConfig>();
    vi.mocked(loadRuntimeApiConfig).mockReturnValueOnce(oldRefresh.promise);
    await notifyConfigChanged();
    const save = deferred<RuntimeApiConfig>();
    vi.mocked(saveRuntimeApiConfig).mockReturnValueOnce(save.promise);

    await submit();
    expect(input("operator-token").value === draftText).toBe(true);
    await act(async () => save.resolve({ baseUrl: draftUrl }));
    await act(async () => oldRefresh.resolve({ baseUrl: PRODUCTION_API_BASE_URL }));

    expect(input("base-url").value).toBe(draftUrl);
    expect(input("operator-token").value).toBe("");
    expect(container.textContent).toContain("API connection saved locally");
    expect(container.textContent).not.toContain("changed in another dashboard");
  });

  it("offers a retry after initial loading fails without enabling changes to unknown settings", async () => {
    vi.mocked(loadRuntimeApiConfig).mockRejectedValueOnce(new Error("Storage unavailable"));
    await renderSettings();

    expect(input("base-url").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    await act(async () => button("Retry").click());

    expect(input("base-url").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("preserves the draft when reset fails and clears it only after a successful reset", async () => {
    await renderSettings();
    await edit("base-url", draftUrl);
    await edit("operator-token", draftText);
    vi.mocked(clearRuntimeApiConfig).mockRejectedValueOnce(new Error("Storage unavailable"));

    await act(async () => button("Reset and clear token").click());

    expect(input("base-url").value).toBe(draftUrl);
    expect(input("operator-token").value === draftText).toBe(true);
    vi.mocked(clearRuntimeApiConfig).mockResolvedValueOnce();
    await act(async () => button("Reset and clear token").click());

    expect(input("base-url").value).toBe(DEFAULT_API_BASE_URL);
    expect(input("operator-token").value).toBe("");
  });
});
