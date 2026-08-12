import type { CDPSession } from "@playwright/test";

import {
  clearExtensionStorage,
  expect,
  extensionUrl,
  readExtensionStorage,
  test,
} from "./fixtures.js";

interface NativePopupMetrics {
  ready: boolean;
  fontsLoaded: boolean;
  innerWidth: number;
  innerHeight: number;
  htmlClientWidth: number;
  htmlScrollWidth: number;
  htmlClientHeight: number;
  htmlScrollHeight: number;
  shellWidth: number;
  shellHeight: number;
  contentClientHeight: number;
  contentScrollHeight: number;
  contentOverflow: number;
  contentChildrenInside: boolean;
  progressVisible: boolean;
  recordCountText: string;
  actionCount: number;
  actionLabels: string[];
  actionsInsideViewport: boolean;
  searchHref: string | null;
  actionWidth: number;
  actionHeight: number;
}

interface ChildCdpResponse<T> {
  id: number;
  result?: T;
  error?: { message: string };
}

interface RuntimeEvaluation<T> {
  result: { value?: T; description?: string };
  exceptionDetails?: { text: string };
}

interface ChildCdpClient {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const NATIVE_POPUP_METRICS_EXPRESSION = `(() => {
  const shell = document.querySelector(".popup-shell");
  const content = document.querySelector(".popup-content");
  const status = document.querySelector(".popup-status");
  const progress = document.querySelector(".popup-progress");
  const actions = Array.from(document.querySelectorAll(".popup-actions .btn"));
  const primaryAction = actions[0];
  const searchAction = document.querySelector(".popup-actions a.btn");
  if (
    !(shell instanceof HTMLElement)
    || !(content instanceof HTMLElement)
    || !(status instanceof HTMLElement)
    || !(progress instanceof HTMLElement)
    || !(primaryAction instanceof HTMLElement)
  ) return null;

  const shellBox = shell.getBoundingClientRect();
  const contentBox = content.getBoundingClientRect();
  const statusBox = status.getBoundingClientRect();
  const progressBox = progress.getBoundingClientRect();
  const actionBox = primaryAction.getBoundingClientRect();
  const isInside = (child, parent) => (
    child.top >= parent.top
    && child.right <= parent.right
    && child.bottom <= parent.bottom
    && child.left >= parent.left
  );
  return {
    ready: shell.getAttribute("aria-busy") === "false",
    fontsLoaded: document.fonts.status === "loaded",
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    htmlClientWidth: document.documentElement.clientWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
    htmlClientHeight: document.documentElement.clientHeight,
    htmlScrollHeight: document.documentElement.scrollHeight,
    shellWidth: shellBox.width,
    shellHeight: shellBox.height,
    contentClientHeight: content.clientHeight,
    contentScrollHeight: content.scrollHeight,
    contentOverflow: Math.max(0, content.scrollHeight - content.clientHeight),
    contentChildrenInside: isInside(statusBox, contentBox) && isInside(progressBox, contentBox),
    progressVisible: isInside(progressBox, contentBox),
    recordCountText: document.querySelector(".popup-count")?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
    actionCount: actions.length,
    actionLabels: actions.map((action) => action.textContent?.replace(/\\s+/g, " ").trim() ?? ""),
    actionsInsideViewport: actions.every((action) => {
      const box = action.getBoundingClientRect();
      return box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight && box.left >= 0;
    }),
    searchHref: searchAction instanceof HTMLAnchorElement ? searchAction.href : null,
    actionWidth: actionBox.width,
    actionHeight: actionBox.height,
  };
})()`;

test.describe("Denicheur extension UX regressions", () => {
  test("keeps the completed native action popup readable without internal overflow", async ({
    context,
    page,
    extensionId,
  }) => {
    const searchUrl = "https://www.leboncoin.fr/recherche?category=9&locations=Finist%C3%A8re";
    const popupUrl = extensionUrl(extensionId, "popup.html");
    const browserSession = await context.newCDPSession(page);
    let popupTargetId: string | undefined;
    let popupSessionId: string | undefined;

    try {
      const serviceWorker = context.serviceWorkers()[0]
        ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
      await serviceWorker.evaluate(async ({ searchUrl }) => {
        const records = Array.from({ length: 71 }, (_, index) => {
          const listingId = String(3_200_000_000 + index);
          return {
            id: listingId,
            source: "leboncoin",
            listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${listingId}`,
            title: `Popup fixture ${index + 1}`,
            features: [],
            scrapedAt: "2026-07-18T10:00:00.000Z",
            searchRunId: "popup-completed",
            status: "detailed",
            rawTextSample: `Popup fixture ${index + 1}`,
          };
        });
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          "denicheur:locale": "en",
          "denicheur:crawler:run": {
            id: "popup-completed",
            status: "completed",
            searchUrl,
            target: 70,
            found: 70,
            pagesVisited: 2,
            collected: 70,
            evaluated: 0,
            relevant: 0,
            notRelevant: 0,
            review: 0,
            filterWarnings: [],
            intelligenceStatus: "idle",
            message: { id: "run.collectedDetailed", values: { count: 70 } },
          },
          "denicheur:crawler:records": records,
        });
      }, { searchUrl });
      await serviceWorker.evaluate(async () => chrome.action.openPopup());

      await expect.poll(async () => {
        const { targetInfos } = await browserSession.send("Target.getTargets");
        return targetInfos.some((target) => target.type === "page" && target.url === popupUrl);
      }, { message: "native extension popup target should open" }).toBe(true);

      const { targetInfos } = await browserSession.send("Target.getTargets");
      const popupTarget = targetInfos.find(
        (target) => target.type === "page" && target.url === popupUrl,
      );
      if (!popupTarget) throw new Error(`Native popup target not found: ${popupUrl}`);
      popupTargetId = popupTarget.targetId;

      const attached = await browserSession.send("Target.attachToTarget", {
        targetId: popupTargetId,
        // Playwright cannot address a flat child session directly.
        flatten: false,
      });
      popupSessionId = attached.sessionId;
      const popupClient = createChildCdpClient(browserSession, popupSessionId);
      await popupClient.send("Runtime.enable");

      await expect.poll(async () => {
        const metrics = await evaluateInChild<NativePopupMetrics | null>(
          popupClient,
          NATIVE_POPUP_METRICS_EXPRESSION,
        );
        if (!metrics) return null;
        return {
          ready: metrics.ready,
          fontsLoaded: metrics.fontsLoaded,
          innerWidth: metrics.innerWidth,
          htmlClientWidth: metrics.htmlClientWidth,
          htmlScrollWidth: metrics.htmlScrollWidth,
          shellWidth: metrics.shellWidth,
          recordCountText: metrics.recordCountText,
          actionCount: metrics.actionCount,
        };
      }, { message: "native popup should settle at the intended 360px width" }).toEqual({
        ready: true,
        fontsLoaded: true,
        innerWidth: 360,
        htmlClientWidth: 360,
        htmlScrollWidth: 360,
        shellWidth: 360,
        recordCountText: "71 records",
        actionCount: 3,
      });

      const metrics = await evaluateInChild<NativePopupMetrics | null>(
        popupClient,
        NATIVE_POPUP_METRICS_EXPRESSION,
      );
      if (!metrics) throw new Error("Native popup rendered without its shell/actions");
      expect(metrics.innerHeight).toBeGreaterThanOrEqual(324);
      expect(metrics.innerHeight).toBeLessThanOrEqual(600);
      expect(metrics.shellHeight).toBeGreaterThanOrEqual(324);
      expect(metrics.shellHeight).toBeLessThanOrEqual(580);
      expect(metrics.htmlScrollHeight).toBeLessThanOrEqual(metrics.htmlClientHeight);
      expect(metrics.contentOverflow).toBe(0);
      expect(metrics.contentClientHeight).toBe(metrics.contentScrollHeight);
      expect(metrics.contentChildrenInside).toBe(true);
      expect(metrics.progressVisible).toBe(true);
      expect(metrics.actionCount).toBe(3);
      expect(metrics.actionLabels).toEqual(["Sync now", "Open dashboard", "Open search"]);
      expect(metrics.actionsInsideViewport).toBe(true);
      expect(metrics.searchHref).toBe(searchUrl);
      expect(metrics.actionWidth).toBeGreaterThanOrEqual(300);
      expect(metrics.actionHeight).toBeLessThanOrEqual(44);
    } finally {
      if (popupSessionId) {
        await browserSession.send("Target.detachFromTarget", {
          sessionId: popupSessionId,
        }).catch(() => undefined);
      }
      if (popupTargetId) {
        await browserSession.send("Target.closeTarget", {
          targetId: popupTargetId,
        }).catch(() => undefined);
      }
      await browserSession.detach().catch(() => undefined);
    }
  });

  test("keeps the dashboard usable at 320px and persists an explicit theme", async ({
    page,
    extensionId,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page, "fr");
    await page.evaluate(async () => chrome.storage.sync.clear());
    await page.reload();

    await expect(page.getByRole("heading", { name: "Filtres de recherche" })).toBeVisible();
    await expectNoUnexpectedHorizontalOverflow(page);

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Aller au contenu principal" })).toBeFocused();

    const theme = page.getByRole("combobox", { name: "Thème de l’interface" });
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => page.evaluate(async () => {
      const values = await chrome.storage.sync.get("denicheur:theme");
      return values["denicheur:theme"];
    })).toBe("dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(theme).toHaveValue("dark");
    await expectNoUnexpectedHorizontalOverflow(page);
  });

  test("preserves a dirty filter draft when storage changes externally", async ({
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page);
    await page.reload();

    const location = page.getByRole("textbox", { name: "Location", exact: true });
    await location.fill("Saved location");
    await page.getByRole("button", { name: "Save filters" }).click();
    await expect(page.getByRole("status")).toContainText("Filters saved.");

    await location.fill("Local draft");
    await page.evaluate(async () => {
      const key = "denicheur:crawler:filters";
      const values = await chrome.storage.local.get(key);
      await chrome.storage.local.set({
        [key]: { ...(values[key] as Record<string, unknown>), locationQuery: "External value" },
      });
    });

    await expect(location).toHaveValue("Local draft");
    await expect(page.getByRole("status")).toContainText(
      "External changes were detected. Your local draft was preserved.",
    );

    await page.getByRole("button", { name: "Save filters" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const values = await chrome.storage.local.get("denicheur:crawler:filters");
      return (values["denicheur:crawler:filters"] as { locationQuery?: string } | undefined)?.locationQuery;
    })).toBe("Local draft");
  });

  test("paginates and searches every stored result instead of truncating the list", async ({
    context,
    page,
    extensionId,
  }) => {
    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page);
    await page.evaluate(async () => {
      const records = Array.from({ length: 55 }, (_, index) => {
        const number = index + 1;
        return {
          id: `fixture-${number}`,
          source: "leboncoin",
          listingUrl: `https://www.leboncoin.fr/ad/ventes_immobilieres/${3_100_000_000 + number}`,
          title: `Fixture property ${number}`,
          location: number === 55 ? "Unique Plouha" : "Bretagne",
          imageUrl: number === 1 ? "https://img.leboncoin.fr/fixture-1-a.png" : undefined,
          imageUrls: number === 1 ? [
            "https://img.leboncoin.fr/fixture-1-a.png",
            "https://img.leboncoin.fr/fixture-1-b.png",
          ] : undefined,
          features: [],
          scrapedAt: "2026-07-17T10:00:00.000Z",
          searchRunId: "ux-pagination",
          status: "listing",
          rawTextSample: `Fixture property ${number}`,
        };
      });
      await chrome.storage.local.set({ "denicheur:crawler:records": records });
    });
    await page.reload();

    await expect(page.getByRole("listitem")).toHaveCount(24);
    await expect(page.getByRole("navigation", { name: "Page 1 of 3" })).toBeVisible();
    const firstRecord = page.getByRole("listitem").filter({
      has: page.getByRole("heading", { name: "Fixture property 1" }),
    });
    const firstImage = firstRecord.getByRole("img", { name: "Image 1 of 2: Fixture property 1" });
    await expect(firstImage).toBeVisible();
    await expect(firstImage).toHaveJSProperty("naturalWidth", 1);
    await firstRecord.getByRole("button", { name: "Next image for Fixture property 1" }).click();
    await expect(firstRecord.getByRole("img", { name: "Image 2 of 2: Fixture property 1" })).toBeVisible();
    await firstRecord.getByRole("button", { name: "Previous image for Fixture property 1" }).click();
    await expect(firstRecord.getByRole("img", { name: "Image 1 of 2: Fixture property 1" })).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/(?:\?|&)page=2(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(24);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/(?:\?|&)page=3(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(7);

    const recordsPerPage = page.getByRole("combobox", { name: "Listings per page" });
    await recordsPerPage.selectOption("12");
    await expect(recordsPerPage).toHaveValue("12");
    await expect(page).toHaveURL(/(?:\?|&)pageSize=12(?:&|$)/u);
    await expect(page).not.toHaveURL(/(?:\?|&)page=/u);
    await expect(page.getByRole("listitem")).toHaveCount(12);
    await expect(page.getByRole("navigation", { name: "Page 1 of 5" })).toBeVisible();

    await page.reload();
    await expect(recordsPerPage).toHaveValue("12");
    await expect(page.getByRole("listitem")).toHaveCount(12);

    await recordsPerPage.selectOption("48");
    await expect(page).toHaveURL(/(?:\?|&)pageSize=48(?:&|$)/u);
    await expect(page.getByRole("listitem")).toHaveCount(48);
    await expect(page.getByRole("navigation", { name: "Page 1 of 2" })).toBeVisible();

    await page.reload();
    await expect(recordsPerPage).toHaveValue("48");
    await expect(page.getByRole("listitem")).toHaveCount(48);

    const popup = await context.newPage();
    await popup.goto(extensionUrl(extensionId, "popup.html"));
    await popup.getByRole("button", { name: "Open dashboard" }).click();
    await expect.poll(() => popup.isClosed()).toBe(true);
    await expect.poll(() => context.pages().filter((candidate) => {
      const url = new URL(candidate.url());
      return url.protocol === "chrome-extension:" && url.pathname === "/dashboard.html";
    }).length).toBe(1);
    await expect(page).toHaveURL(/(?:\?|&)pageSize=48(?:&|$)/u);
    await expect(page).not.toHaveURL(/(?:\?|&)page=/u);

    await page.getByRole("searchbox", { name: "Search stored listings" }).fill("Unique Plouha");
    await expect(page.getByRole("heading", { name: "Fixture property 55" })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page).toHaveURL(/(?:\?|&)q=Unique\+Plouha(?:&|$)/u);
    await expect(page).not.toHaveURL(/(?:\?|&)page=/u);
  });

  test("re-evaluates stored listings through a durable default-plan execution", async ({
    context,
    page,
    extensionId,
  }) => {
    const apiBaseUrl = "http://127.0.0.1:14310";
    const planId = "recovery-plan";
    const executionId = "recovery-execution";
    const createdAt = "2026-07-19T10:00:00.000Z";
    const completedAt = "2026-07-19T10:02:00.000Z";
    const recipe = {
      id: "recovery-recipe",
      version: 1,
      name: "Recovery fixture",
      threshold: 70,
      enabled: true,
      criteria: [{
        id: "garden",
        name: "Garden",
        description: "The listing explicitly describes a garden.",
        weight: 100,
        required: true,
        evidenceRequired: true,
      }],
    };
    const plan = {
      id: planId,
      version: 1,
      name: "Recovery plan",
      operator: "all",
      combinerVersion: "tri-state-v1",
      recipes: [{ recipeId: recipe.id, recipeVersion: recipe.version, recipe }],
      isDefault: true,
      createdAt,
    };
    const canonicalPlan = {
      ...plan,
      recipes: [{
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        recipe: {
          ...recipe,
          active: false,
          createdAt,
          enabled: undefined,
        },
      }],
    };
    const execution = {
      id: executionId,
      runId: "recovery-run",
      planId,
      planVersion: 1,
      locale: "en",
      status: "completed",
      listingIds: [],
      force: true,
      createdAt,
      startedAt: createdAt,
      completedAt,
      counters: {
        total: 2,
        processed: 2,
        relevant: 1,
        notRelevant: 1,
        review: 0,
        failed: 0,
      },
      budget: {
        limit: { providerCalls: 10, inputTokens: 100_000, outputTokens: 20_000, costMicroUsd: 1_000_000 },
        estimate: { providerCalls: 2, inputTokens: 2_000, outputTokens: 1_000, costMicroUsd: 10_000 },
        consumed: { providerCalls: 2, inputTokens: 1_000, outputTokens: 500, costMicroUsd: 5_000 },
      },
    };
    const executionRequests: Array<Record<string, unknown>> = [];
    const idempotencyKeys: string[] = [];

    await context.route(`${apiBaseUrl}/v1/evaluation-plans/default`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(canonicalPlan),
    }));
    await context.route(`${apiBaseUrl}/v1/ingestion/runs/recovery-run`, async (route) => {
      const payload = route.request().postDataJSON() as { listings?: unknown[] };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runId: "recovery-run",
          accepted: payload.listings?.length ?? 0,
          inserted: payload.listings?.length ?? 0,
          updated: 0,
          unchanged: 0,
        }),
      });
    });
    await context.route(`${apiBaseUrl}/v1/runs/recovery-run/evaluation-executions`, async (route) => {
      executionRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      idempotencyKeys.push(route.request().headers()["idempotency-key"] ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(execution),
      });
    });
    await context.route(`${apiBaseUrl}/v1/evaluation-executions/${executionId}`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(execution),
    }));
    await context.route(`${apiBaseUrl}/v1/evaluation-executions/${executionId}/results`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        executionId,
        items: [
          planResult({
            executionId,
            planId,
            recipeId: recipe.id,
            listingId: "leboncoin:3100000101",
            decision: "relevant",
            score: 90,
            verdict: "pass",
            summary: "A private garden is explicitly documented.",
            reason: "The listing describes a private garden.",
            evidence: ["Maison avec jardin"],
            evaluatedAt: completedAt,
          }),
          planResult({
            executionId,
            planId,
            recipeId: recipe.id,
            listingId: "leboncoin:3100000102",
            decision: "not-relevant",
            score: 30,
            verdict: "fail",
            summary: "The garden requirement is not documented.",
            reason: "No private garden is described.",
            evidence: ["Appartement sans extérieur"],
            evaluatedAt: completedAt,
          }),
        ],
      }),
    }));

    await page.goto(extensionUrl(extensionId, "dashboard.html"));
    await clearExtensionStorage(page, "en");
    await page.evaluate(async ({ plan, recipe }) => {
      const previousEvaluation = (listingId: string) => ({
        listingId,
        decision: "relevant",
        score: 90,
        summary: "Previous valid evaluation.",
        criteria: [{
          criterionId: "garden",
          verdict: "pass",
          reason: "The previous snapshot described a garden.",
          evidence: ["Garden"],
        }],
        missingData: [],
        evaluatedAt: "2026-07-19T09:00:00.000Z",
        evaluator: { provider: "openai", model: "gpt-5-mini", version: "filter-v1" },
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        locale: "en",
      });
      await chrome.storage.local.set({
        "denicheur:intelligence:recipe": recipe,
        "denicheur:intelligence:plan": plan,
        "denicheur:sync:state": {
          version: 2,
          status: "idle",
          queue: [],
          syncedFingerprints: {},
          activePlan: {
            status: "cached",
            planId: plan.id,
            planVersion: plan.version,
            fetchedAt: "2026-07-19T09:30:00.000Z",
          },
          evaluationQueue: [],
          activeRecipe: {
            status: "cached",
            recipeId: recipe.id,
            recipeVersion: recipe.version,
            fetchedAt: "2026-07-19T09:30:00.000Z",
          },
        },
        "denicheur:crawler:run": {
          id: "recovery-run",
          status: "completed",
          target: 2,
          found: 2,
          pagesVisited: 1,
          collected: 2,
          evaluated: 1,
          relevant: 1,
          notRelevant: 0,
          review: 0,
          filterWarnings: [],
          intelligenceStatus: "partial",
          intelligenceError: { id: "error.apiInvalidOutput" },
          message: {
            id: "run.intelligencePartial",
            values: { evaluated: 1, total: 2, pending: 1 },
          },
        },
        "denicheur:crawler:records": [
          {
            id: "3100000101",
            source: "leboncoin",
            listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/3100000101",
            title: "Successful fixture",
            description: "Maison avec jardin.",
            features: ["Garden"],
            scrapedAt: "2026-07-19T08:00:00.000Z",
            searchRunId: "recovery-run",
            status: "detailed",
            rawTextSample: "Maison avec jardin",
            evaluation: previousEvaluation("3100000101"),
          },
          {
            id: "3100000102",
            source: "leboncoin",
            listingUrl: "https://www.leboncoin.fr/ad/ventes_immobilieres/3100000102",
            title: "Pending fixture",
            description: "Appartement sans extérieur.",
            features: [],
            scrapedAt: "2026-07-19T08:01:00.000Z",
            searchRunId: "recovery-run",
            status: "detailed",
            rawTextSample: "Appartement sans extérieur",
            evaluation: previousEvaluation("3100000102"),
          },
        ],
      });
    }, { plan, recipe });
    await page.reload();

    const intelligencePanel = page.locator("details.intelligence-panel");
    if (await intelligencePanel.getAttribute("open") === null) {
      await intelligencePanel.locator("summary").click();
    }
    await expect(page.getByText("Recovery plan", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reevaluate stored" }).click();

    await expect.poll(() => executionRequests).toEqual([expect.objectContaining({
      locale: "en",
      planId,
      planVersion: 1,
      force: true,
    })]);
    expect(executionRequests[0]).not.toHaveProperty("listingIds");
    expect(idempotencyKeys).toEqual([expect.stringMatching(/^extension-/u)]);

    await expect.poll(async () => {
      const storage = await readExtensionStorage(page);
      return storage["denicheur:crawler:records"];
    }).toEqual([
      expect.objectContaining({
        id: "3100000101",
        evaluation: expect.objectContaining({ evaluatedAt: "2026-07-19T09:00:00.000Z" }),
        planEvaluation: expect.objectContaining({
          executionId,
          planId,
          decision: "relevant",
          steps: [expect.objectContaining({
            recipeId: recipe.id,
            status: "succeeded",
            evaluator: { provider: "openai", model: "gpt-test", version: "3.0.0" },
          })],
        }),
      }),
      expect.objectContaining({
        id: "3100000102",
        evaluation: expect.objectContaining({ evaluatedAt: "2026-07-19T09:00:00.000Z" }),
        planEvaluation: expect.objectContaining({
          executionId,
          planId,
          decision: "not-relevant",
          steps: [expect.objectContaining({ status: "succeeded" })],
        }),
      }),
    ]);
    const persistedState = (await readExtensionStorage(page))["denicheur:sync:state"];
    expect(persistedState).toMatchObject({
      version: 2,
      activePlan: { status: "cached", planId, planVersion: 1 },
      evaluationQueue: [expect.objectContaining({
        runId: "recovery-run",
        planId,
        planVersion: 1,
        executionId,
        status: "completed",
      })],
    });
  });
});

