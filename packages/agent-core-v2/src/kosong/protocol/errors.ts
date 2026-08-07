/**
 * `kosong/protocol` domain — wire API failure codes and the boundary
 * translation from raw contract errors to coded `Error2`s.
 *
 * The `ChatProviderError` family is born-coded (see `kosong/contract/errors`):
 * every instance already carries its wire code, so `translateProviderError`'s
 * `isError2` guard passes it through untouched. What remains here is the
 * abort guard and the fallback for errors foreign to the family (plain
 * `Error` / unknown thrown values → `internal`).
 *
 * `translateProviderError`'s FIRST guard is the contract's
 * `throwIfAbortError`: a user cancellation is thrown as the standard abort
 * DOMException and can never be misclassified as a retryable provider
 * failure. The guard throws rather than returns, by design.
 *
 * Side-effect module: importing registers the error domain.
 */

import { t } from '@moonshot-ai/kimi-i18n';
import { CoreErrors, registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, isError2 } from '#/_base/errors/errors';
import {
  CONTEXT_OVERFLOW_ERROR_CODE,
  PROVIDER_API_ERROR_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  PROVIDER_CONNECTION_ERROR_CODE,
  PROVIDER_FILTERED_ERROR_CODE,
  PROVIDER_OVERLOADED_ERROR_CODE,
  PROVIDER_RATE_LIMIT_ERROR_CODE,
  throwIfAbortError,
} from '#/kosong/contract/errors';

export { sanitizeStatusErrorMessage } from '#/kosong/contract/errors';

export const ProtocolErrors = {
  codes: {
    PROVIDER_API_ERROR: PROVIDER_API_ERROR_CODE,
    PROVIDER_FILTERED: PROVIDER_FILTERED_ERROR_CODE,
    PROVIDER_RATE_LIMIT: PROVIDER_RATE_LIMIT_ERROR_CODE,
    PROVIDER_AUTH_ERROR: PROVIDER_AUTH_ERROR_CODE,
    PROVIDER_CONNECTION_ERROR: PROVIDER_CONNECTION_ERROR_CODE,
    PROVIDER_OVERLOADED: PROVIDER_OVERLOADED_ERROR_CODE,
    CONTEXT_OVERFLOW: CONTEXT_OVERFLOW_ERROR_CODE,
  },
  retryable: [
    'provider.rate_limit',
    'provider.connection_error',
    'provider.overloaded',
    'context.overflow',
  ],
  info: {
    'provider.rate_limit': {
      title: t('v2Errors.providerRateLimit'),
      retryable: true,
      public: true,
      action: t('v2Errors.providerRateLimitAction'),
    },
    'provider.filtered': {
      title: t('v2Errors.providerFiltered'),
      retryable: false,
      public: true,
      action: t('v2Errors.providerFilteredAction'),
    },
    'provider.auth_error': {
      title: t('v2Errors.providerAuthError'),
      retryable: false,
      public: true,
      action: t('v2Errors.providerAuthErrorAction'),
    },
    'provider.overloaded': {
      title: t('v2Errors.providerOverloaded'),
      retryable: true,
      public: true,
      action: t('v2Errors.providerOverloadedAction'),
    },
    'context.overflow': {
      title: t('v2Errors.contextOverflow'),
      retryable: true,
      public: true,
      action: t('v2Errors.contextOverflowAction'),
    },
  },
} satisfies ErrorDomain;

registerErrorDomain(ProtocolErrors);

export function translateProviderError(error: unknown): Error2 {
  throwIfAbortError(error);
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(CoreErrors.codes.INTERNAL, error.message, {
      name: error.name,
      cause: error,
    });
  }
  return new Error2(CoreErrors.codes.INTERNAL, String(error), { cause: error });
}
