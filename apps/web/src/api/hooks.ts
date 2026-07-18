import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { denicheurApi } from "./denicheurApi";
import { queryKeys } from "./queryKeys";
import type { IntelligenceRecipe, ListingFilters, RecipeDraft } from "../types";

const visibleRefetchInterval = () =>
  typeof document !== "undefined" && document.visibilityState === "visible" ? 5_000 : false;

const liveQueryOptions = {
  refetchInterval: visibleRefetchInterval,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health.all,
    queryFn: ({ signal }) => denicheurApi.health(signal),
    ...liveQueryOptions,
  });
}

export function useListings(filters?: ListingFilters) {
  return useQuery({
    queryKey: queryKeys.listings.list(filters),
    queryFn: ({ signal }) => denicheurApi.listAllProperties(filters, signal),
    placeholderData: keepPreviousData,
    ...liveQueryOptions,
  });
}

export function useListing(source?: string, externalId?: string) {
  return useQuery({
    queryKey: queryKeys.listings.detail(source ?? "", externalId ?? ""),
    queryFn: ({ signal }) => denicheurApi.getProperty(source!, externalId!, signal),
    enabled: Boolean(source && externalId),
    ...liveQueryOptions,
  });
}

export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs.lists(),
    queryFn: ({ signal }) => denicheurApi.listRuns(signal),
    ...liveQueryOptions,
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: queryKeys.recipes.lists(),
    queryFn: ({ signal }) => denicheurApi.listRecipes(signal),
    ...liveQueryOptions,
  });
}

export function useActiveRecipe() {
  return useQuery({
    queryKey: queryKeys.recipes.active(),
    queryFn: ({ signal }) => denicheurApi.getActiveRecipe(signal),
    ...liveQueryOptions,
  });
}

export function useSaveRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipe: RecipeDraft) => denicheurApi.saveRecipe(recipe),
    onSuccess: async (saved) => {
      queryClient.setQueryData<IntelligenceRecipe[]>(queryKeys.recipes.lists(), (current = []) => {
        const withoutSameVersion = current.filter((recipe) => recipe.id !== saved.id || recipe.version !== saved.version);
        return [saved, ...withoutSameVersion];
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.recipes.lists() });
    },
  });
}

export function useActivateRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => denicheurApi.activateRecipe(id, version),
    onSuccess: async (activated) => {
      queryClient.setQueryData<IntelligenceRecipe[]>(queryKeys.recipes.lists(), (current = []) =>
        current.map((recipe) => ({ ...recipe, active: recipe.id === activated.id && recipe.version === activated.version })),
      );
      queryClient.setQueryData(queryKeys.recipes.active(), activated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.recipes.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.recipes.active() }),
      ]);
    },
  });
}
