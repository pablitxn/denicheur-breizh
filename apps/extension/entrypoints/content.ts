import { defineContentScript } from "wxt/utils/define-content-script";
import { LeboncoinNativeDriver } from "../src/automation/leboncoinNativeDriver";
import {
  collectListingDetail,
  collectListingSummaries,
  detectSiteChallenge,
  isDetailExtractionReady,
  isSearchExtractionReady,
} from "../src/lib/leboncoinExtractors";
import { isContentRequest } from "../src/lib/messages";
import type { ContentResponse, NativeSearchResponse } from "../src/lib/messages";

const leboncoinHosts = ["https://www.leboncoin.fr", "https://leboncoin.fr"];
const supportedPaths = [
  "/",
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
    const nativeDriver = new LeboncoinNativeDriver();

    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, sendResponse: (response: ContentResponse) => void) => {
        if (sender.id !== chrome.runtime.id || !isContentRequest(message)) {
          return false;
        }

        if (message.type === "LBC_COLLECT_SEARCH_RESULTS") {
          const queuedFailure = nativeDriver.getQueuedActionFailure();
          if (queuedFailure) {
            sendResponse(queuedFailure);
            return true;
          }
          const challenge = detectSiteChallenge(document);
          const listings = challenge ? [] : collectListingSummaries(document, message.limit);
          sendResponse({
            type: "LBC_SEARCH_RESULTS",
            captcha: challenge?.type === "captcha",
            ready: !challenge && isSearchExtractionReady(document, listings),
            challenge,
            listings,
          });
          return true;
        }

        if (message.type === "LBC_COLLECT_DETAIL") {
          const queuedFailure = nativeDriver.getQueuedActionFailure();
          if (queuedFailure) {
            sendResponse(queuedFailure);
            return true;
          }
          const challenge = detectSiteChallenge(document);
          const detail = challenge ? undefined : collectListingDetail(document);
          sendResponse({
            type: "LBC_DETAIL",
            captcha: challenge?.type === "captcha",
            ready: detail ? isDetailExtractionReady(detail, document) : false,
            challenge,
            detail,
          });
          return true;
        }

        if (message.type === "LBC_PREPARE_HOME_SEARCH") {
          void nativeDriver.prepareHomeSearch(message.filters).then(
            sendResponse,
            (error) => sendResponse(nativeContentError("home-prepared", error)),
          );
          return true;
        }

        if (message.type === "LBC_SUBMIT_HOME_SEARCH") {
          const action = nativeDriver.armHomeSearchSubmission();
          sendResponse(action.response);
          void action.execute().catch((error) => nativeDriver.recordQueuedActionFailure("home-submitted", error));
          return true;
        }

        if (message.type === "LBC_PREPARE_RESULTS_FILTERS") {
          void nativeDriver.prepareResultsFilters(message.filters).then(
            sendResponse,
            (error) => sendResponse(nativeContentError("results-prepared", error)),
          );
          return true;
        }

        if (message.type === "LBC_APPLY_RESULTS_FILTERS") {
          const action = nativeDriver.armResultsFilterApplication();
          sendResponse(action.response);
          void action.execute().catch((error) => nativeDriver.recordQueuedActionFailure("results-applied", error));
          return true;
        }

        if (message.type === "LBC_PREPARE_NEXT_RESULTS_PAGE") {
          void nativeDriver.prepareNextResultsPage().then(
            sendResponse,
            (error) => sendResponse(nativeContentError("pagination-prepared", error)),
          );
          return true;
        }

        if (message.type === "LBC_GO_NEXT_RESULTS_PAGE") {
          const action = nativeDriver.armNextResultsPage();
          sendResponse(action.response);
          void action.execute().catch((error) => nativeDriver.recordQueuedActionFailure("pagination-advanced", error));
          return true;
        }

        return false;
      },
    );
  },
});

export function nativeContentError(
  phase: NativeSearchResponse["phase"],
  error: unknown,
): NativeSearchResponse {
  return {
    type: "LBC_NATIVE_SEARCH_RESULT",
    phase,
    ok: false,
    applied: [],
    omitted: [],
    warnings: [],
    error: error instanceof Error ? error.message : "Native Leboncoin form interaction failed.",
  };
}
