import type { CopyKey } from "./copy";

export function strategyLabel(id: string, t: (key: CopyKey) => string, fallback?: string): string {
  const labels: Record<string, CopyKey> = {
    "xai-web-search-v1": "strategyXai",
    "firecrawl-agent-scrape-v1": "strategyPage",
    "firecrawl-agent-native-v2": "strategyNative",
    "firecrawl-agent-expanded-v3": "strategyExpanded",
  };
  return labels[id] ? t(labels[id]) : fallback ?? id;
}
