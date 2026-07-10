/**
 * `activity` domain error codes.
 *
 * `activity.agent_busy` inherits the retryable semantics of the legacy
 * `turn.agent_busy`; the two coexist during migration, and `turn.*` callers
 * move to the new code before the legacy one is retired.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ActivityErrors = {
  codes: {
    ACTIVITY_AGENT_BUSY: 'activity.agent_busy',
    ACTIVITY_CANCELLING: 'activity.cancelling',
    ACTIVITY_DISPOSING: 'activity.disposing',
    ACTIVITY_DISPOSED: 'activity.disposed',
    ACTIVITY_INITIALIZING: 'activity.initializing',
    ACTIVITY_SESSION_REJECTED: 'activity.session_rejected',
  },
  retryable: [
    'activity.agent_busy',
    'activity.cancelling',
    'activity.initializing',
    'activity.session_rejected',
  ],
} as const satisfies ErrorDomain;

registerErrorDomain(ActivityErrors);
