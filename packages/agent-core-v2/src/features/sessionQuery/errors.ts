import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionQueryErrors = {
  codes: {
    SESSION_QUERY_INVALID_FILTER: 'session_query.invalid_filter',
    SESSION_QUERY_SESSION_NOT_FOUND: 'session_query.session_not_found',
    SESSION_QUERY_INDEX_UNAVAILABLE: 'session_query.index_unavailable',
  },
  retryable: ['session_query.index_unavailable'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionQueryErrors);
