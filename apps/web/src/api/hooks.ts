import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { denicheurApi } from "./denicheurApi";
import { queryKeys } from "./queryKeys";
import type {
  EvaluationExecution,
  EvaluationPlan,
  EvaluationPlanDraft,
  IntelligenceRecipe,
  ListingFilters,
  RecipeDraft,
  StartEvaluationExecutionInput,
} from "../types";

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

export function useRun(runId?: string) {
  return useQuery({
    queryKey: queryKeys.runs.detail(runId ?? ""),
    queryFn: ({ signal }) => denicheurApi.getRun(runId!, signal),
    enabled: Boolean(runId),
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

export function useEvaluationPlans() {
  return useQuery({
    queryKey: queryKeys.evaluationPlans.lists(),
    queryFn: ({ signal }) => denicheurApi.listEvaluationPlans(signal),
    ...liveQueryOptions,
  });
}

export function useDefaultEvaluationPlan() {
  return useQuery({
    queryKey: queryKeys.evaluationPlans.default(),
    queryFn: ({ signal }) => denicheurApi.getDefaultEvaluationPlan(signal),
    ...liveQueryOptions,
  });
}

export function useSaveEvaluationPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plan: EvaluationPlanDraft) => denicheurApi.saveEvaluationPlan(plan),
    onSuccess: async (saved) => {
      queryClient.setQueryData<EvaluationPlan[]>(queryKeys.evaluationPlans.lists(), (current = []) => {
        const withoutSameVersion = current.filter((plan) => plan.id !== saved.id || plan.version !== saved.version);
        return [saved, ...withoutSameVersion];
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.evaluationPlans.lists() });
    },
  });
}

export function useSetDefaultEvaluationPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      denicheurApi.setDefaultEvaluationPlan(id, version),
    onSuccess: async (selected) => {
      queryClient.setQueryData<EvaluationPlan[]>(queryKeys.evaluationPlans.lists(), (current = []) =>
        current.map((plan) => ({
          ...plan,
          isDefault: plan.id === selected.id && plan.version === selected.version,
        })),
      );
      queryClient.setQueryData(queryKeys.evaluationPlans.default(), selected);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.evaluationPlans.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.evaluationPlans.default() }),
      ]);
    },
  });
}

export function useEvaluationExecutions(filters?: { runId?: string; status?: EvaluationExecution["status"] }) {
  return useQuery({
    queryKey: queryKeys.evaluationExecutions.list(filters),
    queryFn: ({ signal }) => denicheurApi.listEvaluationExecutions(filters, signal),
    refetchInterval: (query) => query.state.data?.items.some((item) => !isExecutionTerminal(item.status)) ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useEvaluationExecution(executionId?: string) {
  return useQuery({
    queryKey: queryKeys.evaluationExecutions.detail(executionId ?? ""),
    queryFn: ({ signal }) => denicheurApi.getEvaluationExecution(executionId!, signal),
    enabled: Boolean(executionId),
    refetchInterval: (query) => executionPollingInterval(query.state.data?.status),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useEvaluationExecutionResults(executionId?: string, status?: EvaluationExecution["status"]) {
  return useQuery({
    queryKey: queryKeys.evaluationExecutions.results(executionId ?? ""),
    queryFn: ({ signal }) => denicheurApi.getEvaluationExecutionResults(executionId!, signal),
    enabled: Boolean(executionId),
    refetchInterval: () => executionPollingInterval(status),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useStartEvaluationExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartEvaluationExecutionInput) => denicheurApi.startEvaluationExecution(input),
    onSuccess: async (created) => {
      queryClient.setQueryData(queryKeys.evaluationExecutions.detail(created.id), created);
      await queryClient.invalidateQueries({ queryKey: queryKeys.evaluationExecutions.lists() });
    },
  });
}

export function useRetryEvaluationExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      denicheurApi.retryEvaluationExecution(id, idempotencyKey),
    onSuccess: async (created) => {
      queryClient.setQueryData(queryKeys.evaluationExecutions.detail(created.id), created);
      await queryClient.invalidateQueries({ queryKey: queryKeys.evaluationExecutions.lists() });
    },
  });
}

export function useCancelEvaluationExecution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => denicheurApi.cancelEvaluationExecution(id),
    onSuccess: async (cancelled) => {
      queryClient.setQueryData(queryKeys.evaluationExecutions.detail(cancelled.id), cancelled);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.evaluationExecutions.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.evaluationExecutions.results(cancelled.id) }),
      ]);
    },
  });
}

export function isExecutionTerminal(status?: EvaluationExecution["status"]): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
}

export function executionPollingInterval(status?: EvaluationExecution["status"]): number | false {
  return status && !isExecutionTerminal(status) ? 2_000 : false;
}

export function createIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
