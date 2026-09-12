import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("collector runtime provider boundary", () => {
  it("cannot label live adapters simulated or open storage without explicitly supplied test adapters", () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-runtime-test-")); directories.push(directory);
    const config = readConfig({ COLLECTOR_TEST_MODE: "1", COLLECTOR_DATA_DIR: directory, XAI_API_KEY: "not-a-live-key", FIRECRAWL_API_KEY: "not-a-live-key" });
    expect(() => createRuntime(config)).toThrow(/explicitly injected synthetic providers/);
    expect(existsSync(config.dbPath)).toBe(false);
  });
  it("allows an explicitly isolated offline registry without production keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "collector-runtime-test-")); directories.push(directory);
    const config = readConfig({ COLLECTOR_TEST_MODE: "1", COLLECTOR_DATA_DIR: directory });
    const worker = createRuntime(config, new Map());
    expect(worker.metadata().live).toBe(false);
    expect(worker.providers.size).toBe(0);
    await worker.stop(); worker.store.close();
  });
});
