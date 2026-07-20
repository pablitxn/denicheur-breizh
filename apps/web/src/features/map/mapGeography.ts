import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";
import administrativeAreasJson from "./data/administrative-areas.json";

export type AdministrativeGeometry = Polygon | MultiPolygon;

export interface AdministrativeAreaProperties {
  code: string;
  nom: string;
  departement?: string;
  region?: string;
  source: string;
  sourceResource: string;
  license: string;
  sourceDate: string;
  sourceResolutionMeters: 5 | 50;
}

export type AdministrativeArea = Feature<AdministrativeGeometry, AdministrativeAreaProperties>;

export type InterestCategory = "natural" | "heritage";

export type InterestDescriptionId =
  | "map.interest.pointeDuRaz.description"
  | "map.interest.glenan.description"
  | "map.interest.montsArree.description"
  | "map.interest.huelgoat.description"
  | "map.interest.ploumanach.description"
  | "map.interest.golfeMorbihan.description"
  | "map.interest.cathedraleQuimper.description"
  | "map.interest.carnac.description"
  | "map.interest.saintMalo.description"
  | "map.interest.pontAven.description";

export interface InterestPlace {
  id: string;
  name: string;
  category: InterestCategory;
  descriptionId: InterestDescriptionId;
  coordinates: readonly [longitude: number, latitude: number];
  coordinateKind: "representative-point";
  sourceLabel: "DATAtourisme" | "Quimper Cornouaille Tourisme";
  sourceUrl: string;
  sourceUpdatedAt?: string;
  sourceCheckedAt: "2026-07-19";
  coordinateSource?: {
    label: "IGN";
    url: string;
    identifier: string;
    checkedAt: "2026-07-19";
  };
}

export interface NearbyInterestPlace {
  place: InterestPlace;
  distanceKm: number;
}

const administrativeAreas = administrativeAreasJson as unknown as FeatureCollection<
  AdministrativeGeometry,
  AdministrativeAreaProperties
>;

export const BRETAGNE = administrativeArea("53");
export const FINISTERE = administrativeArea("29");
export const QUIMPER = administrativeArea("29232");

export const BRETAGNE_CAMERA = {
  center: [-2.85, 48.22] as [number, number],
  zoom: 7.15,
  minZoom: 0,
  renderWorldCopies: true,
} as const;

export const BRETAGNE_REFERENCE_BOUNDS = [
  [-5.65, 47.02],
  [-0.72, 49.18],
] as const;

export const WORLD_MERCATOR_FRAME: Position[] = [
  [-180, -85.051129],
  [180, -85.051129],
  [180, 85.051129],
  [-180, 85.051129],
  [-180, -85.051129],
];

export const MAP_CONTEXT_LAYER_IDS = {
  outsideMask: "outside-bretagne-mask",
  finistereFill: "finistere-fill",
  finistereOutline: "finistere-outline",
  quimperFill: "quimper-fill",
  quimperOutline: "quimper-outline",
  bretagneOutline: "bretagne-outline",
} as const;

export const MAP_CONTEXT_PALETTE = {
  outside: "#687179",
  bretagneOutline: "#68727b",
  finistere: "#918dc5",
  finistereOutline: "#7774a8",
  quimper: "#d3a28e",
  quimperOutline: "#b97860",
} as const;

export const MAP_CONTEXT_STYLE = {
  outsideOpacity: 0.48,
  finistereFillOpacity: 0.09,
  finistereOutlineOpacity: 0.58,
  quimperFillOpacity: 0.18,
  quimperOutlineOpacity: 0.72,
  bretagneOutlineOpacity: 0.62,
} as const;

