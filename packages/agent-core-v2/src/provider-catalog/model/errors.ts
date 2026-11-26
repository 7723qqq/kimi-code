import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelCatalogErrors = {
  codes: {
    PROVIDER_NOT_FOUND: 'provider.not_found',
    MODEL_NOT_FOUND: 'model.not_found',
  },
  info: {
    'provider.not_found': {
      retryable: false,
      public: true,
    },
    'model.not_found': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelCatalogErrors);
