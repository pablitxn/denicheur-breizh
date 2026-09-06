import { expect, extensionUrl, test } from "./fixtures.js";

const API_BASE_URL = "http://127.0.0.1:14310";

test.describe("extension state coordination", () => {
  test.beforeEach(async ({ context }) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    await worker.evaluate(async (apiBaseUrl) => {
      await chrome.storage.local.set({
        "denicheur:locale": "en",
        "denicheur:runtime-api-base-url": apiBaseUrl,
      });
    }, API_BASE_URL);
  });

  test("shares the crawler state lock between the dashboard and service worker", async ({ context, page, extensionId }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const lockName = "denicheur:crawler:state";
    await worker.evaluate(async (name) => {
      const scope = globalThis as typeof globalThis & { releaseTestStateLock?: () => void };
      await new Promise<void>((acquired) => {
        void navigator.locks.request(name, { mode: "exclusive" }, async () => {
          const released = new Promise<void>((resolve) => { scope.releaseTestStateLock = resolve; });
          acquired();
          await released;
        });
      });
    }, lockName);

    try {
      expect(await page.evaluate((name) => navigator.locks.request(name, { ifAvailable: true }, (lock) => Boolean(lock)), lockName)).toBe(false);
    } finally {
      await worker.evaluate(() => {
        const scope = globalThis as typeof globalThis & { releaseTestStateLock?: () => void };
        scope.releaseTestStateLock?.();
        delete scope.releaseTestStateLock;
      });
    }
    expect(await page.evaluate((name) => navigator.locks.request(name, { mode: "exclusive" }, (lock) => Boolean(lock)), lockName)).toBe(true);
  });

  test("recovers a collecting run when its owning dashboard closes", async ({ context, page, extensionId }) => {
    const owner = await context.newPage();
    await owner.goto(extensionUrl(extensionId, "dashboard.html"));
    await expect(owner.locator(".control-surface")).toHaveAttribute("aria-busy", "false");
    await owner.evaluate(async () => {
      await new Promise<void>((acquired) => {
        void navigator.locks.request("denicheur:crawler:dashboard-runner", async () => {
          acquired();
          await new Promise(() => undefined);
        });
      });
      const tab = await chrome.tabs.getCurrent();
      await chrome.storage.local.set({
        "denicheur:locale": "en",
        "denicheur:crawler:run": {
          id: "owner-release-fixture", status: "collecting-search", dashboardTabId: tab?.id,
          target: 1, found: 0, pagesVisited: 0, collected: 0, evaluated: 0,
          relevant: 0, notRelevant: 0, review: 0, filterWarnings: [], intelligenceStatus: "idle",
        },
        "denicheur:crawler:records": [],
      });
    });
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await expect(page.getByText("This collection is controlled from another dashboard. Progress updates here automatically.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open active dashboard" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Collection in progress", exact: true })).toBeDisabled();

    await owner.close();

    await expect.poll(() => page.evaluate(async () => {
      const values = await chrome.storage.local.get("denicheur:crawler:run");
      return (values["denicheur:crawler:run"] as { status?: string } | undefined)?.status;
    })).toBe("cancelled");
    await expect(page.getByRole("button", { name: "Start collection", exact: true })).toBeEnabled();
    // Retain the worker until automatic synchronization persists the terminal
    // snapshot; closing early would leave an active fixture run in the API.
    await expect.poll(async () => {
      const response = await context.request.get(`${API_BASE_URL}/v1/runs/owner-release-fixture`);
      if (response.status() === 404) return { status: "not-ingested" };
      expect(response.ok()).toBe(true);
      return response.json();
    }, { timeout: 10_000, intervals: [100, 250, 500] }).toMatchObject({
      id: "owner-release-fixture", status: "cancelled", collected: 0,
    });
  });
});
