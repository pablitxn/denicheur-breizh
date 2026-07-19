export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type EvaluatorFailureStage = "provider" | "response" | "parse" | "schema" | "semantic";

export interface SafeEvaluatorFailureDetails {
  readonly stage: EvaluatorFailureStage;
  readonly detailCode: string;
  readonly listingId?: string;
  readonly criterionId?: string;
  readonly retryable: boolean;
  readonly responseId?: string;
}

interface ApiErrorOptions extends Partial<SafeEvaluatorFailureDetails> {
  readonly cause?: unknown;
  readonly issues?: readonly ValidationIssue[];
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly issues: readonly ValidationIssue[] | undefined;
  readonly stage: EvaluatorFailureStage | undefined;
  readonly detailCode: string | undefined;
  readonly listingId: string | undefined;
  readonly criterionId: string | undefined;
  readonly retryable: boolean | undefined;
  readonly responseId: string | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.issues = options.issues;
    this.stage = options.stage;
    this.detailCode = options.detailCode;
    this.listingId = options.listingId;
    this.criterionId = options.criterionId;
    this.retryable = options.retryable;
    this.responseId = options.responseId;
  }
}

export function invalidModelOutput(
  details: SafeEvaluatorFailureDetails,
  cause?: unknown,
): ApiError {
  return new ApiError(502, "INVALID_MODEL_OUTPUT", "The evaluator returned an invalid result.", {
    ...details,
    cause,
  });
}
