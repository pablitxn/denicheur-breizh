import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { denicheurApi } from "./denicheurApi";
import { queryKeys } from "./queryKeys";
import type { PropertyFilters, ScoringRecipe } from "../types";

export function useProperties(filters?: Partial<PropertyFilters>) {
  return useQuery({
    queryKey: queryKeys.properties.list(filters),
    queryFn: () => denicheurApi.listProperties(filters),
  });
}

export function useScorings() {
  return useQuery({
    queryKey: queryKeys.scorings.all,
    queryFn: () => denicheurApi.listScorings(),
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: queryKeys.recipes.all,
    queryFn: () => denicheurApi.listRecipes(),
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
