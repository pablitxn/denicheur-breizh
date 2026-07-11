import { describe, expect, it } from "vitest";
import { properties } from "../assets/mockData";
import { getPropertySortValue } from "./propertySort";

describe("property sorting", () => {
  it("sorts the DPE column by the displayed grade, not the scoring metric", () => {
    const property = properties[0];

    expect(getPropertySortValue(property, "dpe")).toBe(property.dpe);
    expect(getPropertySortValue(property, "dpe")).not.toBe(property.scores.dpe);
  });
});
