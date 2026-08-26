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

export function okEnvelope<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'success', data, request_id: requestId };
}

let exposeErrorDetails = false;
let stackTracesEnabled = false;

export function setExposeErrorDetails(value: boolean): void {
  exposeErrorDetails = value;
}

export function enableEnvelopeStackTraces(): void {
  stackTracesEnabled = true;
}

export function errEnvelope(
  code: number,
  msg: string,
  requestId: string,
  stack?: string,
): Envelope<null> {
  return {
    code,
    msg,
    data: null,
    request_id: requestId,
    stack: stackTracesEnabled ? stack : undefined,
  };
}

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
