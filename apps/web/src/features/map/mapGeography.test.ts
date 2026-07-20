import { describe, expect, it } from "vitest";
import {
  BRETAGNE,
  BRETAGNE_CAMERA,
  BRETAGNE_REFERENCE_BOUNDS,
  FINISTERE,
  INTEREST_PLACES,
  MAP_CONTEXT_LAYER_IDS,
  MAP_CONTEXT_PALETTE,
  MAP_CONTEXT_STYLE,
  QUIMPER,
  WORLD_MERCATOR_FRAME,
  createOutsideBretagneMask,
  distanceBetweenCoordinates,
  nearestInterestPlaces,
  pointIsInAdministrativeArea,
} from "./mapGeography";

describe("administrative map geography", () => {
  it("ships the exact scoped territories with attribution", () => {
    expect([BRETAGNE, FINISTERE, QUIMPER].map((area) => area.properties.code)).toEqual([
      "53",
      "29",
      "29232",
    ]);
    for (const area of [BRETAGNE, FINISTERE, QUIMPER]) {
      expect(area.geometry.coordinates.length).toBeGreaterThan(0);
      expect(area.properties.source).toBe("https://www.data.gouv.fr/datasets/contours-administratifs");
      expect(area.properties.license).toBe("Licence Ouverte 2.0");
      expect(area.properties.sourceDate).toBe("2026-03-09");
      expect(area.properties.sourceResource).toMatch(/^https:\/\//u);
    }
    expect(BRETAGNE.properties.sourceResolutionMeters).toBe(50);
    expect(FINISTERE.properties.sourceResolutionMeters).toBe(50);
    expect(QUIMPER.properties.sourceResolutionMeters).toBe(5);
  });

  it("keeps enough source detail for close administrative zooms", () => {
    expect(countCoordinatePairs(BRETAGNE.geometry.coordinates)).toBeGreaterThan(10_000);
    expect(countCoordinatePairs(FINISTERE.geometry.coordinates)).toBeGreaterThan(5_000);
    expect(countCoordinatePairs(QUIMPER.geometry.coordinates)).toBeGreaterThan(2_000);
  });

  it("uses the administrative Bretagne boundary, including Finistère and excluding Nantes", () => {
    const quimperCathedral = [-4.102177, 47.995629] as const;
    const camaretCentre = [-4.595556, 48.276667] as const;
    const crozonCentre = [-4.489, 48.246] as const;
    const atlanticWestOfCamaret = [-4.7, 48.276667] as const;

    expect(pointIsInAdministrativeArea(quimperCathedral, BRETAGNE)).toBe(true);
    expect(pointIsInAdministrativeArea([-1.678, 48.117], BRETAGNE)).toBe(true);
    expect(pointIsInAdministrativeArea([-1.554, 47.218], BRETAGNE)).toBe(false);
    expect(pointIsInAdministrativeArea(quimperCathedral, FINISTERE)).toBe(true);
    expect(pointIsInAdministrativeArea(quimperCathedral, QUIMPER)).toBe(true);
    expect(pointIsInAdministrativeArea(camaretCentre, BRETAGNE)).toBe(true);
    expect(pointIsInAdministrativeArea(camaretCentre, FINISTERE)).toBe(true);
    expect(pointIsInAdministrativeArea(crozonCentre, BRETAGNE)).toBe(true);
    expect(pointIsInAdministrativeArea(crozonCentre, FINISTERE)).toBe(true);
    expect(pointIsInAdministrativeArea(atlanticWestOfCamaret, BRETAGNE)).toBe(false);
    expect(pointIsInAdministrativeArea(atlanticWestOfCamaret, FINISTERE)).toBe(false);
  });

  it("builds a worldwide outside mask with Bretagne polygons as holes", () => {
    const mask = createOutsideBretagneMask();
    expect(mask.properties.scope).toBe("outside-bretagne");
    expect(mask.geometry.coordinates.length).toBeGreaterThan(2);
    expect(mask.geometry.coordinates[0]).toEqual(WORLD_MERCATOR_FRAME);
    expect(BRETAGNE_CAMERA.minZoom).toBe(0);
    expect(BRETAGNE_CAMERA.renderWorldCopies).toBe(true);
  });

  it("keeps context layer identities and colours explicit", () => {
    expect(Object.values(MAP_CONTEXT_LAYER_IDS)).toEqual([
      "outside-bretagne-mask",
      "finistere-fill",
      "finistere-outline",
      "quimper-fill",
      "quimper-outline",
      "bretagne-outline",
    ]);
    expect(new Set(Object.values(MAP_CONTEXT_LAYER_IDS)).size).toBe(6);
    for (const colour of Object.values(MAP_CONTEXT_PALETTE)) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/u);
    }
    expect(MAP_CONTEXT_STYLE.finistereFillOpacity).toBeLessThan(0.1);
    expect(MAP_CONTEXT_STYLE.quimperFillOpacity).toBeLessThan(0.2);
    expect(MAP_CONTEXT_STYLE.outsideOpacity).toBeLessThan(0.5);
  });
});

