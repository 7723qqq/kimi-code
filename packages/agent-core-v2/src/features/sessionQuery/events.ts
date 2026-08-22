import type { SessionSearchCursor } from './cursor';
import type { SessionRecord, SessionResultFilter, SessionResultRange } from './types';

export type { SessionSearchCursor } from './cursor';

/** Lightweight metadata for one event within a logical session. */
export interface SessionEventRecord {
  /** Session that owns the event. */
  readonly sessionId: string;
  /** Monotonic event seq within the session (journal order). */
  readonly seq: number;
  /** Discriminant of the wire record. */
  readonly type: string;
  /** Event timestamp in Unix epoch milliseconds. */
  readonly time: number;
}

/** One event predicate. A filter array is ANDed; list-valued clauses are ORed. */
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly string[] }
  | { kind: 'text'; text: string };

/** Searchable semantic document derived from one session event. */
export interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and the full-text index. */
  readonly text: string;
}

/** Controls shared by search calls. */
export interface SessionSearchExecContext {
  /** Abort caller waiting. */
  readonly signal?: AbortSignal;
}

/** Within-session full-text search request. */
export interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  readonly sessionId: string;
  /** Full-text query interpreted as data, never executable query syntax. */
  readonly query: string;
  /** Event predicates applied before ranking. */
  readonly filters?: readonly SessionEventResultFilter[];
  /** Maximum events in this page. */
  readonly limit?: number;
  /** Opaque cursor returned for the identical normalized request. */
  readonly cursor?: SessionSearchCursor;
}

/** Cross-session full-text search request. */
export interface SessionSearchRequest {
  /** Full-text query interpreted as data. */
  readonly query: string;
  /** Logical-session predicates applied before event ranking. */
  readonly sessionFilters?: readonly SessionResultFilter[];
  /** Event predicates applied before event ranking. */
  readonly eventFilters?: readonly SessionEventResultFilter[];
  /** Maximum sessions in this page. */
  readonly limit?: number;
  /** Opaque cursor returned for the identical normalized request. */
  readonly cursor?: SessionSearchCursor;
}

/** One event full-text search hit with a bounded plain-text excerpt. */
export interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  readonly snippet: string;
}

/** One grouped cross-session hit, ranked by its strongest matching event. */
export interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  readonly bestMatch: SessionEventSearchHit;
}

/** One cursor-paginated result page. */
export interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  readonly items: readonly T[];
  /** Opaque continuation cursor, absent on the final page. */
  readonly nextCursor?: SessionSearchCursor;
}

/** Event-search results bound to the searched session. */
export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Searched session id. */
  readonly sessionId: string;
}
