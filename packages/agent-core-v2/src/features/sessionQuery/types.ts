/**
 * `sessionQuery` domain — public records for exact reads and relationship
 * traces over the logical session corpus.
 *
 * Ported from deepseek-harness `session-query/session-query` types (MIT),
 * adapted to the kimi session model: sessions carry the `SessionSummary`
 * fields (id, cwd, createdAt) plus a `parentSessionId` derived from the
 * session index's `custom.parent_session_id`, and `live`/`persisted`
 * availability comes from the workspace session registry vs the session
 * index. Event-level records are deferred to stage B (full-text search).
 */

/** Lightweight identity and source availability for one logical session. */
export interface SessionRecord {
  /** Session id. */
  readonly id: string;
  /** Owning workspace id (kimi-specific; scopes the wire journal reads). */
  readonly workspaceId: string;
  /** Working directory recorded at session creation, when known. */
  readonly cwd?: string;
  /** Session creation time in Unix epoch milliseconds. */
  readonly createdAt: number;
  /** Parent session id (fork provenance), when recorded by the index. */
  readonly parentSessionId?: string;
  /** Whether the id currently exists in a live workspace session registry. */
  readonly live: boolean;
  /** Whether the session index currently materializes the id. */
  readonly persisted: boolean;
}

/** Source availability predicates understood by logical-session filters. */
export type SessionAvailability = 'live' | 'persisted';

/** Inclusive numeric interval used by time and sequence filters. */
export interface SessionResultRange {
  /** Inclusive lower bound. */
  readonly from?: number;
  /** Inclusive upper bound. */
  readonly to?: number;
}

/** One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
export type SessionResultFilter =
  | { kind: 'id'; values: readonly string[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (string | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] };

/** Recursive descendant node in a session-lineage trace. */
export interface SessionLineageNode {
  /** Logical-corpus record for this descendant. */
  readonly session: SessionRecord;
  /** Direct children, each carrying its own recursive descendants. */
  readonly descendants: readonly SessionLineageNode[];
}

export type {
  SessionEventResultFilter,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from './events';
export { SessionSearchCursor } from './cursor';

/** Known ancestry and descendants for one logical session. */
export type SessionLineageTrace = {
  /** Record for the session that was traced. */
  readonly target: SessionRecord;
  /** Known parents from the immediate parent outward. */
  readonly ancestors: readonly SessionRecord[];
  /** Complete known descendant trees rooted at the target's direct children. */
  readonly descendants: readonly SessionLineageNode[];
} & (
  | {
      /** The complete parent chain is present in the logical corpus. */
      readonly complete: true;
      /** Record at the top of the complete lineage. */
      readonly root: SessionRecord;
    }
  | {
      /** The parent chain leaves the visible logical corpus. */
      readonly complete: false;
      /** First parent id that is not present in the logical corpus. */
      readonly unresolvedParentId: string;
    }
);
