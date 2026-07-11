import { describe, expect, it } from "vitest";
import { parseWorkspaceView, workspaceViewHref } from "./workspaceNavigation";

describe("workspace navigation", () => {
  it("parses only supported views", () => {
    expect(parseWorkspaceView("?view=builder")).toBe("builder");
    expect(parseWorkspaceView("?view=unknown")).toBeUndefined();
    expect(parseWorkspaceView("")).toBeUndefined();
  });

  it("updates the view while preserving other URL state", () => {
    expect(workspaceViewHref("properties", "https://example.test/app?locale=fr#top")).toBe(
      "/app?locale=fr&view=properties#top",
    );
  });
});
