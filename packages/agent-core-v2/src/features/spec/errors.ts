import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SpecErrors = {
  codes: {
    SPEC_MODE_INVALID: 'spec.mode_invalid',
    SPEC_INCOMPLETE: 'spec.incomplete',
    SPEC_WRITE_DENIED: 'spec.write_denied',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SpecErrors);
