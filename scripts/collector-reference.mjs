#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ID = "oekklajlieiinmjcmhdfeodpdhahhjdi";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const API_BASE = "http://127.0.0.1:4316";
const EXTENSION_OUTPUT = join(ROOT, "apps/extension/.output-collector-reference/chrome-mv3");
const STORAGE = { run: "denicheur:crawler:run", filters: "denicheur:crawler:filters", records: "denicheur:crawler:records", recipe: "denicheur:intelligence:recipe", endpoint: "denicheur:runtime-api-base-url" };
const terminal = new Set(["completed", "cancelled", "failed", "blocked-captcha", "blocked-activity"]);
const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  console.log("node scripts/collector-reference.mjs [--skip-build] [--smoke] [--headless]\nStarts an isolated extension reference session, API4316, CDP4317. Captures never start automatically. --smoke opens the extension, verifies isolation and exits.");
  process.exit(0);
}
if ([...args].some((arg) => !["--skip-build", "--smoke", "--headless"].includes(arg))) throw new Error("Unknown option. Use --help.");
const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const sessionDir = join(ROOT, ".data/collector-reference", sessionId);
const profileDir = join(sessionDir, "profile");
const exportsDir = join(sessionDir, "exports");
const cleanEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SHELL", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
let apiProcess;
let context;
let closing = false;
let lastSnapshot;
let saveQueue = Promise.resolve();
const observedPages = new Map();
const recordsByRun = new Map();
const snapshotHashes = new Map();
const finishedHashes = new Map();
const pendingObservers = new Set();

