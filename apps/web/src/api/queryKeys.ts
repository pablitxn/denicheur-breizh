import type { EvaluationExecution, ListingFilters } from "../types";

export const queryKeys = {
  health: {
    all: ["health"] as const,
  },
  listings: {
    all: ["listings"] as const,
    metadata: () => [...queryKeys.listings.all, "metadata"] as const,
    map: () => [...queryKeys.listings.all, "map"] as const,
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
  evaluationPlans: {
    all: ["evaluation-plans"] as const,
    lists: () => [...queryKeys.evaluationPlans.all, "list"] as const,
    default: () => [...queryKeys.evaluationPlans.all, "default"] as const,
    detail: (id: string, version: number) => [...queryKeys.evaluationPlans.all, "detail", id, version] as const,
  },
  evaluationExecutions: {
    all: ["evaluation-executions"] as const,
    lists: () => [...queryKeys.evaluationExecutions.all, "list"] as const,
    list: (filters?: { runId?: string; status?: EvaluationExecution["status"] }) =>
      [...queryKeys.evaluationExecutions.lists(), filters ?? {}] as const,
    details: () => [...queryKeys.evaluationExecutions.all, "detail"] as const,
    detail: (id: string) => [...queryKeys.evaluationExecutions.details(), id] as const,
    results: (id: string) => [...queryKeys.evaluationExecutions.detail(id), "results"] as const,
  },
} as const;
