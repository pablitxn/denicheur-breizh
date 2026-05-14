import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import styles from "./ui.module.css";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost";
  size?: "sm" | "md";
  iconOnly?: boolean;
}

export function Button({ variant = "default", size = "md", iconOnly = false, className, ...props }: ButtonProps) {
  return (
    <button
      className={[styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : "", className ?? ""].join(" ")}
      {...props}
    />
  );
}

interface ChipProps {
  children: ReactNode;
  active?: boolean;
  tone?: "default" | "good" | "danger" | "sunset";
  onClick?: () => void;
  title?: string;
}

export function Chip({ children, active = false, tone = "default", onClick, title }: ChipProps) {
  const className = [styles.chip, active ? styles.chipActive : "", styles[tone]].join(" ");

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} title={title}>
        {children}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

interface ScoreBadgeProps {
  value: number;
  label?: string;
}

export function ScoreBadge({ value, label }: ScoreBadgeProps) {
  const tone = value >= 8 ? styles.scoreHigh : value >= 6.5 ? styles.scoreNeutral : value >= 5 ? styles.scoreMid : styles.scoreLow;

  return (
    <span className={[styles.scoreBadge, tone].join(" ")} aria-label={label ?? `Score ${value.toFixed(1)}`}>
      {value.toFixed(1)}
    </span>
  );
}

interface MeterProps {
  value: number;
  max?: number;
  tone?: "default" | "good" | "danger" | "sea";
}

export function Meter({ value, max = 10, tone = "default" }: MeterProps) {
  const width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  return (
    <span className={[styles.meter, styles[tone]].join(" ")} aria-hidden="true">
      <i style={{ width }} />
    </span>
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={styles.select} {...props} />;
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className={styles.fieldLabel}>{children}</span>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.emptyState}>{children}</div>;
}
