import { describe, expect, it } from "vitest";
import {
  coordinateEvidenceToVerifiedCoordinates,
  selectBestCoordinates,
} from "./coordinates";

const SOURCE_LOCALITY = {
  latitude: 47.856373,
  longitude: -3.8512979,
  locationKind: "source-locality" as const,
  provenance: "source locality fixture",
};

describe("coordinate normalization", () => {
  it("adds the caller-supplied observation time to stable extraction evidence", () => {
    expect(coordinateEvidenceToVerifiedCoordinates(
      SOURCE_LOCALITY,
      "2026-07-18T09:00:00.000Z",
    )).toEqual({
      ...SOURCE_LOCALITY,
      verifiedAt: "2026-07-18T09:00:00.000Z",
    });
  });

  it("omits evidence when its observation time is invalid", () => {
    expect(coordinateEvidenceToVerifiedCoordinates(SOURCE_LOCALITY, "not-a-date")).toBeUndefined();
  });

  it("keeps the earlier timestamp for the same observation", () => {
    const existing = {
      ...SOURCE_LOCALITY,
      verifiedAt: "2026-07-18T09:00:00.000Z",
    };
    const repeated = {
      ...existing,
      verifiedAt: "2026-07-18T09:05:00.000Z",
    };

    expect(selectBestCoordinates(existing, repeated)).toEqual(existing);
    expect(selectBestCoordinates(existing, repeated)?.verifiedAt).toBe(
      "2026-07-18T09:00:00.000Z",
    );
  });

  it("prefers source property evidence over a newer locality coordinate", () => {
    const property = {
      ...SOURCE_LOCALITY,
      latitude: 47.81,
      longitude: -3.81,
      locationKind: "source-property" as const,
      provenance: "source property fixture",
      verifiedAt: "2026-07-18T09:00:00.000Z",
    };
    const locality = {
      ...SOURCE_LOCALITY,
      verifiedAt: "2026-07-18T09:05:00.000Z",
    };

    expect(selectBestCoordinates(property, locality)).toEqual(property);
  });

  it("uses the newest timestamp for distinct observations of equal quality", () => {
    const existing = {
      ...SOURCE_LOCALITY,
      verifiedAt: "2026-07-18T09:00:00.000Z",
    };
    const incoming = {
      ...SOURCE_LOCALITY,
      latitude: 47.9,
      provenance: "updated source locality fixture",
      verifiedAt: "2026-07-18T09:05:00.000Z",
    };

    expect(selectBestCoordinates(existing, incoming)).toEqual(incoming);
  });
});
