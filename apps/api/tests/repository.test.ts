import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { IngestionRequest, ListingIngestion } from "../src/contracts.js";
import { DATABASE_MIGRATIONS, DenicheurRepository } from "../src/repository.js";

const NOW = new Date("2026-07-18T10:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DenicheurRepository", () => {
  it("reopens the same SQLite file with the ingested listing intact", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-api-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const first = new DenicheurRepository({ path, now: () => NOW });
    first.ingest(createIngestion([createListing()]));
    first.close();

    const reopened = new DenicheurRepository({ path, now: () => NOW });
    const listing = reopened.getListing({ source: "leboncoin", externalId: "2876543210" });
    reopened.close();

    expect(listing).toMatchObject({
      id: "leboncoin:2876543210",
      title: "Maison détaillée",
      lastRunId: "run-1",
    });
  });

  it("clears collected data through a second live connection while preserving recipes", () => {
    const directory = mkdtempSync(join(tmpdir(), "denicheur-api-clean-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "denicheur.sqlite");
    const servingRepository = new DenicheurRepository({ path, now: () => NOW });
    const cleaningRepository = new DenicheurRepository({ path, now: () => NOW });

    try {
      servingRepository.ingest(createIngestion([createListing()]));
      const recipe = servingRepository.saveRecipe("preserved-recipe", {
        name: "Recette conservée",
        threshold: 70,
        criteria: [{
          id: "garden",
          name: "Jardin",
          description: "Le bien doit disposer d'un jardin.",
          weight: 1,
          required: false,
        }],
      });
      servingRepository.activateRecipe(recipe.id, recipe.version);

      expect(cleaningRepository.clearCollectedData()).toEqual({
        listings: 1,
        runs: 1,
        runListings: 1,
        evaluations: 0,
      });
      expect(servingRepository.listListings({ limit: 20, sort: "updatedAt", order: "desc" })).toMatchObject({
        items: [],
        total: 0,
      });
      expect(servingRepository.listRuns({ limit: 20, order: "desc" })).toMatchObject({
        items: [],
        total: 0,
      });
      expect(servingRepository.getActiveRecipe()).toMatchObject({
        id: "preserved-recipe",
        version: 1,
        active: true,
      });
      const inspectionDatabase = new DatabaseSync(path);
      try {
        const appliedVersions = inspectionDatabase
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => row.version);
        expect(appliedVersions).toEqual(DATABASE_MIGRATIONS.map((migration) => migration.version));
      } finally {
        inspectionDatabase.close();
      }
    } finally {
      cleaningRepository.close();
      servingRepository.close();
    }
  });

  it("does not let a later summary erase richer detail fields", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([createListing()]));
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Résumé plus récent",
      priceEuros: 251_000,
      features: [],
      status: "listing",
      scrapedAt: "2026-07-18T11:00:00.000Z",
    }]));

    const listing = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(listing).toMatchObject({
      status: "detailed",
      title: "Résumé plus récent",
      priceEuros: 251_000,
      description: "Description complète avec jardin et garage.",
      imageUrls: ["https://img.leboncoin.fr/example-1.jpg", "https://img.leboncoin.fr/example-2.jpg"],
      features: ["Jardin", "Garage"],
    });
  });

  it("deduplicates repeated source and external id ingestion", () => {
    const repository = createMemoryRepository();

    const first = repository.ingest(createIngestion([createListing()]));
    const second = repository.ingest(createIngestion([createListing()]));
    const page = repository.listListings({ limit: 20, sort: "updatedAt", order: "desc" });

    expect(first).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });

  it("keeps the highest-quality coordinates when later snapshots are less precise or omit them", () => {
    const repository = createMemoryRepository();
    const propertyCoordinates = {
      latitude: 47.855831,
      longitude: -3.852705,
      verifiedAt: "2026-07-18T08:00:00.000Z",
      provenance: "leboncoin:api:property-location",
      locationKind: "source-property" as const,
    };
    repository.ingest(createIngestion([{
      ...createListing(),
      coordinates: {
        latitude: 47.8,
        longitude: -3.8,
        verifiedAt: "2026-07-18T12:00:00.000Z",
        provenance: "geocoder:postal-code",
        locationKind: "postal-code-centroid",
      },
      scrapedAt: "2026-07-18T07:00:00.000Z",
    }], "run-centroid"));
    repository.ingest(createIngestion([{
      ...createListing(),
      coordinates: {
        latitude: 47.85,
        longitude: -3.85,
        verifiedAt: "2026-07-18T11:00:00.000Z",
        provenance: "leboncoin:api:location",
        locationKind: "source-locality",
      },
      scrapedAt: "2026-07-18T09:00:00.000Z",
    }], "run-locality"));
    const afterLocality = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    repository.ingest(createIngestion([{
      ...createListing(),
      coordinates: propertyCoordinates,
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-property"));
    repository.ingest(createIngestion([{
      ...createListing(),
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-without-coordinates"));

    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(afterLocality?.coordinates?.locationKind).toBe("source-locality");
    expect(canonical?.coordinates).toEqual(propertyCoordinates);
    expect(repository.getRun("run-locality")?.listings[0]?.coordinates?.locationKind).toBe("source-locality");
    expect(repository.getRun("run-without-coordinates")?.listings[0]).not.toHaveProperty("coordinates");
  });

  it("prefers the newest verification at equal quality and replays it idempotently", () => {
    const repository = createMemoryRepository();
    const olderVerification = createIngestion([{
      ...createListing(),
      coordinates: {
        latitude: 47.85,
        longitude: -3.85,
        verifiedAt: "2026-07-18T08:00:00.000Z",
        provenance: "leboncoin:api:location:old",
        locationKind: "source-locality",
      },
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-old-verification");
    const newerVerification = createIngestion([{
      ...createListing(),
      coordinates: {
        latitude: 47.86,
        longitude: -3.86,
        verifiedAt: "2026-07-18T11:00:00.000Z",
        provenance: "leboncoin:api:location:new",
        locationKind: "source-locality",
      },
      scrapedAt: "2026-07-18T09:00:00.000Z",
    }], "run-new-verification");
    repository.ingest(olderVerification);
    repository.ingest(newerVerification);

    const replay = repository.ingest(newerVerification);
    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(replay).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(canonical?.coordinates).toMatchObject({
      latitude: 47.86,
      longitude: -3.86,
      verifiedAt: "2026-07-18T11:00:00.000Z",
      locationKind: "source-locality",
    });
  });

  it("keeps the first verification time when an identical observation repeats in a later run", () => {
    const repository = createMemoryRepository();
    const coordinates = {
      latitude: 47.85,
      longitude: -3.85,
      verifiedAt: "2026-07-18T08:00:00.000Z",
      provenance: "leboncoin:__NEXT_DATA__:source-locality",
      locationKind: "source-locality" as const,
    };
    repository.ingest(createIngestion([{
      ...createListing(),
      coordinates,
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-first-observation"));
    repository.ingest(createIngestion([{
      ...createListing(),
      coordinates: {
        ...coordinates,
        verifiedAt: "2026-07-18T11:00:00.000Z",
      },
      scrapedAt: "2026-07-18T11:00:00.000Z",
    }], "run-repeated-observation"));

    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });
    const repeatedRun = repository.getRun("run-repeated-observation");

    expect(canonical?.coordinates).toEqual(coordinates);
    expect(repeatedRun?.listings[0]?.coordinates?.verifiedAt).toBe("2026-07-18T11:00:00.000Z");
  });

  it("keeps per-run observation history while retaining one canonical listing", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([createListing()]));
    repository.ingest({
      ...createIngestion([createListing()]),
      run: { id: "run-2", source: "leboncoin", status: "completed", startedAt: "2026-07-18T11:00:00.000Z" },
    });

    const listing = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(listing?.runs.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
    expect(repository.listListings({ limit: 20, sort: "updatedAt", order: "desc" }).total).toBe(1);
  });

  it("returns each run snapshot instead of the canonical data enriched by later runs", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([createListing()], "run-old"));
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Titre du run récent",
      priceEuros: 275_000,
      status: "listing",
      scrapedAt: "2026-07-18T11:00:00.000Z",
    }], "run-new"));

    const oldSnapshot = repository.getRun("run-old")?.listings[0];
    const newSnapshot = repository.getRun("run-new")?.listings[0];
    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(oldSnapshot).toMatchObject({
      lastRunId: "run-old",
      title: "Maison détaillée",
      priceEuros: 250_000,
      description: "Description complète avec jardin et garage.",
    });
    expect(newSnapshot).toMatchObject({
      lastRunId: "run-new",
      title: "Titre du run récent",
      priceEuros: 275_000,
      firstSeenAt: "2026-07-18T11:00:00.000Z",
      lastSeenAt: "2026-07-18T11:00:00.000Z",
      updatedAt: "2026-07-18T11:00:00.000Z",
    });
    expect(newSnapshot).not.toHaveProperty("description");
    expect(canonical).toMatchObject({
      lastRunId: "run-new",
      title: "Titre du run récent",
      priceEuros: 275_000,
      description: "Description complète avec jardin et garage.",
      firstSeenAt: "2026-07-18T09:20:00.000Z",
      lastSeenAt: "2026-07-18T11:00:00.000Z",
    });
  });

  it("rebuilds canonical fields by observation time when runs arrive out of order", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Titre le plus récent",
      priceEuros: 300_000,
      features: ["Patio"],
      status: "listing",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-new"));
    repository.ingest(createIngestion([{
      ...createListing(),
      title: "Titre ancien arrivé tard",
      priceEuros: 240_000,
      features: ["Jardin", "Garage"],
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-old"));

    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(canonical).toMatchObject({
      title: "Titre le plus récent",
      priceEuros: 300_000,
      status: "detailed",
      description: "Description complète avec jardin et garage.",
      features: ["Jardin", "Garage", "Patio"],
      firstSeenAt: "2026-07-18T08:00:00.000Z",
      lastSeenAt: "2026-07-18T12:00:00.000Z",
      lastRunId: "run-new",
    });
  });

  it("merges an older rich observation into the same run without lowering its latest timestamp", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Snapshot courant",
      priceEuros: 300_000,
      status: "listing",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-1"));
    const replay = repository.ingest(createIngestion([{
      ...createListing(),
      title: "Replay plus vieux",
      priceEuros: 200_000,
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-1"));

    const snapshot = repository.getRun("run-1")?.listings[0];
    const canonical = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(replay).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(snapshot).toMatchObject({
      title: "Snapshot courant",
      priceEuros: 300_000,
      status: "detailed",
      description: "Description complète avec jardin et garage.",
      features: ["Jardin", "Garage"],
      firstSeenAt: "2026-07-18T08:00:00.000Z",
      lastSeenAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    });
    expect(canonical).toMatchObject({
      title: "Snapshot courant",
      priceEuros: 300_000,
      description: "Description complète avec jardin et garage.",
      lastRunId: "run-1",
    });
  });

  it("never lets older scalar values overwrite newer values within the same run", () => {
    const repository = createMemoryRepository();
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Titre t12",
      priceEuros: 300_000,
      location: "Brest 29200",
      status: "listing",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-1"));
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      title: "Titre t08",
      priceEuros: 200_000,
      location: "Quimper 29000",
      status: "listing",
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-1"));

    const snapshot = repository.getRun("run-1")?.listings[0];

    expect(snapshot).toMatchObject({
      title: "Titre t12",
      priceEuros: 300_000,
      location: "Brest 29200",
      firstSeenAt: "2026-07-18T08:00:00.000Z",
      lastSeenAt: "2026-07-18T12:00:00.000Z",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    });
  });

  it("normalizes fifty image URLs plus a distinct compatibility image without failing", () => {
    const repository = createMemoryRepository();
    const gallery = Array.from(
      { length: 50 },
      (_, index) => `https://img.leboncoin.fr/gallery-${index}.jpg`,
    );

    const result = repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      imageUrl: "https://img.leboncoin.fr/primary.jpg",
      imageUrls: gallery,
      status: "detailed",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }]));
    const listing = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(result).toMatchObject({ inserted: 1 });
    expect(listing?.imageUrls).toHaveLength(50);
    expect(listing?.imageUrls?.[0]).toBe("https://img.leboncoin.fr/primary.jpg");
    expect(listing?.imageUrls).not.toContain(gallery.at(-1));
  });

  it("caps merged image and feature arrays from independently valid snapshots", () => {
    const repository = createMemoryRepository();
    const oldImages = Array.from(
      { length: 30 },
      (_, index) => `https://img.leboncoin.fr/old-${index}.jpg`,
    );
    const newImages = Array.from(
      { length: 30 },
      (_, index) => `https://img.leboncoin.fr/new-${index}.jpg`,
    );
    const oldFeatures = Array.from({ length: 60 }, (_, index) => `Old feature ${index}`);
    const newFeatures = Array.from({ length: 60 }, (_, index) => `New feature ${index}`);
    repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      imageUrls: oldImages,
      features: oldFeatures,
      status: "detailed",
      scrapedAt: "2026-07-18T08:00:00.000Z",
    }], "run-old"));

    const result = repository.ingest(createIngestion([{
      source: "leboncoin",
      externalId: "2876543210",
      url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
      imageUrls: newImages,
      features: newFeatures,
      status: "detailed",
      scrapedAt: "2026-07-18T12:00:00.000Z",
    }], "run-new"));
    const listing = repository.getListing({ source: "leboncoin", externalId: "2876543210" });

    expect(result).toMatchObject({ updated: 1 });
    expect(listing?.imageUrls).toHaveLength(50);
    expect(listing?.imageUrls?.slice(0, 30)).toEqual(newImages);
    expect(listing?.features).toHaveLength(100);
    expect(listing?.features?.slice(0, 60)).toEqual(oldFeatures);
  });
});

function createMemoryRepository(): DenicheurRepository {
  return new DenicheurRepository({ path: ":memory:", now: () => NOW });
}

function createIngestion(listings: ListingIngestion[], runId = "run-1"): IngestionRequest {
  return {
    run: {
      id: runId,
      source: "leboncoin",
      status: "completed",
      startedAt: "2026-07-18T09:00:00.000Z",
      finishedAt: "2026-07-18T09:30:00.000Z",
      collected: listings.length,
    },
    listings,
  };
}

function createListing(): ListingIngestion {
  return {
    source: "leboncoin",
    externalId: "2876543210",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/2876543210",
    title: "Maison détaillée",
    priceEuros: 250_000,
    surfaceM2: 85,
    description: "Description complète avec jardin et garage.",
    imageUrl: "https://img.leboncoin.fr/example-1.jpg",
    imageUrls: ["https://img.leboncoin.fr/example-1.jpg", "https://img.leboncoin.fr/example-2.jpg"],
    features: ["Jardin", "Garage"],
    status: "detailed",
    scrapedAt: "2026-07-18T09:20:00.000Z",
  };
}
