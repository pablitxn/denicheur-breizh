import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});
