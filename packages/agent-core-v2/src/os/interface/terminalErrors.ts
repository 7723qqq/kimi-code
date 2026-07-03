/**
 * `terminal` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const TerminalErrors = {
  codes: {
    TERMINAL_NOT_FOUND: 'terminal.not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(TerminalErrors);
