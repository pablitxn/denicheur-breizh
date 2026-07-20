import { createHash } from "node:crypto";

import sharp from "sharp";

import type { CompletedMediaAsset } from "./repository.js";

export const MEDIA_SOURCE_HOST = "img.leboncoin.fr";
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MEDIA_MAX_BYTES = 15 * 1024 * 1024;
export const MEDIA_MAX_PIXELS = 40_000_000;
export const MEDIA_WEBP_QUALITY = 78;

const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export type MediaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class MediaProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaProcessingError";
  }
}

export interface ProcessedMedia {
  readonly completed: CompletedMediaAsset;
  readonly original: Buffer;
  readonly thumbnail: Buffer;
  readonly gallery: Buffer;
}

export async function processMediaSource(
  sourceUrl: string,
  options: { readonly fetchImpl?: MediaFetch; readonly signal?: AbortSignal } = {},
): Promise<ProcessedMedia> {
  const download = await downloadLeboncoinImage(sourceUrl, options);
  try {
    const image = sharp(download.bytes, { failOn: "error", limitInputPixels: MEDIA_MAX_PIXELS });
    const metadata = await image.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) {
      throw new MediaProcessingError("IMAGE_DIMENSIONS_MISSING", "The image has no usable dimensions.", false);
    }
    if (width * height > MEDIA_MAX_PIXELS) {
      throw new MediaProcessingError("IMAGE_PIXEL_LIMIT", "The image exceeds the 40 megapixel limit.", false);
    }

    const actualMimeType = mimeTypeForMetadata(metadata.format, metadata.compression);
    if (!actualMimeType || actualMimeType !== download.contentType) {
      throw new MediaProcessingError("IMAGE_MIME_MISMATCH", "The declared image MIME type does not match its bytes.", false);
    }

    const oriented = image.rotate();
    const orientedWidth = metadata.autoOrient.width;
    const orientedHeight = metadata.autoOrient.height;
    const [thumbnailOutput, galleryOutput] = await Promise.all([
      oriented.clone()
        .resize({ width: 480, fit: "inside", withoutEnlargement: true })
        .webp({ quality: MEDIA_WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true }),
      oriented.clone()
        .resize({ width: 1_280, fit: "inside", withoutEnlargement: true })
        .webp({ quality: MEDIA_WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true }),
    ]);

    const contentSha256 = createHash("sha256").update(download.bytes).digest("hex");
    const objectPrefix = `media/${contentSha256.slice(0, 2)}/${contentSha256}`;
    const originalObjectKey = `${objectPrefix}/original.${extensionForMimeType(actualMimeType)}`;
    const completed: CompletedMediaAsset = {
      contentSha256,
      sourceMimeType: actualMimeType,
      originalObjectKey,
      thumbnailObjectKey: `${objectPrefix}/thumbnail.webp`,
      galleryObjectKey: `${objectPrefix}/gallery.webp`,
      originalSizeBytes: download.bytes.byteLength,
      thumbnailSizeBytes: thumbnailOutput.data.byteLength,
      gallerySizeBytes: galleryOutput.data.byteLength,
      width: orientedWidth,
      height: orientedHeight,
    };
    return {
      completed,
      original: download.bytes,
      thumbnail: thumbnailOutput.data,
      gallery: galleryOutput.data,
    };
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    throw new MediaProcessingError("IMAGE_INVALID", "Sharp could not decode the image.", false, { cause: error });
  }
}

export async function downloadLeboncoinImage(
  sourceUrl: string,
  options: { readonly fetchImpl?: MediaFetch; readonly signal?: AbortSignal } = {},
): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  let currentUrl = validateMediaSourceUrl(sourceUrl);

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetchImpl(currentUrl, { redirect: "manual", signal });
      if (isRedirect(response.status)) {
        if (redirectCount === MAX_REDIRECTS) {
          await cancelResponseBody(response);
          throw new MediaProcessingError("SOURCE_REDIRECT_LIMIT", "The image exceeded the redirect limit.", false);
        }
        const location = response.headers.get("location");
        if (!location) {
          await cancelResponseBody(response);
          throw new MediaProcessingError("SOURCE_REDIRECT_INVALID", "The image redirect omitted its location.", false);
        }
        await cancelResponseBody(response);
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, currentUrl).toString();
        } catch (error) {
          throw new MediaProcessingError(
            "SOURCE_REDIRECT_INVALID",
            "The image redirect location is invalid.",
            false,
            { cause: error },
          );
        }
        currentUrl = validateMediaSourceUrl(redirectUrl);
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        throw httpStatusError(response.status);
      }
      const contentType = normalizeContentType(response.headers.get("content-type"));
      if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        await cancelResponseBody(response);
        throw new MediaProcessingError("SOURCE_MIME_NOT_ALLOWED", "The response is not an allowed image MIME type.", false);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MEDIA_MAX_BYTES) {
        await cancelResponseBody(response);
        throw new MediaProcessingError("SOURCE_SIZE_LIMIT", "The image exceeds the 15 MB limit.", false);
      }
      if (!response.body) {
        throw new MediaProcessingError("SOURCE_BODY_MISSING", "The image response body is missing.", true);
      }
      return { bytes: await readBoundedBody(response.body), contentType };
    }
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    if (signal.aborted) {
      const externallyAborted = options.signal?.aborted === true;
      throw new MediaProcessingError(
        externallyAborted ? "MEDIA_JOB_ABORTED" : "SOURCE_TIMEOUT",
        externallyAborted ? "The media job was paused." : "The image download exceeded 15 seconds.",
        true,
        { cause: error },
      );
    }
    throw new MediaProcessingError("SOURCE_NETWORK_ERROR", "The image download failed.", true, { cause: error });
  }
  throw new MediaProcessingError("SOURCE_REDIRECT_LIMIT", "The image exceeded the redirect limit.", false);
}

export function validateMediaSourceUrl(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch (error) {
    throw new MediaProcessingError("SOURCE_URL_INVALID", "The image URL is invalid.", false, { cause: error });
  }
  const valid = url.protocol === "https:" &&
    url.hostname === MEDIA_SOURCE_HOST &&
    (url.port === "" || url.port === "443") &&
    !url.username &&
    !url.password;
  if (!valid) {
    throw new MediaProcessingError(
      "SOURCE_URL_NOT_ALLOWED",
      `Images must use HTTPS on ${MEDIA_SOURCE_HOST}.`,
      false,
    );
  }
  url.hash = "";
  return url.toString();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the classified source failure even if the transport cannot cancel cleanly.
  }
}

async function readBoundedBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MEDIA_MAX_BYTES) {
        await reader.cancel();
        throw new MediaProcessingError("SOURCE_SIZE_LIMIT", "The image exceeds the 15 MB limit.", false);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new MediaProcessingError("SOURCE_EMPTY", "The image response is empty.", false);
  return Buffer.concat(chunks, total);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function httpStatusError(status: number): MediaProcessingError {
  const retryable = status === 408 || status === 429 || status >= 500;
  return new MediaProcessingError(
    `SOURCE_HTTP_${status}`,
    `The image CDN returned HTTP ${status}.`,
    retryable,
  );
}

function normalizeContentType(contentType: string | null): string | undefined {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function mimeTypeForMetadata(format: string | undefined, compression: string | undefined): string | undefined {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  if (format === "heif" && compression === "av1") return "image/avif";
  return undefined;
}

function extensionForMimeType(contentType: string): string {
  return contentType === "image/jpeg"
    ? "jpg"
    : contentType === "image/png"
      ? "png"
      : contentType === "image/webp"
        ? "webp"
        : "avif";
}
