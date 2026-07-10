/**
 * `turn` domain error codes.
 *
 * `TURN_AGENT_BUSY` is deprecated: busy admission now throws
 * `activity.agent_busy` from the `activity` kernel. It stays registered until
 * the remaining `turn.*` callers (e.g. `skill`) move to the new code.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const TurnErrors = {
  codes: {
    TURN_AGENT_BUSY: 'turn.agent_busy',
  },
  retryable: ['turn.agent_busy'],
} as const satisfies ErrorDomain;

registerErrorDomain(TurnErrors);
