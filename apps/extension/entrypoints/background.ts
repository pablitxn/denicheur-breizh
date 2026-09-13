import { defineBackground } from "wxt/utils/define-background";
import {
  readSyncResponse,
  refreshCachedActiveRecipe,
  refreshCachedDefaultPlan,
  queueDefaultPlanEvaluation,
  resetExtensionIteration,
  scheduleExtensionSync,
} from "../src/sync/controller";
import { isExtensionRuntimeRequest } from "../src/sync/types";
import { CRAWLER_STORAGE_KEYS } from "../src/storage/chromeStorage";
import { SOURCE_RECORD_OUTBOX_KEY } from "../src/sync/sourceRecordOutbox";

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
    if (!(CRAWLER_STORAGE_KEYS.run in changes) && !(CRAWLER_STORAGE_KEYS.records in changes) && !(SOURCE_RECORD_OUTBOX_KEY in changes)) return;
    void scheduleExtensionSync();
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!isExtensionRuntimeRequest(request)) return undefined;

    const operation = request.type === "SYNC_NOW"
      ? scheduleExtensionSync(true)
      : request.type === "RESET_ITERATION"
        ? resetExtensionIteration(request.deadlineAt)
      : request.type === "REFRESH_ACTIVE_RECIPE"
          ? refreshCachedActiveRecipe()
          : request.type === "REFRESH_DEFAULT_PLAN"
            ? refreshCachedDefaultPlan()
            : request.type === "QUEUE_PLAN_EVALUATION"
              ? queueDefaultPlanEvaluation(request)
              : readSyncResponse();
    void operation
      .then(sendResponse)
      .catch(async (error) => sendResponse({
        ...(await readSyncResponse()),
        ok: false,
        catalogOk: false,
        error: error instanceof Error ? error.message : String(error),
        ...(typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
          ? { errorCode: error.code }
          : {}),
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
