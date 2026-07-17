import { AlertTriangle, Database, ExternalLink, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { LocaleSelector, useExtensionI18n } from "../i18n";
import type { ScrapeRun } from "../lib/types";
import { IDLE_RUN, isCrawlerStorageKey, loadCrawlerState } from "../storage/chromeStorage";
import { useThemePreference, type ThemePreference } from "./theme";

interface PopupAppProps {
  initialThemePreference?: ThemePreference;
}

export function PopupApp({ initialThemePreference = "system" }: PopupAppProps) {
  const { formatNumber, resolveText, t } = useExtensionI18n();
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [recordCount, setRecordCount] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<unknown>();
  const [retryToken, setRetryToken] = useState(0);
  useThemePreference(initialThemePreference);

  useEffect(() => {
    let mounted = true;
    setLoadState("loading");
    setLoadError(undefined);

    void loadCrawlerState()
      .then((snapshot) => {
        if (!mounted) return;
        setRun(snapshot.run);
        setRecordCount(snapshot.records.length);
        setLoadState("ready");
      })
      .catch((caught) => {
        if (!mounted) return;
        setLoadError(caught instanceof Error ? caught.message : String(caught));
        setLoadState("error");
      });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !Object.keys(changes).some(isCrawlerStorageKey)) {
        return;
      }

      void loadCrawlerState()
        .then((snapshot) => {
          if (!mounted) return;
          setRun(snapshot.run);
          setRecordCount(snapshot.records.length);
          setLoadState("ready");
        })
        .catch((caught) => {
          if (!mounted) return;
          setLoadError(caught instanceof Error ? caught.message : String(caught));
          setLoadState("error");
        });
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [retryToken]);

  async function openDashboard() {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    const existing = (await chrome.tabs.query({ url: `${dashboardUrl}*` }))[0];
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: dashboardUrl, active: true });
    }
    window.close();
  }

  const isBusy =
    run.status === "opening-search" ||
    run.status === "configuring-search" ||
    run.status === "collecting-search" ||
    run.status === "collecting-details" ||
    run.status === "evaluating";
  const progressMessage = resolveText(run.message, "popup.ready");

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
        <LocaleSelector />
      </header>

      <div className="popup-content">
        {loadState === "loading" && (
          <div className="loading-state" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{t("popup.loading")}</span>
          </div>
        )}

        {loadState === "error" && (
          <div className="inline-alert danger" role="alert">
            <AlertTriangle size={16} />
            <div>
              <p>{t("popup.loadFailed")}</p>
              {loadError !== undefined && <small className="technical-detail">{String(loadError)}</small>}
              <Button type="button" size="sm" onClick={() => setRetryToken((current) => current + 1)}>
                <RefreshCw size={14} />
                {t("action.retry")}
              </Button>
            </div>
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
          </>
        )}
      </div>

      <footer className="popup-actions">
        <Button type="button" variant="primary" onClick={openDashboard}>
          <Play size={16} />
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
