import { ApiError } from "./errors.js";

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const REALTIME_MODEL = "gpt-realtime-2";
const REALTIME_INSTRUCTIONS =
  "You are a live Spanish-to-French interpreter. Translate every Spanish user utterance into natural French. Do not answer the request or add commentary; only provide the French translation.";

export type RealtimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RealtimeSessionServiceOptions {
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: RealtimeFetch;
}

export interface RealtimeSessionAnswer {
  readonly body: string;
  readonly contentType: string;
  readonly status: number;
}

export class RealtimeSessionService {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: RealtimeFetch;
  private readonly timeoutMs: number;

  constructor(options: RealtimeSessionServiceOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs;
  }

  async createSession(sdp: string): Promise<RealtimeSessionAnswer> {
    if (!this.apiKey) {
      throw new ApiError(503, "OPENAI_NOT_CONFIGURED", "Realtime is not configured.");
    }

    const formData = new FormData();
    formData.set("sdp", sdp);
    formData.set("session", JSON.stringify({
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: REALTIME_INSTRUCTIONS,
      audio: {
        output: {
          voice: "marin",
        },
      },
    }));

    let response: Response;
    try {
      response = await this.fetchImpl(REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ApiError(503, "OPENAI_TIMEOUT", "The Realtime session request timed out.", { cause: error });
      }
      throw new ApiError(503, "OPENAI_UNAVAILABLE", "The Realtime service is temporarily unavailable.", {
        cause: error,
      });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) {
        throw new ApiError(503, "OPENAI_RATE_LIMITED", "The Realtime service is temporarily rate limited.");
      }
      if (response.status === 401 || response.status === 403 || response.status >= 500) {
        throw new ApiError(503, "OPENAI_UNAVAILABLE", "The Realtime service is temporarily unavailable.");
      }
      throw new ApiError(502, "OPENAI_REJECTED", "The Realtime service rejected the session request.");
    }

    return {
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? "application/sdp",
      status: response.status,
    };
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
