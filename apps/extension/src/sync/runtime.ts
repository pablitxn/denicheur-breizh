import type {
  ExtensionRuntimeRequest,
  ExtensionRuntimeResponse,
} from "./types";

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

export function requestActiveRecipeRefresh(): Promise<ExtensionRuntimeResponse> {
  return sendExtensionRuntimeRequest({ type: "REFRESH_ACTIVE_RECIPE" });
}
