export interface SessionRecord {

  readonly id: string;

  readonly workspaceId: string;

  readonly cwd?: string;

  readonly createdAt: number;

  readonly parentSessionId?: string;

  readonly live: boolean;

  readonly persisted: boolean;
}

export type SessionAvailability = 'live' | 'persisted';

export interface SessionResultRange {

  readonly from?: number;

  readonly to?: number;
}

export type SessionResultFilter =
  | { kind: 'id'; values: readonly string[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (string | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] };

export interface SessionLineageNode {

  readonly session: SessionRecord;

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

export type SessionLineageTrace = {

  readonly target: SessionRecord;

  readonly ancestors: readonly SessionRecord[];

  readonly descendants: readonly SessionLineageNode[];
} & (
  | {

      readonly complete: true;

      readonly root: SessionRecord;
    }
  | {

      readonly complete: false;

      readonly unresolvedParentId: string;
    }
);
