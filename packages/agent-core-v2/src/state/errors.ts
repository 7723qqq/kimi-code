import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const StateErrors = {
  codes: {
    STATE_DUPLICATE_FOLD: 'state.duplicate_fold',
    STATE_DURABILITY_MISMATCH: 'state.durability_mismatch',
    STATE_CYCLE: 'state.cycle',
  },
  info: {
    'state.duplicate_fold': {
      retryable: false,
      public: true,
    },
    'state.durability_mismatch': {
      retryable: false,
      public: true,
    },
    'state.cycle': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(StateErrors);

export type StateErrorCode = (typeof StateErrors.codes)[keyof typeof StateErrors.codes];

export class StateError extends Error2 {
  constructor(code: StateErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'StateError';
  }
}
