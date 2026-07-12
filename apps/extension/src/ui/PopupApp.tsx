import { Database, ExternalLink, LoaderCircle, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import type { ScrapeRun } from "../lib/types";
import { IDLE_RUN, isCrawlerStorageKey, loadCrawlerState } from "../storage/chromeStorage";

export function PopupApp() {
  const [run, setRun] = useState<ScrapeRun>(IDLE_RUN);
  const [recordCount, setRecordCount] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.accent = "sea";
    document.documentElement.dataset.density = "compact";
  }, []);

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
    await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html"), active: true });
    window.close();
  }

  const isBusy =
    run.status === "opening-search" ||
    run.status === "collecting-search" ||
    run.status === "collecting-details" ||
    run.status === "evaluating";

  return (
    <main className="popup-shell">
      <header className="popup-head">
        <span className="extension-mark">DB</span>
        <div>
          <h1>Denicheur Breizh</h1>
          <p>LeBonCoin crawler</p>
        </div>
      </header>

      <section className="popup-status">
        <Chip tone={run.status === "paused-captcha" ? "sunset" : run.status === "failed" || run.status === "blocked-activity" ? "danger" : "sea"}>
          {isBusy && <LoaderCircle className="spin" size={13} />}
          {run.status}
        </Chip>
        <div className="popup-count">
          <Database size={16} />
          <span>{recordCount} records</span>
        </div>
      </section>

      <div className="popup-progress">
        <span>{run.message ?? "Ready"}</span>
        <strong>
          {run.collected}/{run.target}
        </strong>
      </div>

      <div className="popup-actions">
        <Button type="button" variant="primary" onClick={openDashboard}>
          <Play size={16} />
          Open crawler
        </Button>
        {run.searchUrl && (
          <a className="btn" href={run.searchUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            Search
          </a>
        )}
      </div>
    </main>
  );
}
