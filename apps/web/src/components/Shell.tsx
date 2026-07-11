import type { MouseEvent, ReactNode } from "react";
import { Gauge, Languages, List, Map, Mic2, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { usesMockApi } from "../api/denicheurApi";
import { useProperties } from "../api/hooks";
import { features } from "../config/features";
import { supportedLocales, localeLabels } from "../intl/locales";
import { useAppIntl } from "../intl/IntlContext";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { WorkspaceView } from "../types";
import { workspaceViewHref } from "../utils/workspaceNavigation";
import styles from "./Shell.module.css";

export function Shell({ children }: { children: ReactNode }) {
  const { locale, localeName, setLocale, t } = useAppIntl();
  const activeView = useWorkspaceStore((state) => state.activeView);
  const setActiveView = useWorkspaceStore((state) => state.setActiveView);
  const theme = useWorkspaceStore((state) => state.theme);
  const toggleTheme = useWorkspaceStore((state) => state.toggleTheme);
  const { data: properties = [] } = useProperties();
  const tabs: Array<{ id: WorkspaceView; label: string; icon: ReactNode }> = [
    { id: "map", label: t("nav.map"), icon: <Map size={16} /> },
    { id: "properties", label: t("nav.properties"), icon: <List size={16} /> },
    { id: "scorings", label: t("nav.scorings"), icon: <Gauge size={16} /> },
    { id: "builder", label: t("nav.builder"), icon: <SlidersHorizontal size={16} /> },
    ...(features.realtimeVoice ? [{ id: "realtime" as const, label: t("nav.realtime"), icon: <Mic2 size={16} /> }] : []),
  ];

  const navigateToView = (event: MouseEvent<HTMLAnchorElement>, view: WorkspaceView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (view === activeView) return;

    window.history.pushState({}, "", workspaceViewHref(view));
    setActiveView(view);
  };

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#workspace-content">
        {t("shell.skipToContent")}
      </a>
      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandMark} aria-hidden="true" />
          <div className={styles.brandName}>
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
              {tab.id === "properties" && <small>{properties.length}</small>}
            </a>
          ))}
        </nav>

        <div className={styles.toolbar}>
          <Chip active tone={usesMockApi ? "sunset" : "good"}>
            <span className={styles.liveDot} />
            {t(usesMockApi ? "shell.mockApi" : "shell.liveApi")}
          </Chip>
          <div className={styles.localeSwitch} role="group" aria-label={t("app.language.label")} title={`${t("app.language.label")}: ${localeName}`}>
            <Languages size={15} />
            {supportedLocales.map((item) => (
              <button
                key={item}
                type="button"
                className={locale === item ? styles.localeActive : ""}
                aria-pressed={locale === item}
                aria-label={t(item === "fr" ? "app.language.fr" : "app.language.es")}
                onClick={() => setLocale(item)}
              >
                {localeLabels[item]}
              </button>
            ))}
          </div>
          <Button variant="ghost" iconOnly onClick={toggleTheme} aria-label={t("shell.theme")}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </div>
      </header>
      {children}
    </div>
  );
}
