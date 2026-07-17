import type { WorkspaceView } from "../types";

export const workspaceUrlChangeEvent = "denicheur:workspace-url-change";

const workspaceViews = new Set<WorkspaceView>([
  "map",
  "properties",
  "scorings",
  "builder",
  "realtime",
]);

export function parseWorkspaceView(search: string): WorkspaceView | undefined {
  const value = new URLSearchParams(search).get("view");
  return value && workspaceViews.has(value as WorkspaceView) ? (value as WorkspaceView) : undefined;
}

export function workspaceViewHref(view: WorkspaceView, currentHref?: string): string {
  const href = currentHref ?? (typeof window === "undefined" ? "http://localhost/" : window.location.href);
  const url = new URL(href);
  url.searchParams.set("view", view);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type WorkspaceSearchParamValue = string | number | boolean | null | undefined;

export function workspaceSearchHref(
  updates: Record<string, WorkspaceSearchParamValue>,
  currentHref?: string,
): string {
  const href = currentHref ?? (typeof window === "undefined" ? "http://localhost/" : window.location.href);
  const url = new URL(href);

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function commitWorkspaceHref(href: string, mode: "push" | "replace" = "replace") {
  if (typeof window === "undefined") return;

  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", href);
  window.dispatchEvent(new CustomEvent(workspaceUrlChangeEvent));
}
