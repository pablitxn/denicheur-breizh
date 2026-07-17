import { describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { workspaceUrlChangeEvent } from "../../utils/workspaceNavigation";
import {
  parseRangeValue,
  focusBuilderControl,
  restoreCancelledBuilderPopstate,
  shouldApplySavedRecipe,
  updateRangeValue,
} from "./BuilderView";

describe("Builder range controls", () => {
  it("round-trips both numeric bounds through the recipe filter value", () => {
    expect(parseRangeValue("250000..480000")).toEqual(["250000", "480000"]);
    expect(updateRangeValue("250000..480000", 0, "260000")).toBe("260000..480000");
    expect(updateRangeValue("250000..480000", 1, "500000")).toBe("250000..500000");
  });

  it("keeps an incomplete range visibly incomplete for inline validation", () => {
    expect(updateRangeValue("", 0, "250000")).toBe("250000..");
    expect(parseRangeValue("250000..")).toBeUndefined();
  });

  it("does not apply an async save response over newer edits or another recipe", () => {
    expect(shouldApplySavedRecipe(4, 4, "weekend", "weekend")).toBe(true);
    expect(shouldApplySavedRecipe(4, 5, "weekend", "weekend")).toBe(false);
    expect(shouldApplySavedRecipe(4, 4, "weekend", "family")).toBe(false);
  });

  it("moves focus to the invalid control after its tab is revealed", () => {
    const input = document.createElement("input");
    input.id = "builder-filter-invalid";
    document.body.append(input);
    const immediateScheduler = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };

    focusBuilderControl(input.id, immediateScheduler);

    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("restores the accepted Builder URL after a cancelled browser traversal", () => {
    window.history.replaceState({}, "", "/?view=map");
    useWorkspaceStore.getState().setActiveView("map");
    const urlChange = vi.fn();
    window.addEventListener(workspaceUrlChangeEvent, urlChange);

    restoreCancelledBuilderPopstate("/?view=builder&btab=filters&brid=weekend");

    expect(window.location.search).toBe("?view=builder&btab=filters&brid=weekend");
    expect(useWorkspaceStore.getState().activeView).toBe("builder");
    expect(urlChange).toHaveBeenCalledOnce();
    window.removeEventListener(workspaceUrlChangeEvent, urlChange);
  });
});
