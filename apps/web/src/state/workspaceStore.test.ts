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
    });
  });

  it("persists only display preferences and leaves navigation to the URL", () => {
    useWorkspaceStore.getState().setActiveView("builder");
    useWorkspaceStore.getState().setTheme("light");

    const persisted = JSON.parse(window.localStorage.getItem(workspaceStorageKey) ?? "{}") as {
      state?: Record<string, unknown>;
    };

    expect(persisted.state).toMatchObject({
      theme: "light",
    });
    expect(persisted.state).not.toHaveProperty("activeView");
    expect(persisted.state).not.toHaveProperty("selectedPropertyId");
    expect(persisted.state).not.toHaveProperty("shortlistedPropertyIds");
  });

  it("rehydrates preferences written by another tab", async () => {
    window.localStorage.setItem(workspaceStorageKey, JSON.stringify({
      state: {
        theme: "light",
        accent: "sea",
        density: "compact",
      },
      version: 2,
    }));

    await useWorkspaceStore.persist.rehydrate();

    expect(useWorkspaceStore.getState()).toMatchObject({
      theme: "light",
      accent: "sea",
      density: "compact",
    });
  });
});
