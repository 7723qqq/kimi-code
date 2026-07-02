/**
 * Wire serialization of errors — converts between thrown values and the
 * portable `ErrorPayload` that crosses process / language boundaries.
 */

import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '#/app/llmProtocol';

import { CoreErrors, errorInfo, isErrorCode } from './codes';
import type { ErrorCode } from './codes';
import { KimiError, isCancellationError } from './errors';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

export type KimiErrorPayload = ErrorPayload;

export interface CodedErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const PROVIDER_API_ERROR: ErrorCode = 'provider.api_error';
const PROVIDER_RATE_LIMIT: ErrorCode = 'provider.rate_limit';
const PROVIDER_AUTH_ERROR: ErrorCode = 'provider.auth_error';
const PROVIDER_CONNECTION_ERROR: ErrorCode = 'provider.connection_error';

export function isCodedError(error: unknown): error is CodedErrorShape {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return isErrorCode(code);
}

export function makeErrorPayload(
  code: ErrorCode,
  message: string,
  options?: {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly name?: string;
  },
): ErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: errorInfo(code).retryable,
  };
}

function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isCancellationError(error)) {
    return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message);
  }
  if (isCodedError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: errorInfo(error.code).retryable,
    };
  }
  if (error instanceof APIStatusError) {
    const code =
      error.statusCode === 429
        ? PROVIDER_RATE_LIMIT
        : error.statusCode === 401 || error.statusCode === 403
          ? PROVIDER_AUTH_ERROR
          : PROVIDER_API_ERROR;
    return makeErrorPayload(code, sanitizeStatusErrorMessage(error.message), {
      name: error.name,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
      },
    });
  }
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return makeErrorPayload(PROVIDER_CONNECTION_ERROR, error.message, { name: error.name });
  }
  if (error instanceof APIEmptyResponseError) {
    return makeErrorPayload(PROVIDER_API_ERROR, error.message, {
      name: error.name,
      details: {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      },
    });
  }
  if (error instanceof ChatProviderError) {
    return makeErrorPayload(PROVIDER_API_ERROR, error.message, { name: error.name });
  }
  if (error instanceof Error) {
    return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message, { name: error.name });
  }
  return makeErrorPayload(CoreErrors.codes.INTERNAL, String(error));
}

export const toKimiErrorPayload = toErrorPayload;

export function fromErrorPayload(payload: ErrorPayload): KimiError {
  return new KimiError(payload.code, payload.message, {
    name: payload.name,
    details: payload.details,
  });
}
