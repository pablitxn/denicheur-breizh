import { writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const sourcePage = "https://www.data.gouv.fr/datasets/contours-administratifs";
const sourceDate = "2026-03-09";
const license = "Licence Ouverte 2.0";
const regionsUrl = "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2026/geojson/regions-50m.geojson.gz";
const departmentsUrl = "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2026/geojson/departements-50m.geojson.gz";
const quimperUrl = "https://geo.api.gouv.fr/communes/29232?fields=nom,code,contour&format=geojson&geometry=contour";
const outputUrl = new URL(
  "../apps/web/src/features/map/data/administrative-areas.json",
  import.meta.url,
);

const [regions, departments, quimper] = await Promise.all([
  fetchCompressedGeoJson(regionsUrl),
  fetchCompressedGeoJson(departmentsUrl),
  fetchGeoJson(quimperUrl),
]);

const bretagne = findFeature(regions, "53", "Bretagne");
const finistere = findFeature(departments, "29", "Finistère");

const featureCollection = {
  type: "FeatureCollection",
  name: "Bretagne administrative focus",
  generatedBy: "scripts/refresh-map-boundaries.mjs",
  features: [
    withProvenance(bretagne, {
      sourceResource: regionsUrl,
      sourceResolutionMeters: 50,
    }),
    withProvenance(finistere, {
      region: "53",
      sourceResource: departmentsUrl,
      sourceResolutionMeters: 50,
    }),
    withProvenance(quimper, {
      departement: "29",
      region: "53",
      epci: "200068120",
      sourceResource: quimperUrl,
      sourceResolutionMeters: 5,
    }),
  ],
};

await writeFile(outputUrl, `${JSON.stringify(featureCollection)}\n`, "utf8");

for (const feature of featureCollection.features) {
  console.log(
    `${feature.properties.code} ${feature.properties.nom}: ${countPositions(feature.geometry.coordinates)} vertices`,
  );
}

async function fetchCompressedGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

async function fetchGeoJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}`);
  return response.json();
}

function findFeature(collection, code, name) {
  const feature = collection.features.find((candidate) => candidate.properties.code === code);
  if (!feature) throw new Error(`Missing ${name} (${code}) in source data`);
  return feature;
}

function withProvenance(feature, extraProperties) {
  return {
    type: "Feature",
    properties: {
      code: feature.properties.code,
      nom: feature.properties.nom,
      ...extraProperties,
      source: sourcePage,
      license,
      sourceDate,
    },
    geometry: feature.geometry,
  };
}

function countPositions(value) {
  if (!Array.isArray(value)) return 0;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return 1;
  }
  return value.reduce((total, child) => total + countPositions(child), 0);
}
