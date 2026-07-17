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
  selectedPropertyId: string;
  shortlistedPropertyIds: string[];
  setActiveView: (view: WorkspaceView) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAccent: (accent: AccentMode) => void;
  setDensity: (density: DensityMode) => void;
  setSelectedPropertyId: (id: string) => void;
  toggleShortlist: (id: string) => void;
}

function getInitialView(): WorkspaceView {
  if (typeof window === "undefined") return "map";
  return parseWorkspaceView(window.location.search) ?? "map";
}

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      activeView: getInitialView(),
      theme: getInitialTheme(),
      accent: "lavender",
      density: "comfortable",
      selectedPropertyId: "",
      shortlistedPropertyIds: [],
      setActiveView: (activeView) => set({ activeView }),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((state) => ({ theme: state.theme === "dark" ? "light" : "dark" })),
      setAccent: (accent) => set({ accent }),
      setDensity: (density) => set({ density }),
      setSelectedPropertyId: (selectedPropertyId) => set({ selectedPropertyId }),
      toggleShortlist: (id) =>
        set((state) => ({
          shortlistedPropertyIds: state.shortlistedPropertyIds.includes(id)
            ? state.shortlistedPropertyIds.filter((item) => item !== id)
            : [...state.shortlistedPropertyIds, id],
        })),
    }),
    {
      name: workspaceStorageKey,
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ theme, accent, density, selectedPropertyId, shortlistedPropertyIds }) => ({
        theme,
        accent,
        density,
        selectedPropertyId,
        shortlistedPropertyIds,
      }),
    },
  ),
);
