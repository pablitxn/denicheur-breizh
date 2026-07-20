import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  MEDIA_MAX_BYTES,
  MEDIA_MAX_PIXELS,
  MediaProcessingError,
  downloadLeboncoinImage,
  processMediaSource,
  validateMediaSourceUrl,
  type MediaFetch,
} from "../src/mediaProcessor.js";

let largeOrientedJpeg: Buffer;
let smallJpeg: Buffer;

beforeAll(async () => {
  largeOrientedJpeg = await sharp({
    create: { width: 1_600, height: 2_400, channels: 3, background: "#6f8fae" },
  }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  smallJpeg = await sharp({
    create: { width: 320, height: 200, channels: 3, background: "#d8c4a8" },
  }).jpeg({ quality: 90 }).toBuffer();
});

describe("media source URL policy", () => {
  it("accepts only credential-free HTTPS URLs on the exact Leboncoin image host", () => {
    expect(validateMediaSourceUrl("https://img.leboncoin.fr/photo.jpg#tracking"))
      .toBe("https://img.leboncoin.fr/photo.jpg");

    for (const sourceUrl of [
      "http://img.leboncoin.fr/photo.jpg",
      "https://cdn.img.leboncoin.fr/photo.jpg",
      "https://img.leboncoin.fr:444/photo.jpg",
      "https://user:password@img.leboncoin.fr/photo.jpg",
      "https://example.com/photo.jpg",
      "not-a-url",
    ]) {
      expect(() => validateMediaSourceUrl(sourceUrl)).toThrow(MediaProcessingError);
    }
  });

  it("follows a manual relative redirect and validates every redirect target", async () => {
    const fetchMock = vi.fn<MediaFetch>(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      if (String(input).endsWith("/first.jpg")) {
        return new Response(null, {
          status: 302,
          headers: { location: "/second.jpg" },
        });
      }
      return imageResponse(smallJpeg, "image/jpeg");
    });

    const downloaded = await downloadLeboncoinImage("https://img.leboncoin.fr/first.jpg", {
      fetchImpl: fetchMock,
    });

    expect(downloaded.bytes).toEqual(smallJpeg);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://img.leboncoin.fr/first.jpg",
      "https://img.leboncoin.fr/second.jpg",
    ]);
  });

  it("rejects a redirect outside the allowlist before issuing the redirected request", async () => {
    const fetchMock = vi.fn<MediaFetch>(async () => new Response(null, {
      status: 307,
      headers: { location: "https://example.com/stolen.jpg" },
    }));

    await expect(downloadLeboncoinImage("https://img.leboncoin.fr/first.jpg", {
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ code: "SOURCE_URL_NOT_ALLOWED", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a malformed redirect location as a permanent redirect failure", async () => {
    const fetchMock = vi.fn<MediaFetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "https://[invalid" },
    }));

    await expect(downloadLeboncoinImage("https://img.leboncoin.fr/first.jpg", {
      fetchImpl: fetchMock,
    })).rejects.toMatchObject({ code: "SOURCE_REDIRECT_INVALID", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("media decoding and variants", () => {
  it("corrects orientation, strips metadata, and creates bounded WebP variants", async () => {
    const result = await processMediaSource("https://img.leboncoin.fr/oriented.jpg", {
      fetchImpl: imageFetch(largeOrientedJpeg, "image/jpeg"),
    });
    const thumbnail = await sharp(result.thumbnail).metadata();
    const gallery = await sharp(result.gallery).metadata();

    expect(result.original).toEqual(largeOrientedJpeg);
    expect(thumbnail).toMatchObject({ format: "webp", width: 480, height: 320 });
    expect(gallery).toMatchObject({ format: "webp", width: 1_280, height: 853 });
    expect(thumbnail.orientation).toBeUndefined();
    expect(gallery.orientation).toBeUndefined();
    expect(result.completed).toMatchObject({
      sourceMimeType: "image/jpeg",
      originalSizeBytes: largeOrientedJpeg.byteLength,
      thumbnailSizeBytes: result.thumbnail.byteLength,
      gallerySizeBytes: result.gallery.byteLength,
      width: 2_400,
      height: 1_600,
    });
    expect(result.completed.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.completed.originalObjectKey).toContain(result.completed.contentSha256);
    expect(result.completed.thumbnailObjectKey).toContain(result.completed.contentSha256);
    expect(result.completed.galleryObjectKey).toContain(result.completed.contentSha256);
  });

  it("does not enlarge small images", async () => {
    const result = await processMediaSource("https://img.leboncoin.fr/small.jpg", {
      fetchImpl: imageFetch(smallJpeg, "image/jpeg"),
    });

    await expect(sharp(result.thumbnail).metadata()).resolves.toMatchObject({ width: 320, height: 200 });
    await expect(sharp(result.gallery).metadata()).resolves.toMatchObject({ width: 320, height: 200 });
  });

  it("accepts each configured encoded image format", async () => {
    const createImage = () => sharp({
      create: { width: 24, height: 16, channels: 3, background: "#345678" },
    });
    const formats = [
      { extension: "jpg", contentType: "image/jpeg", bytes: await createImage().jpeg().toBuffer() },
      { extension: "png", contentType: "image/png", bytes: await createImage().png().toBuffer() },
      { extension: "webp", contentType: "image/webp", bytes: await createImage().webp().toBuffer() },
      { extension: "avif", contentType: "image/avif", bytes: await createImage().avif().toBuffer() },
    ] as const;

    for (const format of formats) {
      const result = await processMediaSource(`https://img.leboncoin.fr/photo.${format.extension}`, {
        fetchImpl: imageFetch(format.bytes, format.contentType),
      });
      expect(result.completed.sourceMimeType).toBe(format.contentType);
    }
  });

  it("rejects false MIME declarations and corrupt image bytes permanently", async () => {
    await expect(processMediaSource("https://img.leboncoin.fr/false-mime.png", {
      fetchImpl: imageFetch(smallJpeg, "image/png"),
    })).rejects.toMatchObject({ code: "IMAGE_MIME_MISMATCH", retryable: false });

    await expect(processMediaSource("https://img.leboncoin.fr/corrupt.jpg", {
      fetchImpl: imageFetch(Buffer.from("not an encoded image"), "image/jpeg"),
    })).rejects.toMatchObject({ code: "IMAGE_INVALID", retryable: false });
  });

  it("rejects images above the decoded 40 megapixel limit", async () => {
    const oversizedPixels = await sharp({
      create: { width: 6_500, height: 6_200, channels: 3, background: "#ffffff" },
    }).jpeg({ quality: 60 }).toBuffer();
    expect(6_500 * 6_200).toBeGreaterThan(MEDIA_MAX_PIXELS);

    let failure: unknown;
    try {
      await processMediaSource("https://img.leboncoin.fr/too-many-pixels.jpg", {
        fetchImpl: imageFetch(oversizedPixels, "image/jpeg"),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(MediaProcessingError);
    expect(failure).toMatchObject({ retryable: false });
  });
});

describe("download limits", () => {
  it("rejects an oversized declared body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }), {
      headers: {
        "content-length": String(MEDIA_MAX_BYTES + 1),
        "content-type": "image/jpeg",
      },
    });

    await expect(downloadLeboncoinImage("https://img.leboncoin.fr/large.jpg", {
      fetchImpl: async () => response,
    })).rejects.toMatchObject({ code: "SOURCE_SIZE_LIMIT", retryable: false });
    expect(cancelled).toBe(true);
  });

  it("enforces the byte limit while streaming when Content-Length is absent", async () => {
    let cancelled = false;
    let chunkIndex = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunkIndex === 0 ? new Uint8Array(MEDIA_MAX_BYTES) : new Uint8Array([1]));
        chunkIndex += 1;
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "image/jpeg" } });

    await expect(downloadLeboncoinImage("https://img.leboncoin.fr/streamed-large.jpg", {
      fetchImpl: async () => response,
    })).rejects.toMatchObject({ code: "SOURCE_SIZE_LIMIT", retryable: false });
    expect(cancelled).toBe(true);
  });
});

function imageFetch(bytes: Buffer, contentType: string): MediaFetch {
  return async () => imageResponse(bytes, contentType);
}

function imageResponse(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": contentType,
    },
  });
}
