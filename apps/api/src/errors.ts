export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly issues: readonly ValidationIssue[] | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { cause?: unknown; issues?: readonly ValidationIssue[] } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.issues = options.issues;
  }
}

export function invalidModelOutput(cause?: unknown): ApiError {
  return new ApiError(502, "INVALID_MODEL_OUTPUT", "The evaluator returned an invalid result.", { cause });
}
