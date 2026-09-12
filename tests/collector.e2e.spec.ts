import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { CaptureRun, EvaluationReport, LabMetadata, Page as ResultPage, CaptureObservation, ReferenceRecord } from "../packages/collector-contracts/src/index.js";

const api = "http://127.0.0.1:14315";
const searchUrl = "https://www.leboncoin.fr/recherche?category=9&locations=Quimper";
const listingUrl = (id: number) => `https://www.leboncoin.fr/ad/ventes_immobilieres/${id}`;
const runInput = (name: string, provider: "xai" | "firecrawl" = "xai") => ({ name, provider, source: "leboncoin", mode: "search", searchUrl });

async function createRun(request: APIRequestContext, name: string, provider: "xai" | "firecrawl" = "xai") {
  const response = await request.post(`${api}/v1/runs`, { data: runInput(name, provider), headers: { "Idempotency-Key": randomUUID() } });
  expect(response.status()).toBe(202);
  return await response.json() as CaptureRun;
}
async function completed(request: APIRequestContext, id: string) {
  await expect.poll(async () => (await (await request.get(`${api}/v1/runs/${id}`)).json() as CaptureRun).status).toBe("completed");
  return await (await request.get(`${api}/v1/runs/${id}`)).json() as CaptureRun;
}
function referenceEnvelope() {
  return {
    name: `Synthetic independent reference ${randomUUID()}`, source: "leboncoin", searchUrl, capturedAt: new Date().toISOString(), complete: true,
    pages: [searchUrl, `${searchUrl}&page=2`], notes: "Offline fixture oracle enumerated both pages and every synthetic identity. No live coverage is claimed.",
    requiredFields: ["title", "priceEuros", "propertyType", "location", "surfaceM2"],
    records: Array.from({ length: 121 }, (_, index) => {
      const id = index + 1;
      return { id: String(id), source: "leboncoin", listingUrl: listingUrl(id), status: "detailed", title: `Synthetic house ${id}`, priceEuros: 200_000 + id, propertyType: "house", location: "Quimper", surfaceM2: 100, rooms: 4, bedrooms: 3, description: `Synthetic offline evidence for house ${id}. This is not a live listing.`, features: ["garden", "garage"], imageUrls: [`https://fixture.collector.invalid/images/${id}-1.jpg`, `https://fixture.collector.invalid/images/${id}-2.jpg`], rawTextSample: `Independent synthetic oracle: house ${id}, ${200_000 + id} EUR, 100 square metres.`, scrapedAt: new Date().toISOString() };
    }),
  };
}
async function openEnglish(page: Page) {
  await page.addInitScript(() => localStorage.setItem("denicheur:locale", "en"));
  // Keep the browser offline too: synthetic images are fulfilled locally, all other external requests fail.
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(target.hostname)) return route.continue();
    if (target.hostname === "fixture.collector.invalid") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#e6eee6"/></svg>' });
    return route.abort("blockedbyclient");
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Explore. Capture. Verify." })).toBeVisible();
}

