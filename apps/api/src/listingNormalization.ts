import {
  MAX_LISTING_FEATURES,
  MAX_LISTING_IMAGE_URLS,
  listingIngestionSchema,
  type ListingIngestion,
  type VerifiedCoordinates,
} from "./contracts.js";

export const LISTING_NORMALIZATION_VERSION = "listing-projection-v1";

export function normalizeListing(listing: ListingIngestion): ListingIngestion {
  const imageUrls = uniqueStrings([
    ...(listing.imageUrl ? [listing.imageUrl] : []),
    ...(listing.imageUrls ?? []),
  ]).slice(0, MAX_LISTING_IMAGE_URLS);
  return listingIngestionSchema.parse({
    ...listing,
    ...(imageUrls.length ? { imageUrl: imageUrls[0], imageUrls } : {}),
    ...(listing.features
      ? { features: uniqueStrings(listing.features).slice(0, MAX_LISTING_FEATURES) }
      : {}),
  });
}

export function mergeOrderedListings(olderValue: ListingIngestion, newerValue: ListingIngestion): ListingIngestion {
  const older = normalizeListing(olderValue);
  const newer = normalizeListing(newerValue);
  const rank = { failed: 0, listing: 1, detailed: 2 } as const;
  const raw: Record<string, unknown> = { ...older, ...newer };
  const imageUrls = uniqueStrings([...(newer.imageUrls ?? []), ...(older.imageUrls ?? [])])
    .slice(0, MAX_LISTING_IMAGE_URLS);
  const features = uniqueStrings([...(older.features ?? []), ...(newer.features ?? [])])
    .slice(0, MAX_LISTING_FEATURES);

  raw.status = rank[newer.status] > rank[older.status] ? newer.status : older.status;
  raw.scrapedAt = maxIso(older.scrapedAt, newer.scrapedAt);
  raw.description = longerText(older.description, newer.description);
  raw.rawTextSample = longerText(older.rawTextSample, newer.rawTextSample);
  const coordinates = selectPreferredCoordinates(older.coordinates, newer.coordinates);
  if (coordinates) raw.coordinates = coordinates;
  else delete raw.coordinates;
  if (features.length) raw.features = features;
  if (imageUrls.length) {
    raw.imageUrl = newer.imageUrl ?? older.imageUrl ?? imageUrls[0];
    raw.imageUrls = imageUrls;
  }
  return listingIngestionSchema.parse(raw);
}

const COORDINATE_LOCATION_KIND_RANK: Readonly<Record<VerifiedCoordinates["locationKind"], number>> = {
  "source-property": 3,
  "source-locality": 2,
  "locality-centroid": 1,
  "postal-code-centroid": 1,
};

function selectPreferredCoordinates(
  first: VerifiedCoordinates | undefined,
  second: VerifiedCoordinates | undefined,
): VerifiedCoordinates | undefined {
  if (!first) return second;
  if (!second) return first;

  const rankDifference = COORDINATE_LOCATION_KIND_RANK[first.locationKind] -
    COORDINATE_LOCATION_KIND_RANK[second.locationKind];
  if (rankDifference !== 0) return rankDifference > 0 ? first : second;

  if (
    first.locationKind === second.locationKind &&
    first.latitude === second.latitude &&
    first.longitude === second.longitude &&
    first.provenance === second.provenance
  ) return first;

  const verifiedAtDifference = Date.parse(first.verifiedAt) - Date.parse(second.verifiedAt);
  if (verifiedAtDifference !== 0) return verifiedAtDifference > 0 ? first : second;

  return JSON.stringify(first).localeCompare(JSON.stringify(second)) >= 0 ? first : second;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function longerText(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return second.length > first.length ? second : first;
}

function maxIso(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return first >= second ? first : second;
}