export const INTEREST_PLACES: readonly InterestPlace[] = [
  {
    id: "pointe-du-raz",
    name: "Pointe du Raz",
    category: "natural",
    descriptionId: "map.interest.pointeDuRaz.description",
    coordinates: [-4.740376, 48.040023],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/1c2677ba-27c0-3690-a921-b584198385ce",
    sourceUpdatedAt: "2026-05-04",
    sourceCheckedAt: "2026-07-19",
    coordinateSource: {
      label: "IGN",
      url: "https://data.geopf.fr/geocodage/search?index=poi&limit=1&q=Pointe%20du%20Raz",
      identifier: "PAIOROGR0000000023221409",
      checkedAt: "2026-07-19",
    },
  },
  {
    id: "archipel-glenan",
    name: "Archipel des Glénan",
    category: "natural",
    descriptionId: "map.interest.glenan.description",
    coordinates: [-3.9550781, 47.7176155],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/a0d5d218-ea4b-3a31-838a-627ae8dc6fcd",
    sourceUpdatedAt: "2026-05-23",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "monts-arree",
    name: "Monts d’Arrée",
    category: "natural",
    descriptionId: "map.interest.montsArree.description",
    coordinates: [-3.9108473, 48.406268],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/8431415b-7dec-34c1-a470-02cc342853be",
    sourceUpdatedAt: "2018-07-05",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "foret-huelgoat",
    name: "Forêt d’Huelgoat et son Chaos granitique",
    category: "natural",
    descriptionId: "map.interest.huelgoat.description",
    coordinates: [-3.745646, 48.364725],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/302e9564-62fb-3902-989a-2730c7768d45",
    sourceUpdatedAt: "2020-05-14",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "ploumanach",
    name: "Rochers et Landes de Ploumanac’h",
    category: "natural",
    descriptionId: "map.interest.ploumanach.description",
    coordinates: [-3.4733051, 48.8297309],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/feca3085-3a51-398c-84e6-739a2b047503",
    sourceUpdatedAt: "2025-11-12",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "golfe-morbihan",
    name: "Le Golfe du Morbihan",
    category: "natural",
    descriptionId: "map.interest.golfeMorbihan.description",
    coordinates: [-2.799827, 47.576042],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/f560df2c-bdf7-3f7a-a062-b90a36e47fa1",
    sourceUpdatedAt: "2026-06-16",
    sourceCheckedAt: "2026-07-19",
    coordinateSource: {
      label: "IGN",
      url: "https://data.geopf.fr/geocodage/search?index=poi&limit=1&q=Golfe%20du%20Morbihan",
      identifier: "PAIHYDRO0000000087158607",
      checkedAt: "2026-07-19",
    },
  },
  {
    id: "cathedrale-saint-corentin",
    name: "Cathédrale Saint-Corentin",
    category: "heritage",
    descriptionId: "map.interest.cathedraleQuimper.description",
    coordinates: [-4.102177, 47.995629],
    coordinateKind: "representative-point",
    sourceLabel: "Quimper Cornouaille Tourisme",
    sourceUrl: "https://www.quimper-tourisme.bzh/cathedrale-saint-corentin/",
    sourceCheckedAt: "2026-07-19",
    coordinateSource: {
      label: "IGN",
      url: "https://data.geopf.fr/geocodage/search?index=poi&limit=1&q=Cath%C3%A9drale%20Saint-Corentin%20Quimper",
      identifier: "SURFACTI0000000023223043",
      checkedAt: "2026-07-19",
    },
  },
  {
    id: "alignements-carnac",
    name: "Les Alignements de Carnac",
    category: "heritage",
    descriptionId: "map.interest.carnac.description",
    coordinates: [-3.0822733, 47.5914261],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/70d5a7c3-c1bf-327c-ba71-ca6ff616c547",
    sourceUpdatedAt: "2026-04-16",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "demeure-corsaire-saint-malo",
    name: "Demeure de Corsaire, Hôtel Magon de La Lande",
    category: "heritage",
    descriptionId: "map.interest.saintMalo.description",
    coordinates: [-2.0242094, 48.6469351],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/42e6e421-1585-33ce-adca-9bef6a0122bd",
    sourceUpdatedAt: "2026-06-30",
    sourceCheckedAt: "2026-07-19",
  },
  {
    id: "musee-pont-aven",
    name: "Musée de Pont-Aven",
    category: "heritage",
    descriptionId: "map.interest.pontAven.description",
    coordinates: [-3.747095, 47.85528],
    coordinateKind: "representative-point",
    sourceLabel: "DATAtourisme",
    sourceUrl: "https://data.datatourisme.fr/38/b92a84df-6d14-3e19-9fba-ec8af5f21c7c",
    sourceUpdatedAt: "2026-06-22",
    sourceCheckedAt: "2026-07-19",
  },
] as const;

export const INTEREST_PLACES_GEOJSON: FeatureCollection<Point> = {
  type: "FeatureCollection",
  features: INTEREST_PLACES.map((place): Feature<Point> => ({
    type: "Feature",
    properties: {
      id: place.id,
      category: place.category,
      name: place.name,
    },
    geometry: {
      type: "Point",
      coordinates: [...place.coordinates],
    },
  })),
};

