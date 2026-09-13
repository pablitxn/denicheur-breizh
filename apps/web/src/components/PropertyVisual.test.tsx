import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AppIntlProvider, localeStorageKey } from "../intl/IntlContext";
import type { PropertyListing } from "../types";
import { PropertyVisual } from "./PropertyVisual";

const imageUrls = [
  "https://fixtures.invalid/maison-1.svg",
  "https://fixtures.invalid/maison-2.svg",
  "https://fixtures.invalid/maison-3.svg",
];

describe("PropertyVisual", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(localeStorageKey, "fr");
  });

  it("navigates, wraps, supports arrow keys, and resets when the image list changes", () => {
    const listing = property({ imageUrls });
    const { rerender } = renderVisual(listing, true);
    const gallery = screen.getByRole("group", { name: "Galerie photos de Maison du port" });

    expect(within(gallery).getByRole("img", { name: "Photo 1 sur 3 : Maison du port" }))
      .toHaveAttribute("src", imageUrls[0]);
    expect(within(gallery).queryByText("1 / 3")).not.toBeInTheDocument();

    const next = within(gallery).getByRole("button", { name: "Photo suivante de Maison du port" });
    fireEvent.click(next);
    expect(within(gallery).getByRole("img", { name: "Photo 2 sur 3 : Maison du port" }))
      .toHaveAttribute("src", imageUrls[1]);

    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(within(gallery).getByRole("img", { name: "Photo 1 sur 3 : Maison du port" }))
      .toHaveAttribute("src", imageUrls[0]);

    fireEvent.click(within(gallery).getByRole("button", { name: "Photo précédente de Maison du port" }));
    expect(within(gallery).getByRole("img", { name: "Photo 3 sur 3 : Maison du port" }))
      .toHaveAttribute("src", imageUrls[2]);

    const refreshedListing = property({
      imageUrls: [
        "https://fixtures.invalid/dunes-1.svg",
        "https://fixtures.invalid/dunes-2.svg",
      ],
    });
    rerender(
      <AppIntlProvider>
        <PropertyVisual property={refreshedListing} navigation />
      </AppIntlProvider>,
    );

    expect(screen.getByRole("img", { name: "Photo 1 sur 2 : Maison du port" }))
      .toHaveAttribute("src", refreshedListing.imageUrls[0]);
    fireEvent.click(screen.getByRole("button", { name: "Photo suivante de Maison du port" }));
    expect(screen.getByRole("img", { name: "Photo 2 sur 2 : Maison du port" }))
      .toHaveAttribute("src", refreshedListing.imageUrls[1]);

    const shrunkListing = property({ imageUrls: [refreshedListing.imageUrls[0]] });
    rerender(
      <AppIntlProvider>
        <PropertyVisual property={shrunkListing} navigation />
      </AppIntlProvider>,
    );
    expect(screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" }))
      .toHaveAttribute("src", shrunkListing.imageUrls[0]);
    expect(screen.queryByRole("button", { name: "Photo suivante de Maison du port" })).not.toBeInTheDocument();
  });

  it("skips broken photos and falls back after every image fails", () => {
    renderVisual(property({ imageUrls }), true);

    fireEvent.error(screen.getByRole("img", { name: "Photo 1 sur 3 : Maison du port" }));
    fireEvent.error(screen.getByRole("img", { name: "Photo 2 sur 3 : Maison du port" }));
    expect(screen.queryByRole("button", { name: "Photo suivante de Maison du port" })).not.toBeInTheDocument();

    fireEvent.error(screen.getByRole("img", { name: "Photo 3 sur 3 : Maison du port" }));
    expect(screen.getByRole("img", { name: "Image indisponible" })).toBeVisible();
  });

  it("uses the replicated thumbnail for compact visuals and gallery image for larger visuals", () => {
    const sourceUrl = "https://img.leboncoin.fr/api/v1/lbcpb1/images/fixture-source";
    const thumbnailUrl = "http://127.0.0.1:4310/v1/media/asset-1/thumbnail.webp";
    const galleryUrl = "http://127.0.0.1:4310/v1/media/asset-1/gallery.webp";
    const listing = property({
      imageUrls: [sourceUrl],
      imageAssets: [{
        id: "asset-1",
        sourceUrl,
        status: "ready",
        thumbnailUrl,
        galleryUrl,
      }],
    });
    const { rerender } = renderVisual(listing, true, "sm");

    const compactImage = screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" });
    expect(compactImage).toHaveAttribute("src", thumbnailUrl);
    expect(compactImage).toHaveAttribute("srcset", `${thumbnailUrl} 480w, ${galleryUrl} 1280w`);
    expect(compactImage).toHaveAttribute("sizes", "58px");

    rerender(
      <AppIntlProvider>
        <PropertyVisual property={listing} size="lg" navigation />
      </AppIntlProvider>,
    );

    const largeImage = screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" });
    expect(largeImage).toHaveAttribute("src", galleryUrl);
    expect(largeImage).toHaveAttribute("srcset", `${thumbnailUrl} 480w, ${galleryUrl} 1280w`);
  });

  it("falls back to the original source for the same photo when its replica fails", () => {
    const sourceUrl = "https://img.leboncoin.fr/api/v1/lbcpb1/images/fixture-fallback";
    const thumbnailUrl = "http://127.0.0.1:4310/v1/media/asset-2/thumbnail.webp";
    const galleryUrl = "http://127.0.0.1:4310/v1/media/asset-2/gallery.webp";
    renderVisual(property({
      imageUrls: [sourceUrl],
      imageAssets: [{
        id: "asset-2",
        sourceUrl,
        status: "ready",
        thumbnailUrl,
        galleryUrl,
      }],
    }), true);

    fireEvent.error(screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" }));

    const sourceImage = screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" });
    expect(sourceImage).toHaveAttribute("src", sourceUrl);
    expect(sourceImage).not.toHaveAttribute("srcset");

    fireEvent.error(sourceImage);
    expect(screen.getByRole("img", { name: "Image indisponible" })).toBeVisible();
  });

  it("uses the original source while replication is still pending", () => {
    const sourceUrl = "https://img.leboncoin.fr/api/v1/lbcpb1/images/fixture-pending";
    renderVisual(property({
      imageUrls: [sourceUrl],
      imageAssets: [{ id: "asset-3", sourceUrl, status: "pending" }],
    }), true);

    const sourceImage = screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" });
    expect(sourceImage).toHaveAttribute("src", sourceUrl);
    expect(sourceImage).not.toHaveAttribute("srcset");
  });

  it("keeps zero, one, and non-navigable images free of carousel controls", () => {
    const singleImage = property({ imageUrls: [imageUrls[0]] });
    const { container, rerender } = renderVisual(singleImage, true);

    expect(screen.getByRole("img", { name: "Photo 1 sur 1 : Maison du port" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <AppIntlProvider>
        <PropertyVisual property={property({ imageUrls: [] })} navigation />
      </AppIntlProvider>,
    );
    expect(screen.getByRole("img", { name: "Aucune photo disponible" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(
      <AppIntlProvider>
        <PropertyVisual property={property({ imageUrls })} />
      </AppIntlProvider>,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });
});

function renderVisual(
  listing: PropertyListing,
  navigation: boolean,
  size: "sm" | "md" | "lg" = "md",
) {
  return render(
    <AppIntlProvider>
      <PropertyVisual property={listing} navigation={navigation} size={size} />
    </AppIntlProvider>,
  );
}

function property(overrides: Partial<PropertyListing> = {}): PropertyListing {
  return {
    source: "leboncoin",
    externalId: "listing-1",
    key: "leboncoin:listing-1",
    url: "https://www.leboncoin.fr/ad/ventes_immobilieres/listing-1",
    title: "Maison du port",
    imageUrls: [],
    features: [],
    runs: [],
    evaluations: [],
    ...overrides,
  };
}
