import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const EventErrors = {
  codes: {
    EVENT_DUPLICATE_EVENT: 'event.duplicate_event',
    EVENT_SCHEMA_MISSING: 'event.schema_missing',
  },
  info: {
    'event.duplicate_event': {
      retryable: false,
      public: true,
    },
    'event.schema_missing': {
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(EventErrors);

export type EventErrorCode = (typeof EventErrors.codes)[keyof typeof EventErrors.codes];

export class EventError extends Error2 {
  constructor(code: EventErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'EventError';
  }
}
