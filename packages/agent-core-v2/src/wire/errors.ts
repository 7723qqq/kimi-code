import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const WireErrors = {
  codes: {
    WIRE_DUPLICATE_OP: 'wire.duplicate_op',
    WIRE_UNKNOWN_RECORD: 'wire.unknown_record',
    WIRE_MIGRATION_MISSING: 'wire.migration_missing',
    WIRE_CYCLE: 'wire.cycle',
    RECORDS_WRITE_FAILED: 'records.write_failed',
  },
  info: {
    'wire.duplicate_op': {
      retryable: false,
      public: true,
    },
    'wire.unknown_record': {
      retryable: false,
      public: true,
    },
    'wire.cycle': {
      retryable: false,
      public: true,
    },
    'wire.migration_missing': {
      retryable: false,
      public: true,
    },
    'records.write_failed': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WireErrors);

export type WireErrorCode = (typeof WireErrors.codes)[keyof typeof WireErrors.codes];

export class WireError extends Error2 {
  constructor(code: WireErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'WireError';
  }
}
