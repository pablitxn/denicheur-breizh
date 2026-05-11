# Advanced React Patterns

## Compound Components

```tsx
import { createContext, useContext, useState, type ReactNode } from "react";

// Context
interface TabsContextValue {
  activeTab: string;
  setActiveTab: (id: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabsContext = () => {
  const context = useContext(TabsContext);
  if (!context) throw new Error("Must be used within Tabs");
  return context;
};

// Root component
interface TabsProps {
  defaultTab: string;
  children: ReactNode;
}

function TabsRoot({ defaultTab, children }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className="tabs">{children}</div>
    </TabsContext.Provider>
  );
}

// Sub-components
function TabList({ children }: { children: ReactNode }) {
  return <div role="tablist">{children}</div>;
}

function Tab({ id, children }: { id: string; children: ReactNode }) {
  const { activeTab, setActiveTab } = useTabsContext();
  return (
    <button
      role="tab"
      aria-selected={activeTab === id}
      onClick={() => setActiveTab(id)}
    >
      {children}
    </button>
  );
}

function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  const { activeTab } = useTabsContext();
  if (activeTab !== id) return null;
  return <div role="tabpanel">{children}</div>;
}

// Export as compound
export const Tabs = Object.assign(TabsRoot, {
  List: TabList,
  Tab,
  Panel: TabPanel,
});

// Usage:
// <Tabs defaultTab="tab1">
//   <Tabs.List>
//     <Tabs.Tab id="tab1">Tab 1</Tabs.Tab>
//     <Tabs.Tab id="tab2">Tab 2</Tabs.Tab>
//   </Tabs.List>
//   <Tabs.Panel id="tab1">Content 1</Tabs.Panel>
//   <Tabs.Panel id="tab2">Content 2</Tabs.Panel>
// </Tabs>
```

## Polymorphic Component

```tsx
import { type ElementType, type ComponentPropsWithoutRef } from "react";

type BoxProps<T extends ElementType> = {
  as?: T;
  children?: React.ReactNode;
} & ComponentPropsWithoutRef<T>;

export function Box<T extends ElementType = "div">({
  as,
  children,
  ...props
}: BoxProps<T>) {
  const Component = as || "div";
  return <Component {...props}>{children}</Component>;
}

// Usage:
// <Box as="section" className="container">Content</Box>
// <Box as="button" onClick={handleClick}>Click</Box>
// <Box as={Link} href="/home">Home</Box>
```

## Render Props Pattern

```tsx
interface MousePosition {
  x: number;
  y: number;
}

interface MouseTrackerProps {
  children: (position: MousePosition) => React.ReactNode;
}

export function MouseTracker({ children }: MouseTrackerProps) {
  const [position, setPosition] = useState<MousePosition>({ x: 0, y: 0 });

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, []);

  return <>{children(position)}</>;
}

// Usage:
// <MouseTracker>
//   {({ x, y }) => <div>Mouse: {x}, {y}</div>}
// </MouseTracker>
```

## Higher-Order Component (HOC)

```tsx
import { type ComponentType } from "react";

interface WithLoadingProps {
  isLoading?: boolean;
}

export function withLoading<P extends object>(
  WrappedComponent: ComponentType<P>,
) {
  return function WithLoadingComponent({
    isLoading,
    ...props
  }: P & WithLoadingProps) {
    if (isLoading) {
      return <div>Loading...</div>;
    }
    return <WrappedComponent {...(props as P)} />;
  };
}

// Usage:
// const UserListWithLoading = withLoading(UserList);
// <UserListWithLoading isLoading={loading} users={users} />
```

## Custom Hook with Generics

```tsx
import { useState, useCallback } from "react";

interface UseToggleReturn {
  value: boolean;
  toggle: () => void;
  setTrue: () => void;
  setFalse: () => void;
}

export function useToggle(initialValue = false): UseToggleReturn {
  const [value, setValue] = useState(initialValue);

  const toggle = useCallback(() => setValue((v) => !v), []);
  const setTrue = useCallback(() => setValue(true), []);
  const setFalse = useCallback(() => setValue(false), []);

  return { value, toggle, setTrue, setFalse };
}

// Generic async state hook
interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export function useAsync<T>(
  asyncFn: () => Promise<T>,
  deps: React.DependencyList = [],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    setState({ data: null, loading: true, error: null });
    asyncFn()
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((error) => setState({ data: null, loading: false, error }));
  }, deps);

  return state;
}
```

## Error Boundary

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Error caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? <div>Something went wrong.</div>;
    }
    return this.props.children;
  }
}

// Usage:
// <ErrorBoundary fallback={<ErrorPage />}>
//   <App />
// </ErrorBoundary>
```

## Slot Pattern (Children Inspection)

```tsx
import { Children, isValidElement, type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
}

function CardHeader({ children }: { children: ReactNode }) {
  return <div className="card-header">{children}</div>;
}

function CardBody({ children }: { children: ReactNode }) {
  return <div className="card-body">{children}</div>;
}

export function Card({ children }: CardProps) {
  let header: ReactNode = null;
  let body: ReactNode = null;
  const other: ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (isValidElement(child)) {
      if (child.type === CardHeader) header = child;
      else if (child.type === CardBody) body = child;
      else other.push(child);
    }
  });

  return (
    <div className="card">
      {header}
      {body}
      {other}
    </div>
  );
}

Card.Header = CardHeader;
Card.Body = CardBody;
```
