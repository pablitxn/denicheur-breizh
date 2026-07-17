import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspaceStore, workspaceStorageKey } from "./workspaceStore";

describe("workspaceStore persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceStore.setState({
      activeView: "map",
      theme: "dark",
      accent: "lavender",
      density: "comfortable",
      selectedPropertyId: "",
      shortlistedPropertyIds: [],
    });
  });

  it("persists user preferences and shortlist but leaves navigation to the URL", () => {
    useWorkspaceStore.getState().setActiveView("builder");
    useWorkspaceStore.getState().setTheme("light");
    useWorkspaceStore.getState().toggleShortlist("listing-42");

    const persisted = JSON.parse(window.localStorage.getItem(workspaceStorageKey) ?? "{}") as {
      state?: Record<string, unknown>;
    };

    expect(persisted.state).toMatchObject({
      theme: "light",
      shortlistedPropertyIds: ["listing-42"],
    });
    expect(persisted.state).not.toHaveProperty("activeView");
  });

  it("rehydrates preferences written by another tab", async () => {
    window.localStorage.setItem(workspaceStorageKey, JSON.stringify({
      state: {
        theme: "light",
        accent: "sea",
        density: "compact",
        selectedPropertyId: "listing-7",
        shortlistedPropertyIds: ["listing-7"],
      },
      version: 1,
    }));

    await useWorkspaceStore.persist.rehydrate();

    expect(useWorkspaceStore.getState()).toMatchObject({
      theme: "light",
      accent: "sea",
      density: "compact",
      selectedPropertyId: "listing-7",
      shortlistedPropertyIds: ["listing-7"],
    });
  });
});
