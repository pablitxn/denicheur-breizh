import { describe, expect, it } from "vitest";
import { parseWorkspaceView, workspaceSearchHref, workspaceViewHref } from "./workspaceNavigation";

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

  it("updates and removes individual search parameters without losing the hash", () => {
    expect(
      workspaceSearchHref(
        { providers: "Leboncoin,Bien'ici", page: 2, empty: null },
        "https://example.test/app?view=map&empty=old#results",
      ),
    ).toBe("/app?view=map&providers=Leboncoin%2CBien%27ici&page=2#results");
  });
});
