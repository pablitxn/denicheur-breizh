import { create } from "zustand";
import type { AccentMode, DensityMode, ThemeMode, WorkspaceView } from "../types";

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

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeView: "map",
  theme: "dark",
  accent: "lavender",
  density: "comfortable",
  selectedPropertyId: "p1",
  shortlistedPropertyIds: ["p1", "p10"],
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
}));
