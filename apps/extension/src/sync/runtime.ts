import type {
  ExtensionRuntimeRequest,
  ExtensionRuntimeResponse,
} from "./types";
import type { LocaleCode } from "@denicheur-breizh/i18n";

export function sendExtensionRuntimeRequest(
  request: ExtensionRuntimeRequest,
): Promise<ExtensionRuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: ExtensionRuntimeResponse | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response) {
        reject(new Error("The extension background did not return a response."));
        return;
      }
      resolve(response);
    });
  });
}

export function requestImmediateSync(): Promise<ExtensionRuntimeResponse> {
  return sendExtensionRuntimeRequest({ type: "SYNC_NOW" });
}

export function requestIterationReset(deadlineAt?: number): Promise<ExtensionRuntimeResponse> {
  return sendExtensionRuntimeRequest({
    type: "RESET_ITERATION",
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}

export function requestActiveRecipeRefresh(): Promise<ExtensionRuntimeResponse> {
  return requestDefaultPlanRefresh();
}

export function requestDefaultPlanRefresh(): Promise<ExtensionRuntimeResponse> {
  return sendExtensionRuntimeRequest({ type: "REFRESH_DEFAULT_PLAN" });
}

export function requestPlanEvaluation(request: {
  runId: string;
  locale: LocaleCode;
  listingIds?: string[];
  force?: boolean;
}): Promise<ExtensionRuntimeResponse> {
  return sendExtensionRuntimeRequest({
    type: "QUEUE_PLAN_EVALUATION",
    ...request,
  });
}
