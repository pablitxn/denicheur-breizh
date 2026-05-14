import type { PropertyListing } from "../types";
import styles from "./PropertyVisual.module.css";

interface PropertyVisualProps {
  property: PropertyListing;
  size?: "sm" | "md" | "lg";
}

export function PropertyVisual({ property, size = "md" }: PropertyVisualProps) {
  const coastalTone = property.scores.coast >= 8 ? styles.coast : property.scores.quiet >= 7.5 ? styles.quiet : styles.town;

  return (
    <div className={[styles.visual, styles[size], coastalTone].join(" ")} aria-hidden="true">
      <span className={styles.sun} />
      <span className={styles.horizon} />
      <span className={styles.house} />
      <span className={styles.roof} />
      <span className={styles.path} />
    </div>
  );
}
