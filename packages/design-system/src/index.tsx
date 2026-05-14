import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
}

export function Button({
  variant = "default",
  size = "md",
  iconOnly = false,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx(
        "btn",
        variant !== "default" && variant,
        size === "sm" && "sm",
        iconOnly && "icon",
        className,
      )}
      {...props}
    />
  );
}

export type ChipTone = "default" | "good" | "danger" | "sunset" | "sea";

export interface ChipProps {
  children: ReactNode;
  active?: boolean;
  tone?: ChipTone;
  onClick?: () => void;
  title?: string;
  className?: string;
}

export function Chip({
  children,
  active = false,
  tone = "default",
  onClick,
  title,
  className,
}: ChipProps) {
  const chipClassName = cx("chip", active && "active", tone !== "default" && tone, className);

  if (onClick) {
    return (
      <button type="button" className={chipClassName} onClick={onClick} title={title}>
        {children}
      </button>
    );
  }

  return (
    <span className={chipClassName} title={title}>
      {children}
    </span>
  );
}

export interface ScoreBadgeProps {
  value: number;
  label?: string;
}

export function ScoreBadge({ value, label }: ScoreBadgeProps) {
  const tone = value >= 8 ? "high" : value >= 6.5 ? "" : value >= 5 ? "mid" : "low";

  return (
    <span className={cx("score", tone)} aria-label={label ?? `Score ${value.toFixed(1)}`}>
      {value.toFixed(1)}
    </span>
  );
}

export type MeterTone = "default" | "good" | "danger" | "sea";
export type MetricTone = "coast" | "quiet" | "value" | "family" | "transit" | "dpe" | "flood";

export interface MeterProps {
  value: number;
  max?: number;
  tone?: MeterTone;
  metric?: MetricTone;
}

export function Meter({ value, max = 10, tone = "default", metric }: MeterProps) {
  const width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;

  return (
    <span
      className={cx("meter", tone !== "default" && tone)}
      data-metric={metric}
      aria-hidden="true"
    >
      <i style={{ width }} />
    </span>
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("select", className)} {...props} />;
}

export function FieldLabel({ children, className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("field-label", className)} {...props}>
      {children}
    </span>
  );
}

export function EmptyState({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("empty-state", className)} {...props}>
      {children}
    </div>
  );
}