function countCoordinatePairs(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return 1;
  }
  return value.reduce<number>((total, child) => total + countCoordinatePairs(child), 0);
}

describe("map interest context", () => {
  it("keeps a unique, sourced set of representative points in the Bretagne frame", () => {
    expect(new Set(INTEREST_PLACES.map((place) => place.id)).size).toBe(INTEREST_PLACES.length);
    expect(INTEREST_PLACES.length).toBeGreaterThanOrEqual(6);
    expect(INTEREST_PLACES
      .filter((place) => !pointIsInAdministrativeArea(place.coordinates, BRETAGNE))
      .map((place) => place.name)).toEqual([
        "Le Golfe du Morbihan",
      ]);
    for (const place of INTEREST_PLACES) {
      expect(place.coordinates[0]).toBeGreaterThanOrEqual(BRETAGNE_REFERENCE_BOUNDS[0][0]);
      expect(place.coordinates[0]).toBeLessThanOrEqual(BRETAGNE_REFERENCE_BOUNDS[1][0]);
      expect(place.coordinates[1]).toBeGreaterThanOrEqual(BRETAGNE_REFERENCE_BOUNDS[0][1]);
      expect(place.coordinates[1]).toBeLessThanOrEqual(BRETAGNE_REFERENCE_BOUNDS[1][1]);
      expect(place.sourceUrl).toMatch(/^https:\/\//u);
      expect(place.coordinateKind).toBe("representative-point");
      if (place.sourceUpdatedAt) expect(place.sourceUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(place.sourceCheckedAt).toBe("2026-07-19");
    }
    for (const place of INTEREST_PLACES.filter(({ sourceLabel }) => sourceLabel === "DATAtourisme")) {
      expect(place.sourceUrl).toMatch(/^https:\/\/data\.datatourisme\.fr\//u);
    }
    expect(INTEREST_PLACES.some(({ name }) => /office de tourisme/iu.test(name))).toBe(false);
    expect(INTEREST_PLACES.find((place) => place.id === "pointe-du-raz")).toMatchObject({
      coordinates: [-4.740376, 48.040023],
      coordinateSource: {
        label: "IGN",
        identifier: "PAIOROGR0000000023221409",
      },
    });
    expect(INTEREST_PLACES.find((place) => place.id === "golfe-morbihan")).toMatchObject({
      coordinates: [-2.799827, 47.576042],
      coordinateSource: {
        label: "IGN",
        identifier: "PAIHYDRO0000000087158607",
      },
    });
    expect(INTEREST_PLACES.find((place) => place.id === "cathedrale-saint-corentin")).toMatchObject({
      name: "Cathédrale Saint-Corentin",
      category: "heritage",
      coordinates: [-4.102177, 47.995629],
      sourceLabel: "Quimper Cornouaille Tourisme",
      coordinateSource: {
        label: "IGN",
        identifier: "SURFACTI0000000023223043",
      },
    });
  });

  it("calculates honest straight-line proximity and applies its limit", () => {
    expect(distanceBetweenCoordinates([-4.102, 47.996], [-4.102, 47.996])).toBe(0);
    const nearby = nearestInterestPlaces([-4.102, 47.996], { limit: 2, maxDistanceKm: 80 });
    expect(nearby).toHaveLength(2);
    expect(nearby[0]?.distanceKm).toBeLessThanOrEqual(nearby[1]?.distanceKm ?? 0);
    expect(nearby.every(({ distanceKm }) => distanceKm <= 80)).toBe(true);
  });
});
