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
}), { name: "denicheur:collector-draft", partialize: ({ draft }) => ({ draft }) }));

export function draftRequest(draft: CaptureDraft): CaptureRequest {
  const { urlsText, ...request } = draft;
  return { ...request, name: request.name.trim(), searchUrl: request.searchUrl?.trim() || undefined,
    urls: request.mode === "urls" ? [...new Set(urlsText.split(/\s+/).map((url) => url.trim()).filter(Boolean))] : [],
  };
}
