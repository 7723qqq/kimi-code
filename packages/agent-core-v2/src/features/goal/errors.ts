import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const GoalErrors = {
  codes: {
    GOAL_ALREADY_EXISTS: 'goal.already_exists',
    GOAL_NOT_FOUND: 'goal.not_found',
    GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
    GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
    GOAL_STATUS_INVALID: 'goal.status_invalid',
    GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
    GOAL_NOT_RESUMABLE: 'goal.not_resumable',
    GOAL_UNSUPPORTED_AGENT: 'goal.unsupported_agent',
  },
  info: {
    'goal.already_exists': {
      retryable: false,
      public: true,
    },
    'goal.not_found': {
      retryable: false,
      public: true,
    },
    'goal.objective_empty': {
      retryable: false,
      public: true,
    },
    'goal.objective_too_long': {
      retryable: false,
      public: true,
    },
    'goal.status_invalid': {
      retryable: false,
      public: true,
    },
    'goal.metadata_reserved': {
      retryable: false,
      public: true,
    },
    'goal.not_resumable': {
      retryable: false,
      public: true,
    },
    'goal.unsupported_agent': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(GoalErrors);
