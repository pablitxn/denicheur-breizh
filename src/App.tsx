import { useEffect } from "react";
import { BuilderView } from "./features/builder/BuilderView";
import { MapView } from "./features/map/MapView";
import { PropertiesView } from "./features/properties/PropertiesView";
import { RealtimeVoiceView } from "./features/realtime/RealtimeVoiceView";
import { ScoringsView } from "./features/scorings/ScoringsView";
import { Shell } from "./components/Shell";
import { useWorkspaceStore } from "./state/workspaceStore";
import styles from "./App.module.css";

export function App() {
  const activeView = useWorkspaceStore((state) => state.activeView);
  const theme = useWorkspaceStore((state) => state.theme);
  const accent = useWorkspaceStore((state) => state.accent);
  const density = useWorkspaceStore((state) => state.density);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.dataset.density = density;
  }, [accent, density, theme]);

  return (
    <Shell>
      <main className={styles.workspace}>
        {activeView === "map" && <MapView />}
        {activeView === "properties" && <PropertiesView />}
        {activeView === "scorings" && <ScoringsView />}
        {activeView === "builder" && <BuilderView />}
        {activeView === "realtime" && <RealtimeVoiceView />}
      </main>
    </Shell>
  );
}