interface PlanResultFixtureOptions {
  executionId: string;
  planId: string;
  recipeId: string;
  listingId: string;
  decision: "relevant" | "not-relevant" | "review";
  score: number | null;
  verdict: "pass" | "fail" | "unknown";
  summary: string;
  reason: string;
  evidence: string[];
  evaluatedAt: string;
}

function planResult(options: PlanResultFixtureOptions): Record<string, unknown> {
  return {
    executionId: options.executionId,
    listingId: options.listingId,
    planId: options.planId,
    planVersion: 1,
    decision: options.decision,
    score: options.score,
    summary: options.summary,
    evaluatedAt: options.evaluatedAt,
    steps: [{
      recipeId: options.recipeId,
      recipeVersion: 1,
      status: "succeeded",
      evaluation: {
        listingId: options.listingId,
        decision: options.decision,
        score: options.score,
        summary: options.summary,
        criteria: [{
          criterionId: "garden",
          verdict: options.verdict,
          reason: options.reason,
          evidence: options.evidence,
        }],
        missingData: [],
        evaluatedAt: options.evaluatedAt,
      },
      evaluator: { provider: "openai", model: "gpt-test", version: "3.0.0" },
    }],
  };
}

async function expectNoUnexpectedHorizontalOverflow(
  page: import("@playwright/test").Page,
): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 320, scrollWidth: 320 });
}

function createChildCdpClient(
  browserSession: CDPSession,
  childSessionId: string,
): ChildCdpClient {
  let nextCommandId = 0;
  return {
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = ++nextCommandId;
      return new Promise<T>((resolve, reject) => {
        const onMessage = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== childSessionId) return;
          const payload = JSON.parse(event.message) as ChildCdpResponse<T>;
          if (payload.id !== id) return;
          browserSession.off("Target.receivedMessageFromTarget", onMessage);
          if (payload.error) {
            reject(new Error(`${method}: ${payload.error.message}`));
            return;
          }
          resolve(payload.result as T);
        };

        browserSession.on("Target.receivedMessageFromTarget", onMessage);
        void browserSession.send("Target.sendMessageToTarget", {
          sessionId: childSessionId,
          message: JSON.stringify({ id, method, params }),
        }).catch((error: unknown) => {
          browserSession.off("Target.receivedMessageFromTarget", onMessage);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    },
  };
}

async function evaluateInChild<T>(
  client: ChildCdpClient,
  expression: string,
): Promise<T> {
  const response = await client.send<RuntimeEvaluation<T>>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`Popup evaluation failed: ${response.exceptionDetails.text}`);
  }
  return response.result.value as T;
}
