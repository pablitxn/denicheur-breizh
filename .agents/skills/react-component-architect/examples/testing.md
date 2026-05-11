# React Testing Examples

## Basic Component Test

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ComponentName } from "./ComponentName";

describe("ComponentName", () => {
  it("renders children", () => {
    render(<ComponentName>Hello</ComponentName>);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("applies variant class", () => {
    const { container } = render(<ComponentName variant="secondary" />);
    expect(container.firstChild).toHaveClass("secondary");
  });

  it("handles click when not disabled", () => {
    const onClick = vi.fn();
    render(<ComponentName onClick={onClick}>Click me</ComponentName>);
    fireEvent.click(screen.getByText("Click me"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not fire click when disabled", () => {
    const onClick = vi.fn();
    render(
      <ComponentName onClick={onClick} disabled>
        Click me
      </ComponentName>,
    );
    fireEvent.click(screen.getByText("Click me"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies custom className", () => {
    const { container } = render(<ComponentName className="custom" />);
    expect(container.firstChild).toHaveClass("custom");
  });
});
```

## Testing with User Events

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Form } from "./Form";

describe("Form", () => {
  it("submits form data", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    render(<Form onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Email"), "test@example.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onSubmit).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "password123",
    });
  });
});
```

## Testing Async Components

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UserList } from "./UserList";

// Mock the API
vi.mock("@/api", () => ({
  fetchUsers: vi.fn().mockResolvedValue([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]),
}));

describe("UserList", () => {
  it("loads and displays users", async () => {
    render(<UserList />);

    // Initially shows loading
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    // Wait for data
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });
  });
});
```

## Testing with Context

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { ThemedButton } from "./ThemedButton";

const renderWithTheme = (ui: React.ReactElement, theme = "light") => {
  return render(<ThemeProvider initialTheme={theme}>{ui}</ThemeProvider>);
};

describe("ThemedButton", () => {
  it("applies light theme styles", () => {
    const { container } = renderWithTheme(<ThemedButton>Click</ThemedButton>);
    expect(container.firstChild).toHaveClass("light");
  });

  it("applies dark theme styles", () => {
    const { container } = renderWithTheme(
      <ThemedButton>Click</ThemedButton>,
      "dark",
    );
    expect(container.firstChild).toHaveClass("dark");
  });
});
```

## Testing Custom Hooks

```tsx
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useCounter } from "./useCounter";

describe("useCounter", () => {
  it("initializes with default value", () => {
    const { result } = renderHook(() => useCounter());
    expect(result.current.count).toBe(0);
  });

  it("initializes with provided value", () => {
    const { result } = renderHook(() => useCounter(10));
    expect(result.current.count).toBe(10);
  });

  it("increments count", () => {
    const { result } = renderHook(() => useCounter());

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(1);
  });

  it("decrements count", () => {
    const { result } = renderHook(() => useCounter(5));

    act(() => {
      result.current.decrement();
    });

    expect(result.current.count).toBe(4);
  });
});
```

## Snapshot Testing

```tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ComponentName } from "./ComponentName";

describe("ComponentName snapshots", () => {
  it("matches primary variant snapshot", () => {
    const { container } = render(
      <ComponentName variant="primary">Primary</ComponentName>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("matches disabled snapshot", () => {
    const { container } = render(
      <ComponentName disabled>Disabled</ComponentName>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
```
