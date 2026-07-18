import { clearRecords } from "../storage/chromeStorage";
import { hasLiveDashboardRunner } from "./DashboardApp";

const CLEAN_ACTION = "clean-db";

export async function handleIterationReset(): Promise<void> {
  const dashboardUrl = new URL(window.location.href);
  if (dashboardUrl.searchParams.get("action") !== CLEAN_ACTION) return;

  const callbackUrl = parseLoopbackCallback(dashboardUrl.searchParams.get("callback"));
  dashboardUrl.searchParams.delete("action");
  dashboardUrl.searchParams.delete("callback");
  window.history.replaceState(null, "", dashboardUrl);

  try {
    if (await hasLiveDashboardRunner(false)) {
      await notify(callbackUrl, "busy", "active-run");
      return;
    }

    await clearRecords();
    await notify(callbackUrl, "ok");
  } catch (error) {
    await notify(callbackUrl, "error", "storage-failure").catch(() => undefined);
    throw error;
  }
}

function parseLoopbackCallback(rawCallback: string | null): URL | undefined {
  if (!rawCallback) return undefined;

  try {
    const callbackUrl = new URL(rawCallback);
    if (
      callbackUrl.protocol !== "http:" ||
      callbackUrl.hostname !== "127.0.0.1" ||
      callbackUrl.username ||
      callbackUrl.password
    ) {
      return undefined;
    }
    return callbackUrl;
  } catch {
    return undefined;
  }
}

async function notify(
  callbackUrl: URL | undefined,
  status: "ok" | "busy" | "error",
  reason?: string,
): Promise<void> {
  if (!callbackUrl) return;
  callbackUrl.searchParams.set("status", status);
  if (reason) callbackUrl.searchParams.set("reason", reason);
  await fetch(callbackUrl, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
  });
}
