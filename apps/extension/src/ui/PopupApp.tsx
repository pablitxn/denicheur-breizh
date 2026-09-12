import { AlertTriangle, Database, ExternalLink, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { useExtensionI18n } from "../i18n";
import type { ScrapeRun } from "../lib/types";
import { CRAWLER_STORAGE_KEYS, IDLE_RUN, loadCrawlerStateFields } from "../storage/chromeStorage";
import { requestImmediateSync } from "../sync/runtime";
import {
  EMPTY_SYNC_STATE,
  loadExtensionSyncState,
  SYNC_STORAGE_KEY,
} from "../sync/storage";
import type { ExtensionSyncState } from "../sync/types";
import type { ThemePreference } from "./theme";
import { ExtensionSettings } from "./ExtensionSettings";
import { updateStorageRefreshErrors } from "./storageRefresh";

interface PopupAppProps {
  initialThemePreference?: ThemePreference;
}

export function PopupApp({ initialThemePreference = "system" }: PopupAppProps) {
  const { formatNumber, resolveText, t } = useExtensionI18n();
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [recordCount, setRecordCount] = useState(0);
  const [syncState, setSyncState] = useState<ExtensionSyncState>(EMPTY_SYNC_STATE);
  const [syncPending, setSyncPending] = useState(false);
  const [syncError, setSyncError] = useState<unknown>();
  const [openingDashboard, setOpeningDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<unknown>();
  const [refreshErrors, setRefreshErrors] = useState<Partial<Record<"run" | "records" | "sync", string>>>({});
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let mounted = true;
    const refreshVersions = { run: 0, records: 0, sync: 0 };
    setLoadState("loading");
    setLoadError(undefined);
    setRefreshErrors({});

    void Promise.all([loadCrawlerStateFields(["run", "records"]), loadExtensionSyncState()])
      .then(([snapshot, storedSyncState]) => {
        if (!mounted) return;
        if (refreshVersions.run === 0) setRun(snapshot.run);
        if (refreshVersions.records === 0) setRecordCount(snapshot.records.length);
        if (refreshVersions.sync === 0) setSyncState(storedSyncState);
        setLoadState("ready");
      })
      .catch((caught) => {
        if (!mounted) return;
        setLoadError(caught instanceof Error ? caught.message : String(caught));
        setLoadState("error");
      });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      const changedFields = (["run", "records"] as const)
        .filter((field) => CRAWLER_STORAGE_KEYS[field] in changes);
      const syncChanged = SYNC_STORAGE_KEY in changes;
      if (changedFields.length === 0 && !syncChanged) return;
      for (const field of changedFields) refreshVersions[field] += 1;
      if (syncChanged) refreshVersions.sync += 1;
      const requestVersions = { ...refreshVersions };

      void Promise.allSettled([
        loadCrawlerStateFields(changedFields),
        syncChanged ? loadExtensionSyncState() : undefined,
      ])
        .then(([crawlerResult, syncResult]) => {
          if (!mounted) return;
          setRefreshErrors((current) => updateStorageRefreshErrors(
            current, changedFields, requestVersions, refreshVersions,
            crawlerResult.status === "rejected" ? crawlerResult.reason : undefined,
          ));
          if (crawlerResult.status === "fulfilled") {
            const snapshot = crawlerResult.value;
            if (changedFields.includes("run") && requestVersions.run === refreshVersions.run) setRun(snapshot.run);
            if (changedFields.includes("records") && requestVersions.records === refreshVersions.records) {
              setRecordCount(snapshot.records.length);
            }
          }
          if (syncChanged) {
            setRefreshErrors((current) => updateStorageRefreshErrors(
              current, ["sync"], requestVersions, refreshVersions,
              syncResult.status === "rejected" ? syncResult.reason : undefined,
            ));
            if (syncResult.status === "fulfilled" && syncResult.value && requestVersions.sync === refreshVersions.sync) {
              setSyncState(syncResult.value);
            }
          }
        });
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [retryToken]);

  async function openDashboard() {
    setOpeningDashboard(true);
    setDashboardError(false);
    try {
      const dashboardUrl = chrome.runtime.getURL("dashboard.html");
      const dashboards = await chrome.tabs.query({ url: `${dashboardUrl}*` });
      const existing = (isBusy || run.status === "paused-captcha"
        ? dashboards.find((tab) => tab.id === run.dashboardTabId)
        : undefined) ?? dashboards[0];
      if (existing?.id !== undefined) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: dashboardUrl, active: true });
      }
      window.close();
    } catch {
      setDashboardError(true);
    } finally {
      setOpeningDashboard(false);
    }
  }

  async function syncNow() {
    setSyncPending(true);
    setSyncError(undefined);
    try {
      const response = await requestImmediateSync();
      setSyncState(response.state);
      if (!response.ok) setSyncError(response.error ?? response.state.lastError ?? "API");
    } catch (caught) {
      setSyncError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncPending(false);
    }
  }

  const isBusy =
    run.status === "opening-search" ||
    run.status === "configuring-search" ||
    run.status === "collecting-search" ||
    run.status === "collecting-details" ||
    run.status === "evaluating";
  const progressMessage = resolveText(run.message, "popup.ready");
  const visibleLoadError = loadError ?? Object.values(refreshErrors)[0];
  const pendingSyncCount = syncState.queue.length + syncState.evaluationQueue.filter((entry) =>
    entry.status === "queued" || entry.status === "creating" || entry.status === "polling").length;

  return (
    <main className="popup-shell" aria-busy={loadState === "loading"}>
      <header className="popup-topbar">
        <div className="popup-head">
          <span className="extension-mark">DB</span>
          <div>
            <h1>{t("app.popupTitle")}</h1>
            <p>{t("app.popupSubtitle")}</p>
          </div>
        </div>
        <ExtensionSettings initialThemePreference={initialThemePreference} compact />
      </header>

      <div className="popup-content">
        {loadState === "loading" && (
          <div className="loading-state" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{t("popup.loading")}</span>
          </div>
        )}

        {loadState !== "loading" && visibleLoadError !== undefined && (
          <div className="inline-alert danger" role="alert">
            <AlertTriangle size={16} />
            <div>
              <p>{t("popup.loadFailed")}</p>
              <small className="technical-detail">{String(visibleLoadError)}</small>
              <Button type="button" size="sm" onClick={() => setRetryToken((current) => current + 1)}>
                <RefreshCw size={14} />
                {t("action.retry")}
              </Button>
            </div>
          </div>
        )}

        {syncError !== undefined && (
          <div className="inline-alert danger" role="alert">
            <AlertTriangle aria-hidden="true" size={16} />
            <p>{t("sync.failed", { detail: String(syncError) })}</p>
          </div>
        )}

        {dashboardError && (
          <div className="inline-alert danger" role="alert">
            <AlertTriangle aria-hidden="true" size={16} />
            <p>{t("popup.openFailed")}</p>
          </div>
        )}

        {loadState === "ready" && (
          <>
            <section className="popup-status" aria-live="polite" aria-atomic="true">
              <Chip tone={run.status === "paused-captcha" ? "sunset" : run.status === "failed" || run.status === "blocked-activity" || run.status === "blocked-captcha" ? "danger" : "sea"}>
                {isBusy && <LoaderCircle className="spin" size={13} />}
                {t(`status.${run.status}`)}
              </Chip>
              <div className="popup-count">
                <Database size={16} />
                <span>{t("popup.records", { count: recordCount })}</span>
              </div>
            </section>

            <div
              className="popup-progress"
              role="progressbar"
              aria-live="polite"
              aria-label={t("popup.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={Math.max(run.target, 1)}
              aria-valuenow={Math.min(run.collected, Math.max(run.target, 1))}
              aria-valuetext={t("popup.progressValue", {
                current: formatNumber(run.collected),
                total: formatNumber(run.target),
              })}
            >
              <span title={progressMessage.text}>{progressMessage.text}</span>
              <strong>{formatNumber(run.collected)} / {formatNumber(run.target)}</strong>
              <progress max={Math.max(run.target, 1)} value={Math.min(run.collected, Math.max(run.target, 1))} />
            </div>
            {progressMessage.technicalDetail && (
              <small className="technical-detail">
                {t("error.technicalDetail", { detail: progressMessage.technicalDetail })}
              </small>
            )}

            <section className="popup-status" aria-live="polite">
              <Chip tone={syncState.status === "error" ? "danger" : pendingSyncCount > 0 ? "sunset" : syncState.lastSuccessAt ? "good" : "sea"}>
                {(syncPending || syncState.status === "syncing") && <LoaderCircle className="spin" size={13} />}
                {syncPending || syncState.status === "syncing"
                  ? t("sync.syncing")
                  : syncState.status === "error"
                    ? t("sync.failed", { detail: syncState.lastError ?? "API" })
                    : pendingSyncCount > 0
                      ? t("sync.pending", { count: pendingSyncCount })
                      : t(syncState.lastSuccessAt ? "sync.upToDate" : "sync.notYetSynced")}
              </Chip>
            </section>
          </>
        )}
      </div>

      <footer className="popup-actions">
        <Button type="button" variant="ghost" onClick={() => void syncNow()} disabled={syncPending || loadState !== "ready"}>
          {syncPending ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
          {syncPending ? t("sync.syncing") : t("sync.now")}
        </Button>
        <Button type="button" variant="primary" onClick={openDashboard} disabled={openingDashboard}>
          {openingDashboard ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
          {t("popup.openCrawler")}
        </Button>
        {run.searchUrl && (
          <a className="btn" href={run.searchUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            {t("popup.openSearch")}
          </a>
        )}
      </footer>
    </main>
  );
}
