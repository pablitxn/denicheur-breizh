import type { WorkspaceView } from "../types";

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
