import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CaptureRequest } from "@denicheur-breizh/collector-contracts";

export type CaptureDraft = CaptureRequest & { urlsText: string };
export const initialDraft: CaptureDraft = {
  source: "leboncoin", provider: "xai", mode: "search", name: "", urls: [], urlsText: "",
  filters: { category: "sale", text: "", location: "", propertyTypes: ["house", "apartment"], seller: "all", sort: "recent" },
};
export const useDraft = create<{ draft: CaptureDraft; update: (patch: Partial<CaptureDraft>) => void }>()(persist((set) => ({
  draft: initialDraft,
  update: (patch) => set((state) => ({ draft: { ...state.draft, ...patch } })),
}), {
  name: "denicheur:collector-draft", version: 1, partialize: ({ draft }) => ({ draft }),
  migrate: (persisted) => {
    const draft = persisted && typeof persisted === "object" && "draft" in persisted ? (persisted as { draft: CaptureDraft }).draft : initialDraft;
    // Before strategy defaults changed, a saved Firecrawl draft without an explicit strategy meant v1.
    return { draft: draft.provider === "firecrawl" && !draft.strategy ? { ...draft, strategy: "firecrawl-agent-scrape-v1" as const } : draft };
  },
}));

export function draftRequest(draft: CaptureDraft): CaptureRequest {
  const { urlsText, ...request } = draft;
  return { ...request, name: request.name.trim(), searchUrl: request.searchUrl?.trim() || undefined,
    urls: request.mode === "urls" ? [...new Set(urlsText.split(/\s+/).map((url) => url.trim()).filter(Boolean))] : [],
  };
}
