import type { ListingFilters } from "../types";

export const queryKeys = {
  health: {
    all: ["health"] as const,
  },
  listings: {
    all: ["listings"] as const,
    lists: () => [...queryKeys.listings.all, "list"] as const,
    list: (filters?: ListingFilters) => [...queryKeys.listings.lists(), filters ?? {}] as const,
    details: () => [...queryKeys.listings.all, "detail"] as const,
    detail: (source: string, externalId: string) =>
      [...queryKeys.listings.details(), source, externalId] as const,
  },
  runs: {
    all: ["runs"] as const,
    lists: () => [...queryKeys.runs.all, "list"] as const,
    detail: (runId: string) => [...queryKeys.runs.all, "detail", runId] as const,
  },
  recipes: {
    all: ["recipes"] as const,
    lists: () => [...queryKeys.recipes.all, "list"] as const,
    active: () => [...queryKeys.recipes.all, "active"] as const,
  },
} as const;
