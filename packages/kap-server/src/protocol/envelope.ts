/**
 * The wire envelope `{ code, msg, data, request_id }` every REST response is
 * wrapped in, plus the envelope JSON-schema factory used for OpenAPI
 * generation. Owned by the server: it is a pure transport concern.
 */

import { z } from 'zod';

import { ErrorCode } from './error-codes';

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    code: z.number().int(),
    msg: z.string(),
    data: data.nullable(),
    request_id: z.string(),
    details: z.unknown().optional(),
    stack: z.string().optional(),
  });

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
  stack?: string;
}

let stackTracesEnabled = false;
let exposeErrorDetails = false;

/** Enable stack traces in error envelopes (debug/loopback only). */
export function enableEnvelopeStackTraces(): void {
  stackTracesEnabled = true;
}

/**
 * Expose internal-error detail messages in error envelopes. Wired from
 * `start.ts` for loopback binds only — a non-loopback bind must never leak
 * the underlying failure text to remote callers.
 */
export function setExposeErrorDetails(value: boolean): void {
  exposeErrorDetails = value;
}

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

/**
 * Build an error envelope. Stack traces are only included when
 * `enableEnvelopeStackTraces()` has been called (loopback + debug mode);
 * otherwise the `stack` parameter is ignored to prevent information
 * disclosure on non-loopback binds.
 */
export function errEnvelope(
  code: number,
  msg: string,
  requestId: string,
  stack?: string,
): Envelope<null> {
  return { code, msg, data: null, request_id: requestId, stack: stackTracesEnabled ? stack : undefined };
}

/**
 * Build the 50001 internal-error envelope. The message carries the real
 * failure text only when `setExposeErrorDetails(true)` has been called
 * (loopback binds); otherwise it is the fixed `internal error` text and the
 * cause lives in the request log. Stack traces follow `errEnvelope`'s
 * debug-only gate.
 */
export function internalErrorEnvelope(
  err: unknown,
  requestId: string,
  prefix?: string,
): Envelope<null> {
  const cause = err instanceof Error && err.message !== '' ? err.message : 'internal error';
  const message = exposeErrorDetails ? cause : 'internal error';
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    prefix === undefined ? message : `${prefix}${message}`,
    requestId,
    err instanceof Error ? err.stack : undefined,
  );
}
