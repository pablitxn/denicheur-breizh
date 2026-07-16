import { Database, ExternalLink, LoaderCircle, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { LocaleSelector, useExtensionI18n } from "../i18n";
import type { ScrapeRun } from "../lib/types";
import { IDLE_RUN, isCrawlerStorageKey, loadCrawlerState } from "../storage/chromeStorage";

export function PopupApp() {
  const { formatNumber, resolveText, t } = useExtensionI18n();
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [recordCount, setRecordCount] = useState(0);

  useEffect(() => {
    let mounted = true;

    void loadCrawlerState().then((snapshot) => {
      if (!mounted) {
        return;
      }

      setRun(snapshot.run);
      setRecordCount(snapshot.records.length);
    });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local" || !Object.keys(changes).some(isCrawlerStorageKey)) {
        return;
      }

      void loadCrawlerState().then((snapshot) => {
        setRun(snapshot.run);
        setRecordCount(snapshot.records.length);
      });
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  async function openDashboard() {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    const existing = (await chrome.tabs.query({ url: dashboardUrl }))[0];
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
    <main className="popup-shell">
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

      <section className="popup-status">
        <Chip tone={run.status === "paused-captcha" ? "sunset" : run.status === "failed" || run.status === "blocked-activity" || run.status === "blocked-captcha" ? "danger" : "sea"}>
          {isBusy && <LoaderCircle className="spin" size={13} />}
          {t(`status.${run.status}`)}
        </Chip>
        <div className="popup-count">
          <Database size={16} />
          <span>{t("popup.records", { count: recordCount })}</span>
        </div>
      </section>

      <div className="popup-progress" aria-label={t("popup.progressLabel")}>
        <span>{progressMessage.text}</span>
        <strong>
          {formatNumber(run.collected)}/{formatNumber(run.target)}
        </strong>
      </div>
      {progressMessage.technicalDetail && (
        <small className="technical-detail">
          {t("error.technicalDetail", { detail: progressMessage.technicalDetail })}
        </small>
      )}

      <div className="popup-actions">
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
      </div>
    </main>
  );
}
