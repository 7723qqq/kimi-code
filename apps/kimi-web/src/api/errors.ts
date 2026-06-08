// apps/kimi-web/src/api/errors.ts
// DaemonApiError, DaemonNetworkError, and type guard.

export class DaemonApiError extends Error {
  readonly code: number;
  readonly requestId: string;
  readonly details: unknown;

  constructor(input: { code: number; msg: string; requestId: string; details?: unknown }) {
    super(input.msg);
    this.name = 'DaemonApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

export class DaemonNetworkError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'DaemonNetworkError';
    this.cause = cause;
  }
}

export function isDaemonApiError(error: unknown): error is DaemonApiError {
  return error instanceof DaemonApiError;
}
