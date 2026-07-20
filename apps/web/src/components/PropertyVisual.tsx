import { useMemo, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppIntl } from "../intl/IntlContext";
import type { PropertyImageAsset, PropertyListing } from "../types";
import styles from "./PropertyVisual.module.css";

interface PropertyVisualProps {
  property: PropertyListing;
  size?: "sm" | "md" | "lg";
  navigation?: boolean;
}

interface DisplayImage {
  sourceUrl: string;
  replicaUrls: string[];
  preferredReplicaUrl?: string;
  replicaSrcSet?: string;
}

interface ResolvedDisplayImage {
  src: string;
  srcSet?: string;
  usesReplica: boolean;
}

const responsiveImageSizes: Readonly<Record<Required<PropertyVisualProps>["size"], string>> = {
  sm: "58px",
  md: "(max-width: 760px) calc(100vw - 32px), 420px",
  lg: "(max-width: 1120px) calc(100vw - 32px), 640px",
};

export function PropertyVisual({ property, size = "md", navigation = false }: PropertyVisualProps) {
  const imageSignature = [
    property.key,
    ...property.imageUrls,
    ...(property.imageAssets ?? []).map((asset) => [
      asset.id,
      asset.sourceUrl,
      asset.status,
      asset.thumbnailUrl,
      asset.galleryUrl,
    ].join("\n")),
  ].join("\n");
  return (
    <PropertyVisualContent
      key={imageSignature}
      property={property}
      size={size}
      navigation={navigation}
    />
  );
}

