import { expect, test, type Locator } from "@playwright/test";

import type { ListingDetail, ListingsPage } from "../../../packages/contracts/src/index.js";
import { E2E_API_URL, ingestListings, listingFixture, testToken } from "./realApiFixture.js";

const WEBP_FIXTURE = Buffer.from(
  "UklGRjQAAABXRUJQVlA4ICgAAABwAQCdASoQAAwAAUAmJaACdAFAAAD+6mX//UGf/6tD//lofrtzMAAA",
  "base64",
);

test("uses ready API media, falls back per photo, and clears the rendered dataset", async ({ page, request }, testInfo) => {
  const token = testToken(testInfo, "media-replica");
  const title = `Maison répliquée ${token}`;
  const sourceUrl = `https://fixtures.invalid/${token}/source.webp`;
  let sourceRequests = 0;
  const listing = listingFixture(token, "media", {
    title,
    imageUrl: sourceUrl,
    imageUrls: [sourceUrl],
  });
  await page.route(sourceUrl, (route) => {
    sourceRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "image/webp",
      headers: { "cache-control": "no-store" },
      body: WEBP_FIXTURE,
    });
  });
  await ingestListings(request, `web-media-${token}`, [listing]);

  const detailResponse = await request.get(
    `${E2E_API_URL}/v1/listings/leboncoin/${encodeURIComponent(listing.externalId)}`,
  );
  expect(detailResponse.ok()).toBe(true);
  const pendingDetail = await detailResponse.json() as ListingDetail;
  const pendingAsset = pendingDetail.imageAssets?.[0];
  expect(pendingAsset).toMatchObject({ sourceUrl, status: "pending" });

  await page.goto("/?view=properties&pmode=cards");
  const selectCard = page.getByRole("button", { name: `Afficher le détail de ${title}`, exact: true });
  const card = page.locator("article").filter({ has: selectCard });
  const cardImage = card.getByRole("img", { name: `Photo 1 sur 1 : ${title}`, exact: true });
  await expectLoadedImage(cardImage, sourceUrl);

  let failReplicas = false;
  const replicaRequests: string[] = [];
  await page.route(`${E2E_API_URL}/v1/media/${pendingAsset!.id}/**`, (route) => {
    replicaRequests.push(route.request().url());
    if (failReplicas) {
      void route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: "image/webp",
      headers: { "cache-control": "no-store", etag: '"fixture-etag"' },
      body: WEBP_FIXTURE,
    });
  });
  await page.route(`${E2E_API_URL}/v1/listings**`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as ListingsPage | ListingDetail;
    const readyAsset = {
      ...pendingAsset!,
      status: "ready" as const,
      thumbnailPath: `/v1/media/${pendingAsset!.id}/thumbnail.webp`,
      galleryPath: `/v1/media/${pendingAsset!.id}/gallery.webp`,
    };
    const decorated = "items" in payload
      ? { ...payload, items: payload.items.map((item) => item.id === pendingDetail.id ? { ...item, imageAssets: [readyAsset] } : item) }
      : payload.id === pendingDetail.id
        ? { ...payload, imageAssets: [readyAsset] }
        : payload;
    await route.fulfill({ response, json: decorated });
  });

  sourceRequests = 0;
  await page.reload();
  const readyCard = page.locator("article").filter({
    has: page.getByRole("button", { name: `Afficher le détail de ${title}`, exact: true }),
  });
  const readyImage = readyCard.getByRole("img", { name: `Photo 1 sur 1 : ${title}`, exact: true });
  const thumbnailUrl = `${E2E_API_URL}/v1/media/${pendingAsset!.id}/thumbnail.webp`;
  const galleryUrl = `${E2E_API_URL}/v1/media/${pendingAsset!.id}/gallery.webp`;
  await readyImage.scrollIntoViewIfNeeded();
  await expect(readyImage).toHaveAttribute("src", galleryUrl);
  await expect(readyImage).toHaveAttribute("srcset", `${thumbnailUrl} 480w, ${galleryUrl} 1280w`);
  await expect.poll(() => readyImage.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(replicaRequests.length).toBeGreaterThan(0);
  expect(sourceRequests).toBe(0);

  failReplicas = true;
  replicaRequests.length = 0;
  sourceRequests = 0;
  await page.reload();
  const fallbackCard = page.locator("article").filter({
    has: page.getByRole("button", { name: `Afficher le détail de ${title}`, exact: true }),
  });
  const fallbackImage = fallbackCard.getByRole("img", { name: `Photo 1 sur 1 : ${title}`, exact: true });
  await expectLoadedImage(fallbackImage, sourceUrl);
  expect(replicaRequests.length).toBeGreaterThan(0);
  expect(sourceRequests).toBeGreaterThan(0);

  // The suite intentionally shares one API process. The previous flow can leave
  // its durable evaluator in the final worker tick for a few milliseconds; wait
  // through that explicit safety rejection instead of weakening cleanup fencing.
  await expect.poll(async () => {
    const response = await request.post(`${E2E_API_URL}/v1/maintenance/collected-data/clear`, {
      data: { confirm: "clear-collected-data" },
    });
    if (response.ok()) return "cleared";

    const body = await response.json() as { error?: { code?: string; message?: string } };
    if (response.status() === 409 && body.error?.code === "ACTIVE_EVALUATION_EXECUTION") {
      return body.error.code;
    }
    throw new Error(`Cleanup failed with HTTP ${response.status()}: ${body.error?.code ?? "UNKNOWN"} ${body.error?.message ?? ""}`);
  }, {
    timeout: 15_000,
    intervals: [100, 250, 500, 1_000],
  }).toBe("cleared");
  await page.reload();
  await expect(page.getByText("Aucun bien dans cette vue.", { exact: true })).toBeVisible();
});

async function expectLoadedImage(image: Locator, expectedSrc: string): Promise<void> {
  await expect(image).toBeVisible();
  await expect(async () => image.scrollIntoViewIfNeeded()).toPass({ timeout: 8_000 });
  await expect(image).toHaveAttribute("src", expectedSrc);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}
