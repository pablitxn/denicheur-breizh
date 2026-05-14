import type { ReactNode } from "react";
import { Building2, Gauge, Languages, LayoutGrid, List, Map, Mic2, Moon, Search, SlidersHorizontal, Sun } from "lucide-react";
import { Button, Chip } from "./ui";
import { useProperties } from "../api/hooks";
import { supportedLocales, localeLabels } from "../intl/locales";
import { useAppIntl } from "../intl/IntlContext";
import { useWorkspaceStore } from "../state/workspaceStore";
import type { WorkspaceView } from "../types";
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
    { id: "realtime", label: t("nav.realtime"), icon: <Mic2 size={16} /> },
  ];

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandMark} aria-hidden="true" />
          <div className={styles.brandName}>
            denicheur<span>·</span>breizh
          </div>
        </div>

        <nav className={styles.tabs} aria-label={t("nav.primary")}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={[styles.tab, activeView === tab.id ? styles.tabActive : ""].join(" ")}
              onClick={() => setActiveView(tab.id)}
              type="button"
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.id === "properties" && <small>{properties.length}</small>}
            </button>
          ))}
        </nav>

        <div className={styles.toolbar}>
          <div className={styles.search} role="search">
            <Search size={15} />
            <span>{t("shell.search")}</span>
            <kbd>⌘K</kbd>
          </div>
          <Chip active tone="good">
            <span className={styles.liveDot} />
            {t("shell.mockApi")}
          </Chip>
          <div className={styles.localeSwitch} aria-label={t("app.language.label")} title={`${t("app.language.label")}: ${localeName}`}>
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
          <Button variant="ghost" iconOnly aria-label={t("shell.dashboard")}>
            <LayoutGrid size={16} />
          </Button>
          <div className={styles.avatar} aria-label={t("shell.profile")}>
            <Building2 size={15} />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
