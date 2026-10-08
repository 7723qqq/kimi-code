import type { SessionSearchCursor } from './cursor';
import type { SessionRecord, SessionResultFilter, SessionResultRange } from './types';

export type { SessionSearchCursor } from './cursor';

export interface SessionEventRecord {

  readonly sessionId: string;

  readonly seq: number;

  readonly type: string;

  readonly time: number;
}

export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly string[] }
  | { kind: 'text'; text: string };

export interface SessionEventSearchDocument extends SessionEventRecord {

  readonly text: string;
}

export interface SessionSearchExecContext {

  readonly signal?: AbortSignal;
}

export interface SessionEventSearchRequest {

  readonly sessionId: string;

  readonly query: string;

  readonly filters?: readonly SessionEventResultFilter[];

  readonly limit?: number;

  readonly cursor?: SessionSearchCursor;
}

export interface SessionSearchRequest {

  readonly query: string;

  readonly sessionFilters?: readonly SessionResultFilter[];

  readonly eventFilters?: readonly SessionEventResultFilter[];

  readonly limit?: number;

  readonly cursor?: SessionSearchCursor;
}

export interface SessionEventSearchHit extends SessionEventRecord {

  readonly snippet: string;
}

export interface SessionSearchHit extends SessionRecord {

  readonly bestMatch: SessionEventSearchHit;
}

export interface SessionSearchPage<T> {

  readonly items: readonly T[];

  readonly nextCursor?: SessionSearchCursor;
}

export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {

  readonly sessionId: string;
}
