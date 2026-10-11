import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AuthErrors = {
  codes: {
    AUTH_LOGIN_REQUIRED: 'auth.login_required',
    AUTH_PROVISIONING_REQUIRED: 'auth.provisioning_required',
    AUTH_TOKEN_MISSING: 'auth.token_missing',
    AUTH_TOKEN_UNAUTHORIZED: 'auth.token_unauthorized',
    AUTH_MODEL_NOT_RESOLVED: 'auth.model_not_resolved',
  },
  info: {
    'auth.login_required': {
      retryable: false,
      public: true,
    },
    'auth.provisioning_required': {
      retryable: false,
      public: true,
    },
    'auth.token_missing': {
      retryable: false,
      public: true,
    },
    'auth.token_unauthorized': {
      retryable: false,
      public: true,
    },
    'auth.model_not_resolved': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AuthErrors);