export function createOutsideBretagneMask(): Feature<Polygon, { scope: "outside-bretagne" }> {
  const holes = polygonCoordinates(BRETAGNE.geometry)
    .map(([exterior]) => exterior)
    .filter((ring): ring is Position[] => ring !== undefined)
    .map((ring) => withOppositeWinding(WORLD_MERCATOR_FRAME, ring));

  return {
    type: "Feature",
    properties: { scope: "outside-bretagne" },
    geometry: {
      type: "Polygon",
      coordinates: [WORLD_MERCATOR_FRAME, ...holes],
    },
  };
}

export function pointIsInAdministrativeArea(
  coordinates: readonly [longitude: number, latitude: number],
  area: AdministrativeArea,
): boolean {
  return polygonCoordinates(area.geometry).some((polygon) => {
    const [exterior, ...holes] = polygon;
    if (!exterior || !pointIsInRing(coordinates, exterior)) return false;
    return !holes.some((hole) => pointIsInRing(coordinates, hole));
  });
}

export function nearestInterestPlaces(
  coordinates: readonly [longitude: number, latitude: number],
  options: { limit?: number; maxDistanceKm?: number } = {},
): NearbyInterestPlace[] {
  const limit = options.limit ?? 3;
  const maxDistanceKm = options.maxDistanceKm ?? 65;

  return INTEREST_PLACES
    .map((place) => ({ place, distanceKm: distanceBetweenCoordinates(coordinates, place.coordinates) }))
    .filter(({ distanceKm }) => distanceKm <= maxDistanceKm)
    .sort((left, right) => left.distanceKm - right.distanceKm)
    .slice(0, limit);
}

export function distanceBetweenCoordinates(
  from: readonly [longitude: number, latitude: number],
  to: readonly [longitude: number, latitude: number],
): number {
  const earthRadiusKm = 6_371.0088;
  const toRadians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = toRadians(to[1] - from[1]);
  const longitudeDelta = toRadians(to[0] - from[0]);
  const fromLatitude = toRadians(from[1]);
  const toLatitude = toRadians(to[1]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function administrativeArea(code: string): AdministrativeArea {
  const feature = administrativeAreas.features.find((candidate) => candidate.properties.code === code);
  if (!feature) throw new Error(`Missing administrative area ${code}`);
  return feature;
}

function polygonCoordinates(geometry: AdministrativeGeometry): Position[][][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

function pointIsInRing(
  [longitude, latitude]: readonly [number, number],
  ring: Position[],
): boolean {
  let inside = false;
  for (let currentIndex = 0, previousIndex = ring.length - 1; currentIndex < ring.length; previousIndex = currentIndex++) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    if (!current || !previous) continue;
    const [currentLongitude, currentLatitude] = current;
    const [previousLongitude, previousLatitude] = previous;

    if (pointIsOnSegment(
      longitude,
      latitude,
      previousLongitude,
      previousLatitude,
      currentLongitude,
      currentLatitude,
    )) return true;

    const crossesRay = (currentLatitude > latitude) !== (previousLatitude > latitude)
      && longitude < (previousLongitude - currentLongitude)
        * (latitude - currentLatitude)
        / (previousLatitude - currentLatitude)
        + currentLongitude;
    if (crossesRay) inside = !inside;
  }
  return inside;
}

function pointIsOnSegment(
  longitude: number,
  latitude: number,
  startLongitude: number,
  startLatitude: number,
  endLongitude: number,
  endLatitude: number,
): boolean {
  const epsilon = 1e-9;
  const squaredLength = (endLongitude - startLongitude) ** 2 + (endLatitude - startLatitude) ** 2;
  if (squaredLength <= epsilon) {
    return Math.abs(longitude - startLongitude) <= epsilon
      && Math.abs(latitude - startLatitude) <= epsilon;
  }
  const crossProduct = (latitude - startLatitude) * (endLongitude - startLongitude)
    - (longitude - startLongitude) * (endLatitude - startLatitude);
  if (Math.abs(crossProduct) > epsilon) return false;

  const dotProduct = (longitude - startLongitude) * (endLongitude - startLongitude)
    + (latitude - startLatitude) * (endLatitude - startLatitude);
  if (dotProduct < -epsilon) return false;

  return dotProduct <= squaredLength + epsilon;
}

function withOppositeWinding(reference: Position[], ring: Position[]): Position[] {
  return Math.sign(signedRingArea(reference)) === Math.sign(signedRingArea(ring))
    ? [...ring].reverse()
    : ring;
}

function signedRingArea(ring: Position[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (current && next) area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}
