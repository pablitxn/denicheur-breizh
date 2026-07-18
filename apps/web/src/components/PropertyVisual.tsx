import type { PropertyListing } from "../types";
import styles from "./PropertyVisual.module.css";

interface PropertyVisualProps {
  property: PropertyListing;
  size?: "sm" | "md" | "lg";
}

export function PropertyVisual({ property, size = "md" }: PropertyVisualProps) {
  const imageUrl = property.imageUrls[0];

  return (
    <div className={[styles.visual, styles[size], styles.town].join(" ")}>
      {imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <span className={styles.placeholder} aria-hidden="true">
          <span className={styles.sun} />
          <span className={styles.horizon} />
          <span className={styles.house} />
          <span className={styles.roof} />
          <span className={styles.path} />
        </span>
      )}
    </div>
  );
}