test("creates a 121-ad capture through the UI, preserves details and survives reload", async ({ page, request }) => {
  await openEnglish(page);
  await expect(page.getByText("Simulated data · no live results").first()).toBeVisible();
  const name = `UI full search ${randomUUID()}`;
  await page.getByLabel("Capture name", { exact: true }).fill(name);
  await page.getByLabel("Native search URL", { exact: true }).fill(searchUrl);
  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/runs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start capture", exact: true }).click();
  const run = await (await created).json() as CaptureRun;
  const finished = await completed(request, run.id);
  expect(finished.discovered).toBe(121);
  expect(finished.captured).toBe(121);
  expect(finished.pagesVisited).toBe(2);
  expect(finished.coverage).toBe("unknown");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Results 121", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.getByRole("button", { name: "Synthetic house 1", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Synthetic house 1", exact: true });
  await expect(detail.getByText("Synthetic offline evidence for house 1. This is not a live listing.", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(detail.getByText(/Synthetic detail page 1:/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "Captures", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Results 121", exact: true })).toBeVisible();
  const exported = await (await request.get(`${api}/v1/runs/${run.id}/export`)).json() as { observations: CaptureObservation[] };
  expect(exported.observations).toHaveLength(121);
  expect(exported.observations[120]!.externalId).toBe("121");
  expect(exported.observations.every((item) => item.data.imageUrls?.length === 2 && item.evidence.length > 0)).toBe(true);
  const state = await (await request.get(`${api}/__test/state`)).json();
  expect(state).toMatchObject({ simulated: true, sqliteFile: true, isolatedDirectory: true });
});

test("idempotency prevents a second dispatch and provider observations remain isolated", async ({ request }) => {
  const name = `Idempotent ${randomUUID()}`;
  const key = randomUUID();
  const [first, repeated] = await Promise.all(Array.from({ length: 2 }, () => request.post(`${api}/v1/runs`, { data: runInput(name), headers: { "Idempotency-Key": key } })));
  const a = await first!.json() as CaptureRun;
  const b = await repeated!.json() as CaptureRun;
  expect(a.id).toBe(b.id);
  const conflicting = await request.post(`${api}/v1/runs`, { data: runInput(`${name} changed`), headers: { "Idempotency-Key": key } });
  expect(conflicting.status()).toBe(409);
  const firecrawl = await createRun(request, `Independent Firecrawl ${randomUUID()}`, "firecrawl");
  await Promise.all([completed(request, a.id), completed(request, firecrawl.id)]);
  for (const [runId, provider] of [[a.id, "xai"], [firecrawl.id, "firecrawl"]] as const) {
    const observations = await (await request.get(`${api}/v1/runs/${runId}/observations?limit=200`)).json() as ResultPage<CaptureObservation>;
    expect(observations.total).toBe(121);
    expect(observations.items.every((item) => item.runId === runId && item.provider === provider)).toBe(true);
  }
  const runs = await (await request.get(`${api}/v1/runs?limit=200`)).json() as ResultPage<CaptureRun>;
  expect(runs.items.filter((item) => item.request.name === name)).toHaveLength(1);
  const metadata = await (await request.get(`${api}/v1/meta`)).json() as LabMetadata;
  expect(metadata.live).toBe(false);
  expect(metadata.budgets.every((budget) => budget.unknownCalls === 0)).toBe(true);
});

test("imports an independent reference in the UI and distinguishes 121/121 from 120/121", async ({ page, request }) => {
  const full = await createRun(request, `Complete comparison ${randomUUID()}`);
  const incomplete = await createRun(request, `[missing] Incomplete comparison ${randomUUID()}`, "firecrawl");
  await Promise.all([completed(request, full.id), completed(request, incomplete.id)]);
  await openEnglish(page);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByRole("button", { name: "Import reference", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import reference", exact: true });
  const envelope = referenceEnvelope();
  // Native collector records prefill timestamp/pages in the UI; conversion is independently tested through API below.
  const extensionReference = await request.post(`${api}/v1/references/extension`, { data: envelope });
  expect(extensionReference.status()).toBe(201);
  const canonicalReference = await extensionReference.json() as ReferenceRecord;
  await dialog.getByLabel("JSON", { exact: true }).setInputFiles({ name: "synthetic-reference.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(canonicalReference)) });
  await expect(dialog.getByLabel("Reference name", { exact: true })).toHaveValue(envelope.name);
  await expect(dialog.getByRole("checkbox", { name: "All search pages have been verified" })).toBeChecked();
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("checkbox", { name: new RegExp(full.request.name) }).check();
  await page.getByRole("checkbox", { name: new RegExp(incomplete.request.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).check();
  const evaluated = page.waitForResponse((response) => response.url().endsWith("/api/v1/evaluations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Compare captures", exact: true }).click();
  const report = await (await evaluated).json() as EvaluationReport;
  expect(report.results.find((item) => item.runId === full.id)?.verdict).toBe("verified_complete");
  const partial = report.results.find((item) => item.runId === incomplete.id)!;
  expect(partial.verdict).toBe("incomplete");
  expect(partial.recall).toEqual({ numerator: 120, denominator: 121, ratio: 120 / 121 });
  const reportRegion = page.getByRole("region", { name: "Report", exact: true });
  await expect(reportRegion.getByText("Complete coverage verified", { exact: true })).toBeVisible();
  await expect(reportRegion.getByText("Incomplete capture", { exact: true })).toBeVisible();
  await expect(reportRegion.getByText("leboncoin:121", { exact: true }).first()).toBeVisible();
  const markdown = await request.get(`${api}/v1/evaluations/${report.id}/export?format=markdown`);
  expect(await markdown.text()).toContain("120/121");
  expect(await markdown.text()).toContain("**incomplete**");
  await expect(page).toHaveURL(new RegExp(`report=${report.id}`));
  const reopenedMutations: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST") reopenedMutations.push(request.url()); });
  await page.reload();
  await expect(reportRegion.getByText("Complete coverage verified", { exact: true })).toBeVisible();
  await expect(reportRegion.getByText("Incomplete capture", { exact: true })).toBeVisible();
  expect(reopenedMutations).toEqual([]);
});

test("cancels and resumes from persisted work without an unknown bill", async ({ request }) => {
  const name = `[hold] Cancel and resume ${randomUUID()}`;
  const run = await createRun(request, name);
  await expect.poll(async () => (await (await request.get(`${api}/__test/state`)).json()).heldNames).toContain(name);
  const cancelled = await request.post(`${api}/v1/runs/${run.id}/cancel`);
  expect((await cancelled.json()).status).toBe("cancelled");
  await expect.poll(async () => (await (await request.get(`${api}/v1/runs/${run.id}`)).json()).endedAt).toBeTruthy();
  const stopped = await (await request.get(`${api}/v1/runs/${run.id}`)).json() as CaptureRun;
  expect(stopped.costUnknown).toBe(false);
  expect(stopped.discovered).toBe(0);
  const resumed = await request.post(`${api}/v1/runs/${run.id}/resume`);
  expect(resumed.ok()).toBe(true);
  expect((await completed(request, run.id)).discovered).toBe(121);
  const events = await (await request.get(`${api}/v1/runs/${run.id}/events`)).json();
  expect(events.items.some((event: { kind: string }) => event.kind === "cancelled")).toBe(true);
  expect(events.items.some((event: { kind: string }) => event.kind === "resumed")).toBe(true);
});

test("shared Settings owns appearance/language and preserves keyboard focus on a small screen", async ({ page }) => {
  await openEnglish(page);
  await page.setViewportSize({ width: 375, height: 720 });
  const trigger = page.getByRole("button", { name: "Settings", exact: true });
  await expect(page.getByRole("combobox", { name: "Appearance", exact: true })).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Development", exact: true }).click();
  await expect(dialog.getByText("Laboratory API", { exact: true })).toBeVisible();
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true); }
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await trigger.click();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("es");
  await expect(page.getByRole("combobox", { name: "Idioma", exact: true })).toHaveValue("es");
  await page.keyboard.press("Escape");
  // Reload without the test's one-time locale initialization to verify actual persistence.
  const other = await page.context().newPage();
  await other.goto("/");
  await expect(other.getByRole("heading", { name: "Explorar. Capturar. Verificar.", exact: true })).toBeVisible();
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.close();
});
