import { clearRecords } from "../storage/chromeStorage";
import { requestIterationReset } from "../sync/runtime";
import {
  DashboardRunnerBusyError,
  withDashboardRunnerLease,
} from "./DashboardApp";

const CLEAN_EXTENSION_ACTION = "clean-db";
const CLEAN_ALL_ACTION = "clean-all-data";

export async function handleIterationReset(): Promise<void> {
  const dashboardUrl = new URL(window.location.href);
  const action = dashboardUrl.searchParams.get("action");
  if (action !== CLEAN_EXTENSION_ACTION && action !== CLEAN_ALL_ACTION) return;

  const callbackUrl = parseLoopbackCallback(dashboardUrl.searchParams.get("callback"));
  const deadlineAt = parseDeadline(dashboardUrl.searchParams.get("deadline"));
  dashboardUrl.searchParams.delete("action");
  dashboardUrl.searchParams.delete("callback");
  dashboardUrl.searchParams.delete("deadline");
  window.history.replaceState(null, "", dashboardUrl);

  if (deadlineAt !== undefined && deadlineAt <= Date.now()) {
    await notify(callbackUrl, "error", "deadline-expired").catch(() => undefined);
    return;
  }

  try {
    await withDashboardRunnerLease(async () => {
      if (action === CLEAN_ALL_ACTION) {
        const reset = await requestIterationReset(deadlineAt);
        if (!reset.ok && reset.errorCode === "ACTIVE_RUN") {
          throw new DashboardRunnerBusyError();
        }
        if (!reset.ok) throw new Error(reset.error ?? "The coordinated iteration reset failed.");
      } else {
        await clearRecords();
      }
      await notify(callbackUrl, "ok");
    });
  } catch (error) {
    if (error instanceof DashboardRunnerBusyError) {
      await notify(callbackUrl, "busy", "active-run");
      return;
    }
    await notify(callbackUrl, "error", "reset-failure").catch(() => undefined);
    throw error;
  }
}

function parseDeadline(rawDeadline: string | null): number | undefined {
  if (!rawDeadline) return undefined;
  const deadlineAt = Number(rawDeadline);
  return Number.isSafeInteger(deadlineAt) && deadlineAt > 0 ? deadlineAt : undefined;
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
