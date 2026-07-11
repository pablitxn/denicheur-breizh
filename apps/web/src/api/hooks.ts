import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { denicheurApi } from "./denicheurApi";
import { queryKeys } from "./queryKeys";
import type { PropertyFilters, ScoringRecipe } from "../types";

export function useProperties(filters?: Partial<PropertyFilters>) {
  return useQuery({
    queryKey: queryKeys.properties.list(filters),
    queryFn: ({ signal }) => denicheurApi.listProperties(filters, signal),
  });
}

export function useScorings() {
  return useQuery({
    queryKey: queryKeys.scorings.all,
    queryFn: ({ signal }) => denicheurApi.listScorings(signal),
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: queryKeys.recipes.all,
    queryFn: ({ signal }) => denicheurApi.listRecipes(signal),
  });
}

export function useSaveRecipe() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (recipe: ScoringRecipe) => denicheurApi.saveRecipe(recipe),
    onSuccess: (recipe) => {
      queryClient.setQueryData<ScoringRecipe[]>(queryKeys.recipes.all, (current = []) => {
        const exists = current.some((item) => item.id === recipe.id);
        return exists ? current.map((item) => (item.id === recipe.id ? recipe : item)) : [...current, recipe];
      });
    },
  });
}
