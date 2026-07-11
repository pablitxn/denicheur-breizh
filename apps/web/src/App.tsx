import { lazy, Suspense, useEffect } from "react";
import { EmptyState } from "@denicheur-breizh/design-system";
import { Shell } from "./components/Shell";
import { features } from "./config/features";
import { useAppIntl } from "./intl/IntlContext";
import { useWorkspaceStore } from "./state/workspaceStore";
import type { WorkspaceView } from "./types";
import { parseWorkspaceView, workspaceViewHref } from "./utils/workspaceNavigation";
import styles from "./App.module.css";

const workspaceViews = {
  map: lazy(() => import("./features/map/MapView").then(({ MapView }) => ({ default: MapView }))),
  properties: lazy(() =>
    import("./features/properties/PropertiesView").then(({ PropertiesView }) => ({ default: PropertiesView })),
  ),
  scorings: lazy(() =>
    import("./features/scorings/ScoringsView").then(({ ScoringsView }) => ({ default: ScoringsView })),
  ),
  builder: lazy(() =>
    import("./features/builder/BuilderView").then(({ BuilderView }) => ({ default: BuilderView })),
  ),
  realtime: lazy(() =>
    import("./features/realtime/RealtimeVoiceView").then(({ RealtimeVoiceView }) => ({ default: RealtimeVoiceView })),
  ),
} satisfies Record<WorkspaceView, ReturnType<typeof lazy>>;

export function App() {
  const { t } = useAppIntl();
  const activeView = useWorkspaceStore((state) => state.activeView);
  const setActiveView = useWorkspaceStore((state) => state.setActiveView);
  const theme = useWorkspaceStore((state) => state.theme);
  const accent = useWorkspaceStore((state) => state.accent);
  const density = useWorkspaceStore((state) => state.density);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.dataset.density = density;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#17141f" : "#fbfaf7");
  }, [accent, density, theme]);

  useEffect(() => {
    const handlePopState = () => {
      setActiveView(parseWorkspaceView(window.location.search) ?? "map");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setActiveView]);

  const resolvedView = activeView === "realtime" && !features.realtimeVoice ? "map" : activeView;
  const ActiveView = workspaceViews[resolvedView];

  useEffect(() => {
    if (activeView !== resolvedView) {
      setActiveView(resolvedView);
      window.history.replaceState({}, "", workspaceViewHref(resolvedView));
    }
  }, [activeView, resolvedView, setActiveView]);

  return (
    <Shell>
      <main id="workspace-content" className={styles.workspace}>
        <Suspense fallback={<EmptyState role="status">{t("common.loading")}</EmptyState>}>
          <ActiveView />
        </Suspense>
      </main>
    </Shell>
  );
}
