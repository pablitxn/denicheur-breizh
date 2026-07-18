import { defineBackground } from "wxt/utils/define-background";
import {
  readSyncResponse,
  refreshCachedActiveRecipe,
  scheduleExtensionSync,
} from "../src/sync/controller";
import { isExtensionRuntimeRequest } from "../src/sync/types";
import { CRAWLER_STORAGE_KEYS } from "../src/storage/chromeStorage";

export const SYNC_ALARM_NAME = "denicheur-api-sync";

export default defineBackground(() => {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

  void ensureSyncAlarm();
  void scheduleExtensionSync();

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) void scheduleExtensionSync();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!(CRAWLER_STORAGE_KEYS.run in changes) && !(CRAWLER_STORAGE_KEYS.records in changes)) return;
    void scheduleExtensionSync();
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!isExtensionRuntimeRequest(request)) return undefined;

    const operation = request.type === "SYNC_NOW"
      ? scheduleExtensionSync(true)
      : request.type === "REFRESH_ACTIVE_RECIPE"
        ? refreshCachedActiveRecipe()
        : readSyncResponse();
    void operation
      .then(sendResponse)
      .catch(async (error) => sendResponse({
        ...(await readSyncResponse()),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  });
});

export async function ensureSyncAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(SYNC_ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
  }
}
