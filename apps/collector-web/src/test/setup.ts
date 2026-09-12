import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

const storageValues = new Map<string, string>();
const storage: Storage = { get length() { return storageValues.size; }, clear: () => storageValues.clear(), getItem: (key) => storageValues.get(key) ?? null, key: (index) => [...storageValues.keys()][index] ?? null, removeItem: (key) => { storageValues.delete(key); }, setItem: (key, value) => { storageValues.set(key, String(value)); } };
Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
