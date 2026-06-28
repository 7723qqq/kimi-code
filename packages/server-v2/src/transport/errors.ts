/**
 * `/api/v2` transport error handling — map internal errors onto the project
 * envelope, guard serialization, time-box calls, and gate access.
 */

import { timingSafeEqual } from 'node:crypto';

import { ErrorCodes, KimiError } from '@moonshot-ai/agent-core-v2';
import { ErrorCode, errEnvelope } from '@moonshot-ai/protocol';

/** Thrown by {@link withTimeout} when a call exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`call timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Race a promise against a deadline. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

const KIMI_TO_PROTOCOL: Record<string, ErrorCode> = {
  [ErrorCodes.SESSION_NOT_FOUND]: ErrorCode.SESSION_NOT_FOUND,
  [ErrorCodes.REQUEST_INVALID]: ErrorCode.VALIDATION_FAILED,
  [ErrorCodes.NOT_IMPLEMENTED]: ErrorCode.INTERNAL_ERROR,
};

/**
 * Map an internal error to the project envelope. `KimiError` keeps its coded
 * mapping; everything else becomes `50001`. Stack traces are intentionally not
 * surfaced.
 */
export function mapError(err: unknown, requestId: string): ReturnType<typeof errEnvelope> {
  if (err instanceof KimiError) {
    const code = KIMI_TO_PROTOCOL[err.code] ?? ErrorCode.INTERNAL_ERROR;
    return errEnvelope(code, err.message, requestId);
  }
  if (err instanceof TimeoutError) {
    return errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, requestId);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    err instanceof Error ? err.message : String(err),
    requestId,
  );
}

/** Build a `40001` envelope with structured details. */
export function validationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

/**
 * Ensure a value survives a JSON round-trip (catches circular refs, `BigInt`,
 * functions). Returns the value unchanged; throws `KimiError` on failure so the
 * caller maps it to `50001` with a clear message.
 */
export function assertSerializable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new KimiError(
      ErrorCodes.INTERNAL,
      `result not serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

/**
 * Timing-safe bearer-token check against the `Authorization` header. Query
 * `?tkn=` is intentionally not supported on the wire to avoid leaking tokens
 * into logs; use the header.
 */
export function isAuthorized(headers: Record<string, unknown>, token: string): boolean {
  const auth = headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
  const presented = auth.slice('Bearer '.length);
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
