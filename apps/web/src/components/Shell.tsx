import type { MouseEvent, ReactNode } from "react";
import { Gauge, Languages, List, Map, Mic2, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { Button, Chip } from "@denicheur-breizh/design-system";
import { useHealth } from "../api/hooks";
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
  const health = useHealth();
  const apiConnected = health.data?.status === "ok";
  const apiStatusLabel = health.isLoading
    ? t("shell.apiChecking")
    : apiConnected
      ? t("shell.liveApi")
      : t("shell.apiOffline");
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
          <Chip className={styles.apiStatus} active tone={apiConnected ? "good" : "danger"} title={health.data && !health.data.openAiConfigured ? t("shell.openAiUnavailable") : undefined}>
            <span className={styles.liveDot} aria-hidden="true" />
            {apiStatusLabel}
          </Chip>
          <div className={styles.localeSwitch} role="group" aria-label={t("app.language.label")} title={`${t("app.language.label")}: ${localeName}`}>
            <Languages size={15} aria-hidden="true" />
            {supportedLocales.map((item) => (
              <button
                key={item}
                type="button"
                className={locale === item ? styles.localeActive : ""}
                aria-pressed={locale === item}
                aria-label={t(`app.language.${item}`)}
                onClick={() => setLocale(item)}
              >
                {localeLabels[item]}
              </button>
            ))}
          </div>
          <Button
            className={styles.themeToggle}
            variant="ghost"
            iconOnly
            onClick={toggleTheme}
            aria-label={t(theme === "dark" ? "shell.theme.toLight" : "shell.theme.toDark")}
          >
            {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          </Button>
        </div>
      </header>
      {children}
    </div>
  );
}