function PropertyVisualContent({ property, size, navigation }: Required<PropertyVisualProps>) {
  const { locale, t } = useAppIntl();
  const images = createDisplayImages(property, size);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(() => new Set());

  const title = property.title?.trim() || property.externalId;
  const activeImage = images[activeImageIndex];
  const resolvedActiveImage = activeImage
    ? resolveDisplayImage(activeImage, failedImageUrls)
    : undefined;
  const hasVisibleImage = resolvedActiveImage !== undefined;
  const availableImageCount = images.filter((image) => resolveDisplayImage(image, failedImageUrls)).length;
  const showNavigation = navigation && images.length > 1 && availableImageCount > 1;
  const imageNumberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  function moveImage(direction: -1 | 1) {
    const nextIndex = findAvailableImageIndex(images, activeImageIndex, direction, failedImageUrls);
    if (nextIndex !== undefined) setActiveImageIndex(nextIndex);
  }

  function handleImageError() {
    if (!activeImage || !resolvedActiveImage) return;
    const nextFailedImageUrls = new Set(failedImageUrls);
    if (resolvedActiveImage.usesReplica) {
      activeImage.replicaUrls.forEach((url) => nextFailedImageUrls.add(url));
    } else {
      nextFailedImageUrls.add(activeImage.sourceUrl);
    }
    setFailedImageUrls(nextFailedImageUrls);
    if (!resolveDisplayImage(activeImage, nextFailedImageUrls)) {
      const nextIndex = findAvailableImageIndex(images, activeImageIndex, 1, nextFailedImageUrls);
      if (nextIndex !== undefined) setActiveImageIndex(nextIndex);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!showNavigation || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    event.stopPropagation();
    moveImage(event.key === "ArrowLeft" ? -1 : 1);
  }

  return (
    <div
      className={[styles.visual, styles[size], styles.town].join(" ")}
      role={navigation ? "group" : undefined}
      aria-label={navigation ? t("property.imageGallery", { title }) : undefined}
      onKeyDown={handleKeyDown}
    >
      {hasVisibleImage && resolvedActiveImage ? (
        <img
          key={resolvedActiveImage.src}
          src={resolvedActiveImage.src}
          srcSet={resolvedActiveImage.srcSet}
          sizes={resolvedActiveImage.srcSet ? responsiveImageSizes[size] : undefined}
          alt={navigation
            ? t("property.imageAlt", {
                index: imageNumberFormatter.format(activeImageIndex + 1),
                title,
                total: imageNumberFormatter.format(images.length),
              })
            : ""}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={handleImageError}
        />
      ) : (
        <span
          className={styles.placeholder}
          role={navigation ? "img" : undefined}
          aria-label={navigation
            ? images.length > 0
              ? t("property.imageUnavailable")
              : t("property.noImage")
            : undefined}
          aria-hidden={navigation ? undefined : "true"}
        >
          <span className={styles.sun} aria-hidden="true" />
          <span className={styles.horizon} aria-hidden="true" />
          <span className={styles.house} aria-hidden="true" />
          <span className={styles.roof} aria-hidden="true" />
          <span className={styles.path} aria-hidden="true" />
        </span>
      )}

      {showNavigation && (
        <>
          <button
            type="button"
            className={[styles.galleryNav, styles.previous].join(" ")}
            aria-label={t("property.previousImage", { title })}
            onClick={() => moveImage(-1)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={[styles.galleryNav, styles.next].join(" ")}
            aria-label={t("property.nextImage", { title })}
            onClick={() => moveImage(1)}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </>
      )}

      {navigation && images.length > 1 && hasVisibleImage && (
        <span className={styles.galleryCounter} aria-live="polite">
          {imageNumberFormatter.format(activeImageIndex + 1)} / {imageNumberFormatter.format(images.length)}
        </span>
      )}
    </div>
  );
}

function findAvailableImageIndex(
  images: readonly DisplayImage[],
  activeIndex: number,
  direction: -1 | 1,
  failedImageUrls: ReadonlySet<string>,
): number | undefined {
  for (let offset = 1; offset <= images.length; offset += 1) {
    const candidateIndex = (activeIndex + (offset * direction) + images.length) % images.length;
    const candidate = images[candidateIndex];
    if (candidate && resolveDisplayImage(candidate, failedImageUrls)) return candidateIndex;
  }
  return undefined;
}

function createDisplayImages(property: PropertyListing, size: Required<PropertyVisualProps>["size"]): DisplayImage[] {
  const assetsBySourceUrl = new Map(
    (property.imageAssets ?? []).map((asset) => [asset.sourceUrl, asset] as const),
  );
  const sourceUrls = Array.from(new Set([
    ...property.imageUrls,
    ...(property.imageAssets ?? []).map((asset) => asset.sourceUrl),
  ]));

  return sourceUrls.map((sourceUrl) => displayImage(sourceUrl, assetsBySourceUrl.get(sourceUrl), size));
}

function displayImage(
  sourceUrl: string,
  asset: PropertyImageAsset | undefined,
  size: Required<PropertyVisualProps>["size"],
): DisplayImage {
  if (asset?.status !== "ready") return { sourceUrl, replicaUrls: [] };

  const replicaUrls = Array.from(new Set([
    ...(asset.thumbnailUrl ? [asset.thumbnailUrl] : []),
    ...(asset.galleryUrl ? [asset.galleryUrl] : []),
  ]));
  const preferredReplicaUrl = size === "sm"
    ? asset.thumbnailUrl ?? asset.galleryUrl
    : asset.galleryUrl ?? asset.thumbnailUrl;
  const replicaSrcSet = [
    asset.thumbnailUrl ? `${asset.thumbnailUrl} 480w` : undefined,
    asset.galleryUrl ? `${asset.galleryUrl} 1280w` : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined).join(", ") || undefined;

  return {
    sourceUrl,
    replicaUrls,
    ...(preferredReplicaUrl ? { preferredReplicaUrl } : {}),
    ...(replicaSrcSet ? { replicaSrcSet } : {}),
  };
}

function resolveDisplayImage(
  image: DisplayImage,
  failedImageUrls: ReadonlySet<string>,
): ResolvedDisplayImage | undefined {
  const replicaFailed = image.replicaUrls.some((url) => failedImageUrls.has(url));
  if (image.preferredReplicaUrl && !replicaFailed) {
    return {
      src: image.preferredReplicaUrl,
      ...(image.replicaSrcSet ? { srcSet: image.replicaSrcSet } : {}),
      usesReplica: true,
    };
  }
  if (!failedImageUrls.has(image.sourceUrl)) {
    return { src: image.sourceUrl, usesReplica: false };
  }
  return undefined;
}
