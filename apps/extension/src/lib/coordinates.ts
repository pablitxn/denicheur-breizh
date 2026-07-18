import {
  verifiedCoordinatesSchema,
  type VerifiedCoordinates,
} from "@denicheur-breizh/contracts";
import type { CoordinateEvidence } from "./types";

const COORDINATE_KIND_RANK: Record<VerifiedCoordinates["locationKind"], number> = {
  "postal-code-centroid": 1,
  "locality-centroid": 1,
  "source-locality": 2,
  "source-property": 3,
};

export function coordinateEvidenceToVerifiedCoordinates(
  evidence: CoordinateEvidence | undefined,
  verifiedAt: string,
): VerifiedCoordinates | undefined {
  if (!evidence) return undefined;
  return normalizeVerifiedCoordinates({ ...evidence, verifiedAt });
}

export function normalizeVerifiedCoordinates(value: unknown): VerifiedCoordinates | undefined {
  const parsed = verifiedCoordinatesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function selectBestCoordinates(
  existingValue: unknown,
  incomingValue: unknown,
): VerifiedCoordinates | undefined {
  const existing = normalizeVerifiedCoordinates(existingValue);
  const incoming = normalizeVerifiedCoordinates(incomingValue);
  if (!existing) return incoming;
  if (!incoming) return existing;

  const existingRank = COORDINATE_KIND_RANK[existing.locationKind];
  const incomingRank = COORDINATE_KIND_RANK[incoming.locationKind];
  if (existingRank !== incomingRank) return incomingRank > existingRank ? incoming : existing;

  if (
    existing.latitude === incoming.latitude &&
    existing.longitude === incoming.longitude &&
    existing.provenance === incoming.provenance
  ) return existing;

  return Date.parse(incoming.verifiedAt) > Date.parse(existing.verifiedAt) ? incoming : existing;
}
