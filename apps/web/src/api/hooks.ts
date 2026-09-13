import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { denicheurApi, type ConditionalValue, type MapCatalog } from "./denicheurApi";
import type { ListingsMetadata } from "@denicheur-breizh/contracts";
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
    queryFn: ({ signal }) => denicheurApi.listProperties(filters, signal),
    placeholderData: keepPreviousData,
    // The catalog revision invalidates page one. Later pages stay on their immutable snapshot.
    refetchOnWindowFocus: !filters?.cursor,
    refetchOnReconnect: !filters?.cursor,
    staleTime: filters?.cursor ? Infinity : 5_000,
  });
}

export function useListingsMetadata() {
  const client = useQueryClient();
  const key = queryKeys.listings.metadata();
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => denicheurApi.listingsMetadata(client.getQueryData<ConditionalValue<ListingsMetadata>>(key), signal),
    select: (data) => data.value,
    ...liveQueryOptions,
  });
}

export function useMapListings(enabled = true) {
  const client = useQueryClient();
  const key = queryKeys.listings.map();
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => denicheurApi.listMapCatalog(client.getQueryData<ConditionalValue<MapCatalog>>(key), signal),
    select: (data) => data.value,
    ...liveQueryOptions,
    enabled,
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

export function useSourceRecords(source: string, externalId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.sourceRecords.history(source, externalId),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ signal, pageParam }) => denicheurApi.listSourceRecords(source, externalId, pageParam, signal),
    getNextPageParam: (last) => last.nextBeforeSequence,
    select: (data) => data.pages.flatMap((page) => page.items),
    staleTime: 30_000,
    enabled: Boolean(source && externalId),
  });
}

export function useSourceRecord(id: string) {
  return useQuery({
    queryKey: queryKeys.sourceRecords.detail(id),
    queryFn: ({ signal }) => denicheurApi.getSourceRecord(id, signal),
    // A capture is immutable; opening it again can reuse the verified response.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: Boolean(id),
  });
}

export function useRuns() {
  return useInfiniteQuery({
    queryKey: queryKeys.runs.lists(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => denicheurApi.listRuns(signal, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => ({ ...data.pages[0]!, items: data.pages.flatMap((page) => page.items) }),
    ...liveQueryOptions,
    refetchInterval: (query) => query.state.data?.pages.length === 1 ? visibleRefetchInterval() : false,
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
  return useInfiniteQuery({
    queryKey: queryKeys.evaluationExecutions.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => denicheurApi.listEvaluationExecutions(filters, signal, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => ({ ...data.pages[0]!, items: data.pages.flatMap((page) => page.items) }),
    refetchInterval: (query) => query.state.data?.pages.length === 1 && query.state.data.pages[0]?.items.some((item) => !isExecutionTerminal(item.status)) ? 2_000 : false,
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
