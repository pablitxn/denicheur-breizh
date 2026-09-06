import { QueryClient } from "@tanstack/react-query";
import { isExpiredCursor } from "./denicheurApi";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      gcTime: 1000 * 60 * 30,
      retry: (count, error) => !isExpiredCursor(error) && count < 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});
