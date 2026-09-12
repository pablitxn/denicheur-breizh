import type { MouseEvent, ReactNode } from "react";
import { Gauge, List, Map, Mic2, SlidersHorizontal } from "lucide-react";
import { features } from "../config/features";
import { useAppIntl } from "../intl/IntlContext";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { WorkspaceView } from "../types";
import { workspaceViewHref } from "../utils/workspaceNavigation";
import styles from "./Shell.module.css";
import { WebSettings } from "./WebSettings";

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useAppIntl();
  const activeView = useWorkspaceStore((state) => state.activeView);
  const setActiveView = useWorkspaceStore((state) => state.setActiveView);
  const tabs: Array<{ id: WorkspaceView; label: string; icon: ReactNode }> = [
    { id: "map", label: t("nav.map"), icon: <Map size={16} aria-hidden="true" /> },
    { id: "properties", label: t("nav.properties"), icon: <List size={16} aria-hidden="true" /> },
    { id: "scorings", label: t("nav.scorings"), icon: <Gauge size={16} aria-hidden="true" /> },
    { id: "builder", label: t("nav.builder"), icon: <SlidersHorizontal size={16} aria-hidden="true" /> },
    ...(features.realtimeVoice ? [{ id: "realtime" as const, label: t("nav.realtime"), icon: <Mic2 size={16} aria-hidden="true" /> }] : []),
  ];

  const navigateToView = (event: MouseEvent<HTMLAnchorElement>, view: WorkspaceView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (view === activeView) return;

    window.history.pushState({}, "", workspaceViewHref(view));
    setActiveView(view);
  };

  const focusWorkspaceContent = () => {
    requestAnimationFrame(() => {
      const content = document.getElementById("workspace-content");
      if (!(content instanceof HTMLElement)) return;
      content.tabIndex = -1;
      content.focus({ preventScroll: true });
    });
  };

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#workspace-content" onClick={focusWorkspaceContent}>
        {t("shell.skipToContent")}
      </a>
      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandMark} aria-hidden="true" />
          <div className={styles.brandName} translate="no">
            dénicheur<span>·</span>breizh
          </div>
        </div>

        <nav className={styles.tabs} aria-label={t("nav.primary")}>
          {tabs.map((tab) => (
            <a
              key={tab.id}
              href={workspaceViewHref(tab.id)}
              className={[styles.tab, activeView === tab.id ? styles.tabActive : ""].join(" ")}
              aria-current={activeView === tab.id ? "page" : undefined}
              onClick={(event) => navigateToView(event, tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </a>
          ))}
        </nav>

        <div className={styles.toolbar}>
          <WebSettings />
        </div>
      </header>
      {children}
    </div>
  );
}