function log(message) { console.log(`[collector-reference] ${message}`); }
function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120); }
async function atomicJson(path, value) { const temporary = `${path}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
async function portFree(port) {
  await new Promise((resolvePromise, reject) => { const server = net.createServer(); server.once("error", () => reject(new Error(`Port ${port} is already occupied or unavailable; refusing to reuse an existing service.`))); server.listen(port, "127.0.0.1", () => server.close(resolvePromise)); });
}
async function command(commandName, commandArgs, options) {
  await new Promise((resolvePromise, reject) => { const child = spawn(commandName, commandArgs, { stdio: "inherit", ...options }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${commandName} failed (${code}).`))); });
}
function collectorFilters(raw = {}) {
  // A non-default ascending ordering cannot be represented by the current laboratory schema.
  // Preserve native URL + raw filters instead of claiming equivalent translated criteria.
  if (raw.order && raw.order !== "desc") return undefined;
  const category = { "9": "sale", "10": "rent", "11": "shared", "13": "commercial", "2001": "new" }[raw.category];
  if (!category) return undefined;
  const filters = { category, text: raw.text ?? "", location: raw.locationQuery ?? "", propertyTypes: (raw.propertyTypes ?? []).map((value) => ({ "1": "house", "2": "apartment", "3": "land", "4": "parking", "5": "other" })[value]).filter(Boolean), seller: raw.ownerType === "pro" ? "professional" : raw.ownerType === "private" ? "private" : "all", sort: raw.sort === "relevance" ? "relevance" : "recent" };
  for (const [from, to] of [["priceMin", "priceMin"], ["priceMax", "priceMax"], ["squareMin", "surfaceMin"], ["squareMax", "surfaceMax"], ["roomsMin", "roomsMin"], ["roomsMax", "roomsMax"], ["bedroomsMin", "bedroomsMin"], ["bedroomsMax", "bedroomsMax"]]) if (typeof raw[from] === "number") filters[to] = raw[from];
  return filters;
}
async function persist(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const endpoint = snapshot[STORAGE.endpoint];
  if (endpoint && endpoint !== API_BASE) throw new Error("Reference extension API endpoint changed; stopping isolated session.");
  if (snapshot[STORAGE.recipe]?.enabled) throw new Error("Reference intelligence was enabled; stopping isolated session.");
  lastSnapshot = snapshot;
  const run = snapshot[STORAGE.run];
  if (!run || run.id === "idle") return;
  const id = safeId(run.id); const existing = recordsByRun.get(id) ?? new Map();
  for (const record of snapshot[STORAGE.records] ?? []) if (record.searchRunId === run.id) existing.set(record.id, record);
  recordsByRun.set(id, existing);
  const records = [...existing.values()];
  const pages = new Set(observedPages.get(id) ?? []);
  if (run.searchUrl) pages.add(run.searchUrl);
  observedPages.set(id, pages);
  const rawFilters = snapshot[STORAGE.filters] ?? {};
  const reference = {
    name: `Extension reference ${run.id}`, source: "leboncoin", capturedAt: run.finishedAt ?? new Date().toISOString(),
    searchUrl: run.searchUrl, filters: collectorFilters(rawFilters), complete: false, pages: [...pages],
    notes: "Unverified extension reference. Completion of the extension job does not certify search exhaustion. Review all native pages, reconcile changes and check the 100-listing cap before attesting completeness.",
    requiredFields: ["title", "priceEuros", "propertyType", "location", "surfaceM2"], records,
    referenceAudit: { sessionId, exportedAt: new Date().toISOString(), run, rawFilters, extensionLimit: 100, retentionLimit: 500, observedPages: [...pages], source: "isolated-extension", completenessAttested: false },
  };
  const hash = createHash("sha256").update(JSON.stringify({ run, records, pages: [...pages], rawFilters })).digest("hex");
  if (snapshotHashes.get(id) === hash) return;
  snapshotHashes.set(id, hash);
  await atomicJson(join(exportsDir, `${id}.json`), reference);
  await atomicJson(join(sessionDir, "latest.json"), { runId: run.id, status: run.status, records: records.length, file: join(exportsDir, `${id}.json`), complete: false });
  if (terminal.has(run.status) && finishedHashes.get(id) !== hash) {
    finishedHashes.set(id, hash);
    await atomicJson(join(exportsDir, `${id}-${run.status}-${hash.slice(0, 12)}.json`), reference);
    log(`Saved ${records.length} records for ${run.id} (${run.status}); complete=false.`);
  }
}
function enqueue(snapshot) { saveQueue = saveQueue.then(() => persist(snapshot)); return saveQueue; }
async function readSnapshot() {
  const dashboard = context?.pages().find((page) => page.url().startsWith(EXTENSION_ORIGIN));
  if (!dashboard || dashboard.isClosed()) return;
  const snapshot = await dashboard.evaluate((keys) => chrome.storage.local.get(keys), Object.values(STORAGE));
  await enqueue(snapshot);
}
async function observePage(page) {
  if (!page.url().startsWith(EXTENSION_ORIGIN) || pendingObservers.has(page)) return;
  pendingObservers.add(page);
  try {
    await page.exposeFunction("__collectorReferenceSnapshot", enqueue).catch((error) => { if (!String(error.message).includes("already")) throw error; });
    await page.evaluate((keys) => {
      if (window.__collectorReferenceWatching) return;
      window.__collectorReferenceWatching = true;
      const snapshot = () => chrome.storage.local.get(keys).then((value) => window.__collectorReferenceSnapshot(value));
      chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && keys.some((key) => key in changes)) void snapshot(); });
      void snapshot();
    }, Object.values(STORAGE));
  } finally { pendingObservers.delete(page); }
}
function monitorPage(page) {
  page.on("domcontentloaded", () => { void observePage(page).catch((error) => { log(error.message); void shutdown(1); }); });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    let url; try { url = new URL(frame.url()); } catch { return; }
    if ((url.hostname === "leboncoin.fr" || url.hostname === "www.leboncoin.fr") && url.pathname.startsWith("/recherche")) {
      const run = lastSnapshot?.[STORAGE.run]; if (!run || run.id === "idle") return;
      const id = safeId(run.id); const pages = observedPages.get(id) ?? new Set(); pages.add(url.toString()); observedPages.set(id, pages);
    }
  });
  void observePage(page).catch((error) => { log(error.message); void shutdown(1); });
}
async function shutdown(code = 0) {
  if (closing) return; closing = true;
  try { await readSnapshot().catch(() => {}); await saveQueue.catch(() => {}); await context?.close(); }
  finally {
    if (apiProcess && apiProcess.exitCode === null) {
      apiProcess.kill("SIGTERM");
      await Promise.race([new Promise((resolvePromise) => apiProcess.once("exit", resolvePromise)), delay(5000)]);
      if (apiProcess.exitCode === null) apiProcess.kill("SIGKILL");
    }
    log(`Session retained at ${sessionDir}`); process.exitCode = code;
  }
}
process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown());

