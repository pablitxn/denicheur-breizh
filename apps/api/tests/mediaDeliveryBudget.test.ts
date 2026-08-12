import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import {
  MediaDeliveryBudget,
  type MediaDeliveryBudgetOptions,
} from "../src/mediaDeliveryBudget.js";

describe("MediaDeliveryBudget", () => {
  it("rejects a delivery when all global concurrency slots are reserved", () => {
    const budget = new MediaDeliveryBudget({
      maxConcurrent: 2,
      maxBytesPerWindow: 100,
      windowMs: 1_000,
      now: () => 0,
    });
    const releaseFirst = budget.acquire(10);
    const releaseSecond = budget.acquire(10);

    const error = captureApiError(() => budget.acquire(10));

    expect(error).toMatchObject({
      statusCode: 429,
      code: "MEDIA_DELIVERY_CONCURRENCY_LIMITED",
    });
    releaseFirst();
    releaseSecond();
  });

  it("charges released deliveries against the byte budget until the window rolls over", () => {
    const budget = new MediaDeliveryBudget({
      maxConcurrent: 1,
      maxBytesPerWindow: 10,
      windowMs: 1_000,
      now: () => 0,
    });
    budget.acquire(6)();
    budget.acquire(4)();

    const error = captureApiError(() => budget.acquire(1));

    expect(error).toMatchObject({
      statusCode: 429,
      code: "MEDIA_DELIVERY_BYTES_LIMITED",
    });
  });

  it("opens a fresh byte window exactly at the rollover boundary", () => {
    let nowMs = 10_000;
    const budget = new MediaDeliveryBudget({
      maxConcurrent: 1,
      maxBytesPerWindow: 10,
      windowMs: 1_000,
      now: () => nowMs,
    });
    budget.acquire(10)();
    nowMs += 999;
    const beforeRollover = captureApiError(() => budget.acquire(1));

    nowMs += 1;
    const release = budget.acquire(10);

    expect(beforeRollover.code).toBe("MEDIA_DELIVERY_BYTES_LIMITED");
    expect(release).toBeTypeOf("function");
    release();
  });

  it("makes release idempotent without freeing an extra concurrency slot", () => {
    const budget = new MediaDeliveryBudget({
      maxConcurrent: 1,
      maxBytesPerWindow: 100,
      windowMs: 1_000,
      now: () => 0,
    });
    const releaseFirst = budget.acquire(1);
    releaseFirst();
    releaseFirst();
    const releaseSecond = budget.acquire(1);

    const error = captureApiError(() => budget.acquire(1));

    expect(error.code).toBe("MEDIA_DELIVERY_CONCURRENCY_LIMITED");
    releaseSecond();
  });

  it.each([
    ["zero concurrency", { maxConcurrent: 0 }, "maxConcurrent"],
    ["fractional concurrency", { maxConcurrent: 1.5 }, "maxConcurrent"],
    ["zero byte budget", { maxBytesPerWindow: 0 }, "maxBytesPerWindow"],
    ["unsafe byte budget", { maxBytesPerWindow: Number.MAX_SAFE_INTEGER + 1 }, "maxBytesPerWindow"],
    ["zero window", { windowMs: 0 }, "windowMs"],
    ["non-function clock", { now: 123 }, "now"],
  ])("rejects the invalid option: %s", (_label, options, optionName) => {
    expect(() => new MediaDeliveryBudget(options as unknown as MediaDeliveryBudgetOptions))
      .toThrow(`Media delivery budget option ${optionName}`);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the invalid content length: %s",
    (contentLength) => {
      const budget = new MediaDeliveryBudget();

      expect(() => budget.acquire(contentLength))
        .toThrow("Media delivery contentLength must be a non-negative safe integer.");
    },
  );

  it("rejects a clock that returns a non-finite value", () => {
    const budget = new MediaDeliveryBudget({ now: () => Number.NaN });

    expect(() => budget.acquire(1))
      .toThrow("Media delivery budget clock must return a finite number.");
  });
});

function captureApiError(action: () => unknown): ApiError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected an ApiError to be thrown.");
}
