import { Button, Chip } from "@denicheur-breizh/design-system";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("design system interaction defaults", () => {
  it("keeps ordinary buttons from submitting a surrounding form", () => {
    const onSubmit = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Button>Secondary action</Button>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Secondary action" });
    expect(button).toHaveAttribute("type", "button");
  });

  it("exposes interactive chip state to assistive technology", () => {
    render(<Chip active onClick={() => undefined}>SeLoger</Chip>);

    expect(screen.getByRole("button", { name: "SeLoger" })).toHaveAttribute("aria-pressed", "true");
  });
});