try {
  await portFree(4316); await portFree(4317);
  await mkdir(exportsDir, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (!args.has("--skip-build")) await command("pnpm", ["--filter", "@denicheur-breizh/extension", "build"], { cwd: ROOT, env: { ...cleanEnv, WXT_OUTPUT_DIR: ".output-collector-reference", VITE_API_BASE_URL: API_BASE, VITE_ENABLE_REALTIME: "false" } });
  if (!existsSync(join(EXTENSION_OUTPUT, "manifest.json"))) throw new Error("Missing isolated extension build; rerun without --skip-build.");
  // Hardening touches only generated laboratory output. It blocks accidental synchronization
  // toward any other localhost service or the productive host, including service-worker fetches.
  const manifestPath = join(EXTENSION_OUTPUT, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "declarativeNetRequest"])];
  manifest.host_permissions = (manifest.host_permissions ?? []).filter((entry) => !entry.includes("denicheur-breizh.orchid-labs.xyz"));
  manifest.declarative_net_request = { rule_resources: [{ id: "collector_reference_isolation", enabled: true, path: "collector-reference-rules.json" }] };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicJson(join(EXTENSION_OUTPUT, "collector-reference-rules.json"), [
    { id: 1, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https?://(127\\.0\\.0\\.1|localhost)(:[0-9]+)?/", resourceTypes: ["xmlhttprequest", "websocket"] } },
    { id: 2, priority: 2, action: { type: "allow" }, condition: { regexFilter: "^http://127\\.0\\.0\\.1:4316/", resourceTypes: ["xmlhttprequest", "websocket"] } },
    { id: 3, priority: 1, action: { type: "block" }, condition: { requestDomains: ["denicheur-breizh.orchid-labs.xyz", "api.openai.com", "api.x.ai", "api.firecrawl.dev"], resourceTypes: ["xmlhttprequest", "websocket"] } },
  ]);
  const dbPath = join(sessionDir, "reference.sqlite");
  apiProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: join(ROOT, "apps/api"), env: { ...cleanEnv, NODE_ENV: "development", FILTER_API_PORT: "4316", FILTER_API_HOST: "127.0.0.1", FILTER_API_ALLOWED_ORIGINS: EXTENSION_ORIGIN, DENICHEUR_DB_PATH: dbPath, MEDIA_STORAGE_MODE: "disabled", OPENAI_REALTIME_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  const apiLog = join(sessionDir, "api.log");
  // Existing API logs are structured operational events. No credential environment is passed.
  apiProcess.stdout.on("data", (data) => void import("node:fs/promises").then(({ appendFile }) => appendFile(apiLog, data, { mode: 0o600 })));
  apiProcess.stderr.on("data", (data) => void import("node:fs/promises").then(({ appendFile }) => appendFile(apiLog, data, { mode: 0o600 })));
  let health;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (apiProcess.exitCode !== null) throw new Error(`Isolated API stopped; inspect ${apiLog}.`);
    try { const response = await fetch(`${API_BASE}/v1/health/details`); if (response.ok) { health = await response.json(); break; } } catch { /* Own server is still starting. */ }
    await delay(100);
  }
  if (!health || health.openAiConfigured !== false || health.media?.status !== "disabled" || health.database?.status !== "ok") throw new Error("Isolated API did not prove database readiness with AI and media disabled.");
  context = await chromium.launchPersistentContext(profileDir, { channel: "chromium", headless: args.has("--headless"), viewport: { width: 1440, height: 1000 }, env: cleanEnv, args: [`--disable-extensions-except=${EXTENSION_OUTPUT}`, `--load-extension=${EXTENSION_OUTPUT}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4317", "--no-first-run", "--no-default-browser-check"] });
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(EXTENSION_ORIGIN)) ?? await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(EXTENSION_ORIGIN), timeout: 15000 });
  await worker.evaluate(async ({ apiBase }) => {
    await chrome.storage.local.set({ "denicheur:runtime-api-base-url": apiBase, "denicheur:locale": "es", "denicheur:intelligence:recipe": { id: "reference-disabled", version: 1, name: "Reference only", threshold: 70, enabled: false, criteria: [] } });
    await chrome.storage.local.remove(["denicheur:runtime-api-credential", "denicheur:runtime-operator-token", "denicheur:intelligence:plan"]);
  }, { apiBase: API_BASE });
  context.on("page", monitorPage); for (const page of context.pages()) monitorPage(page);
  const dashboard = await context.newPage(); await dashboard.goto(`${EXTENSION_ORIGIN}/dashboard.html`); await observePage(dashboard);
  await dashboard.getByRole("heading", { level: 1 }).waitFor({ state: "visible" });
  await readSnapshot();
  const session = { sessionId, sessionDir, profileDir, apiBase: API_BASE, database: dbPath, extensionOutput: EXTENSION_OUTPUT, extensionOrigin: EXTENSION_ORIGIN, dashboard: dashboard.url(), cdp: "http://127.0.0.1:4317", aiEnabled: false, mediaEnabled: false, liveCapturesStarted: false };
  await atomicJson(join(sessionDir, "session.json"), session);
  await dashboard.screenshot({ path: join(sessionDir, "dashboard-ready.png"), fullPage: true });
  log(`Ready. Dashboard ${dashboard.url()}`); log(`API ${API_BASE}; CDP http://127.0.0.1:4317; exports ${exportsDir}`); log("Capture has not started. Use the isolated dashboard. Press Ctrl+C when finished.");
  if (args.has("--smoke")) await shutdown();
  else {
    context.once("close", () => void shutdown());
    while (!closing) { await delay(2000); if (closing) break; await readSnapshot(); }
  }
} catch (error) { log(error instanceof Error ? error.message : "Reference session failed."); await shutdown(1); }
