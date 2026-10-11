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
} from '../contract/errors';

export { sanitizeStatusErrorMessage } from '../contract/errors';

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
      retryable: true,
      public: true,
    },
    'provider.filtered': {
      retryable: false,
      public: true,
    },
    'provider.auth_error': {
      retryable: false,
      public: true,
    },
    'provider.overloaded': {
      retryable: true,
      public: true,
    },
    'context.overflow': {
      retryable: true,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

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
