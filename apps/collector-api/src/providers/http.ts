export type FetchLike = typeof globalThis.fetch;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Evidence must never retain a credential echoed by an upstream error or page. */
export function redactProviderValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (secret) result = result.split(secret).join("[REDACTED]");
    }
    return result.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactProviderValue(item, secrets));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    /^(authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key)
      ? "[REDACTED]"
      : redactProviderValue(item, secrets),
  ]));
}

export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly response: unknown,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

export interface JsonRequestOptions {
  fetch: FetchLike;
  url: string;
  apiKey: string;
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** No automatic retries: a disconnected POST may already have spent credits. */
export async function requestJson(options: JsonRequestOptions): Promise<unknown> {
  if (options.signal?.aborted) throw new ProviderTransportError("Provider request interrupted before dispatch.", null, null, false);
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: options.method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    throw new ProviderTransportError(
      options.signal?.aborted ? "Provider request interrupted." : "Provider connection failed.",
      null,
      null,
      options.method === "POST",
    );
  }
  let body: unknown;
  let invalidJson = false;
  try {
    const text = await response.text();
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      invalidJson = true;
      body = { invalidJson: text };
    }
  } catch {
    throw new ProviderTransportError("Provider response could not be read.", response.status, null, options.method === "POST");
  }
  const safeBody = redactProviderValue(body, [options.apiKey]);
  if (!response.ok) {
    throw new ProviderTransportError(`Provider returned HTTP ${response.status}.`, response.status, safeBody, options.method === "POST" && response.status >= 500);
  }
  if (invalidJson) {
    throw new ProviderTransportError("Provider returned invalid JSON.", response.status, safeBody, options.method === "POST");
  }
  return safeBody;
}

export function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function integerTicks(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}
