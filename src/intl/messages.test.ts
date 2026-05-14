import { describe, expect, it } from "vitest";
import { esMessages, frMessages } from "./messages";

describe("intl messages", () => {
  it("keeps Spanish and French catalogs aligned", () => {
    expect(Object.keys(esMessages).sort()).toEqual(Object.keys(frMessages).sort());
  });
});
