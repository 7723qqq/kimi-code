import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelsDevImportErrors = {
  codes: {
    CATALOG_UNAVAILABLE: 'modelsDev.catalog_unavailable',
    CATALOG_ENTRY_NOT_FOUND: 'modelsDev.catalog_entry_not_found',
    CATALOG_IMPORT_INVALID: 'modelsDev.import_invalid',
    REGISTRY_IMPORT_INVALID: 'modelsDev.registry_import_invalid',
    PROVIDER_OAUTH_MANAGED: 'provider.oauth_managed',
  },
  info: {
    'modelsDev.catalog_unavailable': {
      retryable: true,
      public: true,
    },
    'modelsDev.catalog_entry_not_found': {
      retryable: false,
      public: true,
    },
    'modelsDev.import_invalid': {
      retryable: false,
      public: true,
    },
    'modelsDev.registry_import_invalid': {
      retryable: false,
      public: true,
    },
    'provider.oauth_managed': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelsDevImportErrors);
