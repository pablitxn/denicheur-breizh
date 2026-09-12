/** Offline Playwright harness. This executable never imports a live provider. */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ObservationInput, ProviderId } from "@denicheur-breizh/collector-contracts";
import { createApp } from "./app.js";
import { ProviderError, type CaptureProvider, type ProviderStepContext } from "./adapter.js";
import { readConfig } from "./config.js";
import { CollectorStore } from "./store.js";
import { CaptureWorker } from "./worker.js";

if (process.env.COLLECTOR_TEST_MODE !== "1") throw new Error("The collector test server requires COLLECTOR_TEST_MODE=1.");
// A regression that accidentally attempts an HTTP call must fail before contacting any provider.
globalThis.fetch = async () => { throw new Error("Outbound HTTP is disabled in the offline collector test server."); };

const directory = mkdtempSync(join(tmpdir(), "denicheur-collector-e2e-"));
const config = readConfig({ COLLECTOR_TEST_MODE: "1", COLLECTOR_PORT: "14315", COLLECTOR_ALLOWED_ORIGIN: "http://127.0.0.1:14175", COLLECTOR_DATA_DIR: directory });
const steps: Record<ProviderId, number> = { xai: 0, firecrawl: 0 };
const held = new Map<string, () => void>();
const heldOnce = new Set<string>();
const listingUrl = (id: number) => `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`;
const observation = (id: number): ObservationInput => ({
  url: listingUrl(id), detailStatus: "captured", absentFields: ["landSurfaceM2","energyClass","gesClass","sellerName","sellerType","postedAt"], missingFields: [],
  data: { title: `Synthetic house ${id}`, priceEuros: 200_000 + id, propertyType: "house", location: "Quimper", surfaceM2: 100, rooms: 4, bedrooms: 3, description: `Synthetic offline evidence for house ${id}. This is not a live listing.`, features: ["garden", "garage"], imageUrls: [`https://fixture.collector.invalid/images/${id}-1.jpg`, `https://fixture.collector.invalid/images/${id}-2.jpg`] },
  evidence: [{ url: listingUrl(id), kind: "page", text: `Synthetic detail page ${id}: house in Quimper, ${200_000 + id} EUR, 100 square metres. Offline fixture; no website was consulted.` }],
});

async function holdFirstDispatch(context: ProviderStepContext) {
  const name = context.request.name;
  if (!name.includes("[hold]") || heldOnce.has(name)) return;
  heldOnce.add(name);
  await context.onUsage({ amount: 0, unit: context.request.provider === "xai" ? "usd" : "credits", detail: { simulated: true, billingKnownBeforeHold: true } });
  await context.onProgress("Synthetic dispatch waiting for the offline test cancellation signal.");
  await new Promise<void>((resolve, reject) => {
    const clear = () => { held.delete(name); context.signal.removeEventListener("abort", abort); };
    const abort = () => { clear(); reject(new ProviderError("fixture_cancelled", "Offline test work cancelled with known zero usage.")); };
    held.set(name, () => { clear(); resolve(); });
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
  });
}
function provider(id: ProviderId, strategy = id === "xai" ? "xai-web-search-v1" : "firecrawl-agent-scrape-v1"): CaptureProvider {
  return {
    id, model: "offline-fixture", strategy, configured: true,
    balance: async () => ({ remaining: id === "xai" ? 25 : 5000, expiresAt: null, note: "Simulated credit balance. No live provider calls." }),
    async step(context) {
      steps[id]++;
      await holdFirstDispatch(context);
      let observations: ObservationInput[];
      let nextPages: string[] = [];
      let exhausted = false;
      if (context.work.kind === "details") {
        observations = context.work.urls.map((url) => observation(Number(new URL(url).pathname.split("/").pop())));
        if (context.request.repair) observations = observations.map(item => ({ ...item, evidence: [...item.evidence, { url: item.url, kind: "page", text: `Description: ${item.data.description}\nImages: ${item.data.imageUrls?.join("\n")}` }] }));
        if (context.request.name.includes("[repair-fixture]") && !context.request.repair) {
          observations = observations.map(item => {
            const field = item.url === listingUrl(1) ? "description" : item.url === listingUrl(2) ? "imageUrls" : undefined;
            if (!field) return item;
            const data = { ...item.data }; delete data[field];
            return { ...item, data, detailStatus: "failed", missingFields: [field], fieldStates: { [field]: { status: "unresolved", reason: "Deliberately missing in this offline repair fixture.", evidence: [] } } };
          });
        }
      } else {
        const page = new URL(context.work.urls[0] ?? context.request.searchUrl ?? "https://www.leboncoin.fr/recherche?category=9");
        const secondPage = page.searchParams.get("page") === "2";
        const from = secondPage ? 71 : 1;
        const to = secondPage ? context.request.name.includes("[missing]") ? 120 : 121 : 70;
        observations = Array.from({ length: to - from + 1 }, (_, index) => {
          const item = observation(from + index);
          return { ...item, data: { title: item.data.title }, detailStatus: "pending" as const };
        });
        if (!secondPage) { page.searchParams.set("page", "2"); nextPages = [page.toString()]; }
        exhausted = secondPage;
      }
      await context.onEvidence("synthetic_provider_step", { simulated: true, provider: id, work: context.work, listingUrls: observations.map((item) => item.url), exhausted });
      return { observations, nextPages, exhausted, warnings: ["Offline synthetic results; no live website access was tested."], usage: { amount: id === "xai" ? 0.001 : 1, unit: id === "xai" ? "usd" as const : "credits" as const, detail: { simulated: true } } };
    },
  };
}

const store = new CollectorStore(config.dbPath, join(directory, "evidence"));
const fixtures = new Map([provider("xai"), provider("firecrawl"), provider("firecrawl", "firecrawl-detail-repair-v4"), provider("firecrawl", "firecrawl-native-inventory-v5"), provider("firecrawl", "firecrawl-gallery-audit-v6"), provider("firecrawl", "firecrawl-gallery-walk-v7")].map(item => [item.strategy, item]));
const worker = new CaptureWorker(store, new Map<ProviderId, CaptureProvider>([["xai", fixtures.get("xai-web-search-v1")!], ["firecrawl", fixtures.get("firecrawl-agent-scrape-v1")!]]), config, {
  choices: id => [...fixtures.values()].filter(item => item.id === id).map(item => ({ id: item.strategy, label: `Offline ${item.strategy}` })),
  resolve(id, strategy) {
    const selected = fixtures.get(strategy);
    if (!selected || selected.id !== id) throw new ProviderError("strategy_unavailable", "Offline strategy is not registered.");
    return selected;
  },
});
const app = createApp(worker);
// Mounted ahead of the application's fallback in a separate outer server; unavailable in production.
const express = (await import("express")).default;
const outer = express();
outer.use((req, res, next) => {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(req.hostname)) return res.status(403).json({ error: "Local test host required." });
  next();
});
outer.get("/__test/state", (_req, res) => res.json({ simulated: true, heldNames: [...held.keys()], steps, sqliteFile: statSync(config.dbPath).isFile(), isolatedDirectory: directory.includes("denicheur-collector-e2e-") }));
outer.use(app);
const server = outer.listen(config.port, "127.0.0.1", () => { worker.start(); console.log(`Offline collector test server: http://127.0.0.1:${config.port}`); });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await worker.stop();
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
