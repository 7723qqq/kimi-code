import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export const SNAPSHOT_RECORD_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_DIR_NAME = 'snapshots';

export type SnapshotWriteMode = 'overwrite' | 'edit';
export type SnapshotSkipReason = 'max-size' | 'unreadable';

export interface SnapshotTarget {
  readonly path: string;
  readonly tool: string;
  readonly mode: SnapshotWriteMode;
}

function writeModeOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const mode = (args as { mode?: unknown }).mode;
  return typeof mode === 'string' ? mode : undefined;
}

export function resolveSnapshotTarget(
  display: ToolInputDisplay | undefined,
  args: unknown,
): SnapshotTarget | undefined {
  if (display === undefined || display.kind !== 'file_io') return undefined;
  if (display.operation === 'edit') {
    return { path: display.path, tool: display.operation, mode: 'edit' };
  }
  if (display.operation !== 'write') return undefined;
  if (writeModeOf(args) === 'append') return undefined;
  return { path: display.path, tool: display.operation, mode: 'overwrite' };
}

export interface SnapshotRecord {
  readonly version: number;
  readonly id: string;
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly at: string;
  readonly tool: string;
  readonly mode: SnapshotWriteMode;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly previousId?: string;
  readonly skipped?: SnapshotSkipReason;
  readonly afterHash?: string;
  readonly afterSize?: number;
}

export interface SnapshotRecordInput {
  readonly path: string;
  readonly at: Date;
  readonly tool: string;
  readonly mode: SnapshotWriteMode;
  readonly size: number;
  readonly mtimeMs?: number;
  readonly bytes?: Uint8Array;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly skipped?: SnapshotSkipReason;
}

export interface SnapshotAgentMark {
  readonly version: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly cwd: string;
  readonly parentAgentId?: string;
  readonly profileName?: string;
  readonly swarmIndex?: number;
}

export interface SnapshotAgentMarkInput {
  readonly agentId: string;
  readonly sessionId: string;
  readonly at: Date;
  readonly cwd: string;
  readonly parentAgentId?: string;
  readonly profileName?: string;
  readonly swarmIndex?: number;
}

export interface ISnapshotStore {
  readonly _serviceBrand: undefined;

  record(input: SnapshotRecordInput): Promise<SnapshotRecord>;
  complete(
    path: string,
    id: string,
    after: { readonly hash: string; readonly size: number },
  ): Promise<boolean>;
  remove(path: string, id: string): Promise<boolean>;
  list(path: string): Promise<readonly SnapshotRecord[]>;
  content(hash: string): Promise<Uint8Array | undefined>;
  markAgent(input: SnapshotAgentMarkInput): Promise<void>;
  agents(sessionId: string): Promise<readonly SnapshotAgentMark[]>;
  prune(options: SnapshotPruneOptions): Promise<SnapshotPruneResult>;
}

export interface SnapshotPruneOptions {
  readonly now: Date;
  readonly maxPerPath: number;
  readonly maxBytesPerPath: number;
  readonly maxAgeMs: number;
  readonly minObjectAgeMs: number;
}

export interface SnapshotPruneResult {
  readonly recordsRemoved: number;
  readonly objectsRemoved: number;
  readonly agentMarksRemoved: number;
}

export const SNAPSHOT_PRUNE_MAX_PER_PATH = 100;
export const SNAPSHOT_PRUNE_MAX_BYTES_PER_PATH = 64 * 1024 * 1024;
export const SNAPSHOT_PRUNE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SNAPSHOT_PRUNE_MIN_OBJECT_AGE_MS = 60 * 1000;
export const SNAPSHOT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface ISnapshotService {
  readonly _serviceBrand: undefined;

  readonly store: ISnapshotStore;
  list(path: string): Promise<readonly SnapshotRecord[]>;
}

export const ISnapshotService: ServiceIdentifier<ISnapshotService> =
  createDecorator<ISnapshotService>('snapshotService');

export interface SnapshotChoice {
  readonly hash?: string;
  readonly previous?: boolean;
}

export function pickSnapshot(
  records: readonly SnapshotRecord[],
  choice: SnapshotChoice = {},
): SnapshotRecord | undefined {
  const wanted = choice.hash;
  if (wanted !== undefined) {
    const exact = records.find((record) => record.hash === wanted || record.id === wanted);
    if (exact !== undefined) return exact;
    const matches = records.filter(
      (record) => record.hash.startsWith(wanted) || record.id.startsWith(wanted),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (choice.previous === true) return records.find((record) => record.hash !== '');
  return records.find((record) => record.hash !== '') ?? records[0];
}

export function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Record<keyof SnapshotRecord, unknown>>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['path'] === 'string' &&
    typeof record['hash'] === 'string' &&
    typeof record['size'] === 'number' &&
    typeof record['at'] === 'string' &&
    typeof record['tool'] === 'string' &&
    (record['mode'] === 'overwrite' || record['mode'] === 'edit')
  );
}

export function isSnapshotAgentMark(value: unknown): value is SnapshotAgentMark {
  if (typeof value !== 'object' || value === null) return false;
  const mark = value as Partial<Record<keyof SnapshotAgentMark, unknown>>;
  return (
    typeof mark['agentId'] === 'string' &&
    typeof mark['sessionId'] === 'string' &&
    typeof mark['at'] === 'string' &&
    typeof mark['cwd'] === 'string'
  );
}
