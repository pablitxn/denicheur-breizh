# React Storybook Examples

## Basic Story (CSF3)

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { ComponentName } from "./ComponentName";

const meta: Meta<typeof ComponentName> = {
  title: "Components/ComponentName",
  component: ComponentName,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary"],
    },
    disabled: {
      control: "boolean",
    },
    onClick: { action: "clicked" },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: {
    children: "Primary Button",
    variant: "primary",
  },
};

export const Secondary: Story = {
  args: {
    children: "Secondary Button",
    variant: "secondary",
  },
};

export const Disabled: Story = {
  args: {
    children: "Disabled Button",
    disabled: true,
  },
};
```

## Story with Decorators

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { ComponentName } from "./ComponentName";

const meta: Meta<typeof ComponentName> = {
  title: "Components/ComponentName",
  component: ComponentName,
  decorators: [
    (Story) => (
      <div style={{ padding: "2rem", background: "#f5f5f5" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
```

## Story with Context Provider

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { ThemeProvider } from "@/context/ThemeContext";
import { ThemedButton } from "./ThemedButton";

const meta: Meta<typeof ThemedButton> = {
  title: "Components/ThemedButton",
  component: ThemedButton,
  decorators: [
    (Story) => (
      <ThemeProvider>
        <Story />
      </ThemeProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  decorators: [
    (Story) => (
      <ThemeProvider initialTheme="light">
        <Story />
      </ThemeProvider>
    ),
  ],
};

export const Dark: Story = {
  decorators: [
    (Story) => (
      <ThemeProvider initialTheme="dark">
        <Story />
      </ThemeProvider>
    ),
  ],
};
```

## Story with Play Function (Interactions)

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { within, userEvent, expect } from "@storybook/test";
import { LoginForm } from "./LoginForm";

const meta: Meta<typeof LoginForm> = {
  title: "Components/LoginForm",
  component: LoginForm,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const FilledForm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.type(canvas.getByLabelText("Email"), "test@example.com");
    await userEvent.type(canvas.getByLabelText("Password"), "password123");
    await userEvent.click(canvas.getByRole("button", { name: "Submit" }));

    await expect(canvas.getByText("Success")).toBeInTheDocument();
  },
};
```

## Story with Custom Render

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Accordion } from "./Accordion";

const meta: Meta<typeof Accordion> = {
  title: "Components/Accordion",
  component: Accordion,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Controlled: Story = {
  render: (args) => {
    const [openIndex, setOpenIndex] = useState<number | null>(0);
    return (
      <Accordion {...args} openIndex={openIndex} onToggle={setOpenIndex} />
    );
  },
  args: {
    items: [
      { title: "Section 1", content: "Content 1" },
      { title: "Section 2", content: "Content 2" },
    ],
  },
};
```

## Story with Args Mapping

```tsx
import type { Meta, StoryObj } from "@storybook/react";
import { Icon } from "./Icon";
import { HomeIcon, SettingsIcon, UserIcon } from "@/icons";

const meta: Meta<typeof Icon> = {
  title: "Components/Icon",
  component: Icon,
  argTypes: {
    icon: {
      control: "select",
      options: ["home", "settings", "user"],
      mapping: {
        home: HomeIcon,
        settings: SettingsIcon,
        user: UserIcon,
      },
    },
    size: {
      control: { type: "range", min: 16, max: 64, step: 4 },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: "home",
    size: 24,
  },
};
```

## Documentation with MDX

````mdx
{/* ComponentName.mdx */}
import { Meta, Story, Canvas, Controls } from '@storybook/blocks';
import \* as ComponentNameStories from './ComponentName.stories';

<Meta of={ComponentNameStories} />

# ComponentName

A versatile button component with multiple variants.

## Usage

```tsx
import { ComponentName } from "@/components/ComponentName";

<ComponentName variant="primary" onClick={handleClick}>
  Click me
</ComponentName>;
```
````

## Examples

<Canvas of={ComponentNameStories.Primary} />

## Props

<Controls />
```
