import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AccentMode, DensityMode, ThemeMode, WorkspaceView } from "../types";
import { parseWorkspaceView } from "../utils/workspaceNavigation";

export const workspaceStorageKey = "denicheur:workspace";

interface WorkspaceState {
  activeView: WorkspaceView;
  theme: ThemeMode;
  accent: AccentMode;
  density: DensityMode;
  setActiveView: (view: WorkspaceView) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAccent: (accent: AccentMode) => void;
  setDensity: (density: DensityMode) => void;
}

function getInitialView(): WorkspaceView {
  if (typeof window === "undefined") return "map";
  return parseWorkspaceView(window.location.search) ?? "map";
}

function getInitialTheme(): ThemeMode {
  return "system";
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      activeView: getInitialView(),
      theme: getInitialTheme(),
      accent: "lavender",
      density: "comfortable",
      setActiveView: (activeView) => set({ activeView }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
      setAccent: (accent) => set({ accent }),
      setDensity: (density) => set({ density }),
    }),
    {
      name: workspaceStorageKey,
      version: 2,
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ theme, accent, density }) => ({
        theme,
        accent,
        density,
      }),
    },
  ),
);
