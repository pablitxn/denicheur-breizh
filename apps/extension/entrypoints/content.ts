import { defineContentScript } from "wxt/utils/define-content-script";
import {
  collectListingDetail,
  collectListingSummaries,
  detectSiteChallenge,
} from "../src/lib/leboncoinExtractors";
import type { ContentRequest, ContentResponse } from "../src/lib/messages";

const leboncoinHosts = ["https://www.leboncoin.fr", "https://leboncoin.fr"];
const supportedPaths = [
  "/recherche*",
  "/ad/ventes_immobilieres/*",
  "/ad/locations/*",
  "/ad/colocations/*",
  "/ad/bureaux_commerces/*",
  "/ad/immobilier_neuf/*",
  "/ventes_immobilieres/*",
  "/locations/*",
  "/colocations/*",
  "/bureaux_commerces/*",
  "/immobilier_neuf/*",
];

export default defineContentScript({
  matches: leboncoinHosts.flatMap((host) => supportedPaths.map((path) => `${host}${path}`)),
  runAt: "document_idle",
  main() {
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, sendResponse: (response: ContentResponse) => void) => {
        if (sender.id !== chrome.runtime.id || !isContentRequest(message)) {
          return false;
        }

        if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
          const challenge = detectSiteChallenge(document);
          sendResponse({
            type: "LBC_SEARCH_RESULTS",
            captcha: challenge?.type === "captcha",
            challenge,
            listings: challenge ? [] : collectListingSummaries(document, message.limit),
          });
          return true;
        }

        if (message.type === "LBC_COLLECT_DETAIL") {
          const challenge = detectSiteChallenge(document);
          sendResponse({
            type: "LBC_DETAIL",
            captcha: challenge?.type === "captcha",
            challenge,
            detail: challenge ? undefined : collectListingDetail(document),
          });
          return true;
        }

        return false;
      },
    );
  },
});

function isContentRequest(message: unknown): message is ContentRequest {
  if (!message || typeof message !== "object" || !("type" in message)) return false;
  if (message.type === "LBC_COLLECT_DETAIL") return true;

  return (
    message.type === "LBC_COLLECT_SEARCH_RESULTS" &&
    "limit" in message &&
    typeof message.limit === "number" &&
    Number.isInteger(message.limit) &&
    message.limit >= 1 &&
    message.limit <= 20
  );
}
