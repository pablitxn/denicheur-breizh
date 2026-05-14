import type { PropertyFilters } from "../types";

export const queryKeys = {
  properties: {
    all: ["properties"] as const,
    list: (filters?: Partial<PropertyFilters>) => [...queryKeys.properties.all, filters ?? {}] as const,
  },
  scorings: {
    all: ["scorings"] as const,
  },
  recipes: {
    all: ["recipes"] as const,
  },
};
