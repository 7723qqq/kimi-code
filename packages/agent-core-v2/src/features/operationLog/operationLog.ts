export const OPERATION_LOG_RECORD_VERSION = 1;
export const OPERATION_LOG_MAX_OPERATIONS = 1000;
export const OPERATION_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const OPERATION_LOG_DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

export const OPERATION_LOG_DEFAULT_RETENTION = {
  maxOperations: OPERATION_LOG_MAX_OPERATIONS,
  maxAgeMs: OPERATION_LOG_MAX_AGE_MS,
  maxTotalBytes: OPERATION_LOG_DEFAULT_MAX_TOTAL_BYTES,
} as const;

export type OperationGitHead =
  | { readonly kind: 'branch'; readonly ref: string; readonly target: string }
  | { readonly kind: 'detached'; readonly target: string }
  | { readonly kind: 'unborn'; readonly ref: string };

export interface OperationView {
  readonly tree: string;
  readonly head: OperationGitHead;
  readonly refs: Readonly<Record<string, string>>;
  readonly indexTree: string;
  readonly unfinishedOperation?: 'merge' | 'rebase';
}

export function operationGitHeadsEqual(left: OperationGitHead, right: OperationGitHead): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'unborn') return right.kind === 'unborn' && left.ref === right.ref;
  if (left.kind === 'detached') {
    return right.kind === 'detached' && left.target === right.target;
  }
  return right.kind === 'branch' && left.ref === right.ref && left.target === right.target;
}

export function operationRefsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftNames = Object.keys(left).toSorted();
  const rightNames = Object.keys(right).toSorted();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name])
  );
}

export function operationViewsEqual(left: OperationView, right: OperationView): boolean {
  return (
    left.tree === right.tree &&
    left.indexTree === right.indexTree &&
    left.unfinishedOperation === right.unfinishedOperation &&
    operationGitHeadsEqual(left.head, right.head) &&
    operationRefsEqual(left.refs, right.refs)
  );
}

export type OperationKind = 'capture' | 'undo' | 'redo' | 'restore';

export interface OperationOrigin {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
}

export interface OperationRecord {
  readonly version: number;
  readonly id: string;
  readonly parents: readonly string[];
  readonly beforeViewId?: string;
  readonly viewId: string;
  readonly kind: OperationKind;
  readonly targetId?: string;
  readonly at: string;
  readonly description: string;
  readonly nonce: string;
  readonly origin?: OperationOrigin;
}

export interface OperationLogHead {
  readonly operationId: string;
  readonly undoTargetId?: string;
  readonly redoStack: readonly string[];
}

export interface OperationLogRetention {
  readonly maxOperations: number;
  readonly maxAgeMs: number;
  readonly maxTotalBytes: number;
}

export interface OperationActionInput {
  readonly at: Date;
  readonly description: string;
  readonly origin?: OperationOrigin;
}

export type OperationLogErrorCode =
  | 'busy'
  | 'corrupt'
  | 'invalid'
  | 'not-found'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'recovery-required'
  | 'retention-exceeded'
  | 'staged-changes'
  | 'unfinished-operation'
  | 'view-mismatch';

export interface OperationLogErrorDetails {
  readonly limit?: 'operations' | 'age' | 'bytes';
  readonly maximum?: number;
  readonly operation?: 'merge' | 'rebase';
}

export class OperationLogError extends Error {
  override readonly name = 'OperationLogError';

  constructor(
    readonly code: OperationLogErrorCode,
    message: string,
    readonly details?: OperationLogErrorDetails,
  ) {
    super(message);
  }
}
