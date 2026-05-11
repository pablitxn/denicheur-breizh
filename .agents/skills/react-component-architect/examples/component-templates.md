# React Component Templates

## Standard FC Component

```tsx
import { type FC } from "react";
import styles from "./ComponentName.module.css";

export interface ComponentNameProps {
  /** Primary content */
  children?: React.ReactNode;
  /** Additional CSS class */
  className?: string;
  /** Visual variant */
  variant?: "primary" | "secondary";
  /** Disabled state */
  disabled?: boolean;
  /** Click handler */
  onClick?: () => void;
}

export const ComponentName: FC<ComponentNameProps> = ({
  children,
  className,
  variant = "primary",
  disabled = false,
  onClick,
}) => {
  return (
    <div
      className={`${styles.root} ${styles[variant]} ${className ?? ""}`}
      data-disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </div>
  );
};
```

## With forwardRef (for DOM access)

```tsx
import { forwardRef, type ComponentPropsWithRef } from "react";
import styles from "./ComponentName.module.css";

export interface ComponentNameProps extends ComponentPropsWithRef<"button"> {
  variant?: "primary" | "secondary";
}

export const ComponentName = forwardRef<HTMLButtonElement, ComponentNameProps>(
  ({ variant = "primary", className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`${styles.root} ${styles[variant]} ${className ?? ""}`}
        {...props}
      >
        {children}
      </button>
    );
  },
);

ComponentName.displayName = "ComponentName";
```

## With Hooks Pattern

```tsx
import { type FC, useState, useCallback } from "react";
import styles from "./ComponentName.module.css";

export interface ComponentNameProps {
  initialValue?: string;
  onChange?: (value: string) => void;
}

export const ComponentName: FC<ComponentNameProps> = ({
  initialValue = "",
  onChange,
}) => {
  const [value, setValue] = useState(initialValue);

  const handleChange = useCallback(
    (newValue: string) => {
      setValue(newValue);
      onChange?.(newValue);
    },
    [onChange],
  );

  return (
    <div className={styles.root}>
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        className={styles.input}
      />
    </div>
  );
};
```

## CSS Module with Design Tokens

```css
.root {
  display: flex;
  align-items: center;
  padding: var(--spacing-md, 1rem);
  border-radius: var(--radius-md, 0.5rem);
  font-family: var(--font-family-base, sans-serif);
  transition: all var(--transition-fast, 150ms) ease;
}

.primary {
  background-color: var(--color-primary, #3b82f6);
  color: var(--color-primary-foreground, #ffffff);
}

.primary:hover:not([data-disabled="true"]) {
  background-color: var(--color-primary-hover, #2563eb);
}

.secondary {
  background-color: var(--color-secondary, #e5e7eb);
  color: var(--color-secondary-foreground, #1f2937);
}

.secondary:hover:not([data-disabled="true"]) {
  background-color: var(--color-secondary-hover, #d1d5db);
}

[data-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}
```

## Server Component (Next.js App Router)

```tsx
// No 'use client' directive = Server Component
import styles from "./ComponentName.module.css";

interface ComponentNameProps {
  title: string;
  data: SomeDataType;
}

export async function ComponentName({ title, data }: ComponentNameProps) {
  // Can fetch data directly
  const moreData = await fetch("https://api.example.com/data");

  return (
    <div className={styles.root}>
      <h1>{title}</h1>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
```

## Client Component (Next.js App Router)

```tsx
"use client";

import { useState } from "react";
import styles from "./ComponentName.module.css";

interface ComponentNameProps {
  initialCount?: number;
}

export function ComponentName({ initialCount = 0 }: ComponentNameProps) {
  const [count, setCount] = useState(initialCount);

  return (
    <button className={styles.root} onClick={() => setCount((c) => c + 1)}>
      Count: {count}
    </button>
  );
}
```
