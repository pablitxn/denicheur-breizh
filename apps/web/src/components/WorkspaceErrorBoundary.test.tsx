import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";

function BrokenView(): never {
  throw new Error("chunk failed");
}

describe("WorkspaceErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers a localized recovery action and resets for another view", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <WorkspaceErrorBoundary message="Unable to load this view." resetKey="map" retryLabel="Try again">
        <BrokenView />
      </WorkspaceErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load this view.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();

    rerender(
      <WorkspaceErrorBoundary message="Unable to load this view." resetKey="properties" retryLabel="Try again">
        <p>Recovered view</p>
      </WorkspaceErrorBoundary>,
    );
    expect(screen.getByText("Recovered view")).toBeVisible();
  });
});
