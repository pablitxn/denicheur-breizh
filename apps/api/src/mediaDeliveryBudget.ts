import { ApiError } from "./errors.js";

export const DEFAULT_MEDIA_DELIVERY_MAX_CONCURRENT = 8;
export const DEFAULT_MEDIA_DELIVERY_MAX_BYTES_PER_WINDOW = 256 * 1024 * 1024;
export const DEFAULT_MEDIA_DELIVERY_WINDOW_MS = 60_000;

export interface MediaDeliveryBudgetOptions {
  readonly maxConcurrent?: number;
  readonly maxBytesPerWindow?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

export type MediaDeliveryRelease = () => void;

/**
 * Process-wide admission gate for media responses. Share one instance across
 * delivery routes and acquire a reservation before opening object storage.
 */
export class MediaDeliveryBudget {
  private readonly maxConcurrent: number;
  private readonly maxBytesPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private activeDeliveries = 0;
  private windowStartedAtMs: number | undefined;
  private windowBytes = 0;

  constructor(options: MediaDeliveryBudgetOptions = {}) {
    this.maxConcurrent = positiveSafeInteger(
      "maxConcurrent",
      options.maxConcurrent,
      DEFAULT_MEDIA_DELIVERY_MAX_CONCURRENT,
    );
    this.maxBytesPerWindow = positiveSafeInteger(
      "maxBytesPerWindow",
      options.maxBytesPerWindow,
      DEFAULT_MEDIA_DELIVERY_MAX_BYTES_PER_WINDOW,
    );
    this.windowMs = positiveSafeInteger(
      "windowMs",
      options.windowMs,
      DEFAULT_MEDIA_DELIVERY_WINDOW_MS,
    );
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("Media delivery budget option now must be a function.");
    }
    this.now = options.now === undefined ? Date.now : options.now;
  }

  acquire(contentLength: number): MediaDeliveryRelease {
    assertContentLength(contentLength);
    this.rollWindow(this.readNow());

    if (this.activeDeliveries >= this.maxConcurrent) {
      throw new ApiError(
        429,
        "MEDIA_DELIVERY_CONCURRENCY_LIMITED",
        "Too many media responses are already being delivered.",
      );
    }
    if (contentLength > this.maxBytesPerWindow - this.windowBytes) {
      throw new ApiError(
        429,
        "MEDIA_DELIVERY_BYTES_LIMITED",
        "The media delivery byte budget is exhausted for the current window.",
      );
    }

    this.activeDeliveries += 1;
    this.windowBytes += contentLength;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeDeliveries -= 1;
    };
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isFinite(value)) {
      throw new TypeError("Media delivery budget clock must return a finite number.");
    }
    return value;
  }

  private rollWindow(nowMs: number): void {
    if (this.windowStartedAtMs === undefined) {
      this.windowStartedAtMs = nowMs;
      return;
    }
    if (nowMs - this.windowStartedAtMs < this.windowMs) return;
    this.windowStartedAtMs = nowMs;
    this.windowBytes = 0;
  }
}

function positiveSafeInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`Media delivery budget option ${name} must be a positive safe integer.`);
  }
  return resolved;
}

function assertContentLength(contentLength: number): void {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new TypeError("Media delivery contentLength must be a non-negative safe integer.");
  }
}
