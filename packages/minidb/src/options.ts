import type { RecoveryMode, ValueMode } from './recovery.js';
import type {
  ValueCodecName,
  ValueModeSetting,
  OpenOptions,
} from './types.js';
import { CODECS } from './value-codec.js';
import type { FsyncPolicy } from './wal.js';

const FSYNC_POLICIES: ReadonlySet<FsyncPolicy> = new Set<FsyncPolicy>([
  'always',
  'everysec',
  'no',
]);
const VALUE_MODES: ReadonlySet<ValueMode> = new Set<ValueMode>(['memory', 'disk']);
type MaxMemoryPolicy = 'reject' | 'evict-lru';
type RecoveryModeValue = 'resync' | 'strict';
const MAX_MEMORY_POLICIES: ReadonlySet<MaxMemoryPolicy> = new Set<MaxMemoryPolicy>([
  'reject',
  'evict-lru',
]);
const RECOVERY_MODES: ReadonlySet<RecoveryModeValue> = new Set<RecoveryModeValue>([
  'resync',
  'strict',
]);

export interface ParsedMiniDbOptions {
  readonly dir: string;
  readonly readOnly: boolean;
  readonly fsyncPolicy: FsyncPolicy;
  readonly syncIntervalMs: number;
  readonly codecName: ValueCodecName;
  readonly valueMode: ValueModeSetting;
  readonly compactThresholdBytes: number;
  readonly autoCompact: boolean;
  readonly maxMemoryBytes: number | null;
  readonly maxMemoryPolicy: 'reject' | 'evict-lru';
  readonly indexGenerationsEnabled: boolean;
  readonly textBuildWorkerEnabled: boolean;
  readonly deferTextBuildsEnabled: boolean;
  readonly textBuildMemoryBytes: number;
  readonly maintenanceIoConcurrency: number;
  readonly recovery: 'resync' | 'strict';
  readonly activeExpireIntervalMs: number;
}

function positiveFinite(label: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    if (!Number.isFinite(fallback)) {
      throw new RangeError(`${label} must be a positive finite number`);
    }
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(
  label: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) {
    if (!Number.isFinite(fallback)) {
      throw new RangeError(`${label} must be a finite number >= 0`);
    }
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number >= 0`);
  }
  return value;
}

function oneOf<T extends string>(
  label: string,
  value: string | undefined,
  allowed: ReadonlySet<T>,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!allowed.has(value as T)) {
    const list = [...allowed].map((entry) => JSON.stringify(entry)).join(', ');
    throw new RangeError(`unknown ${label}: ${JSON.stringify(value)} (expected one of ${list})`);
  }
  return value as T;
}

/**
 * Validate every `MiniDb.open()` option at the open boundary.
 *
 * Each option's allowed values live here rather than at its first use, so a
 * new enum gains a whitelist entry (or a RangeError at open time) instead of
 * silently degrading: an unrecognized `valueCodec` used to leave `codec`
 * undefined until the first write, an unrecognized `maxMemoryPolicy` fell back
 * to `reject` behaviour, and an unrecognized `recovery` fell back to `resync`.
 */
export function parseMiniDbOptions(opts: OpenOptions): ParsedMiniDbOptions {
  if (!opts || !opts.dir) throw new TypeError('MiniDb.open: opts.dir is required');

  const codecName: ValueCodecName =
    opts.valueCodec === undefined
      ? 'buffer'
      : Object.prototype.hasOwnProperty.call(CODECS, opts.valueCodec)
        ? opts.valueCodec
        : (() => {
            const list = Object.keys(CODECS)
              .map((entry) => JSON.stringify(entry))
              .join(', ');
            throw new RangeError(
              `unknown valueCodec: ${JSON.stringify(String(opts.valueCodec))} (expected one of ${list})`,
            );
          })();
  const requestedMode: ValueModeSetting = opts.valueMode ?? 'memory';
  if (
    requestedMode !== 'memory' &&
    requestedMode !== 'disk' &&
    requestedMode !== 'auto'
  ) {
    throw new RangeError(`unknown valueMode: ${String(requestedMode)}`);
  }
  const resolvedMode: ValueModeSetting = requestedMode;

  const maxMemoryBytes = opts.maxMemoryBytes ?? null;
  if (maxMemoryBytes !== null && (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0)) {
    throw new RangeError('maxMemoryBytes must be a positive finite number');
  }

  return {
    dir: opts.dir,
    readOnly: opts.readOnly === true,
    fsyncPolicy: oneOf('fsyncPolicy', opts.fsyncPolicy, FSYNC_POLICIES, 'everysec' as FsyncPolicy),
    syncIntervalMs: nonNegativeFinite('syncIntervalMs', opts.syncIntervalMs, 1000),
    codecName,
    valueMode: resolvedMode,
    compactThresholdBytes: nonNegativeFinite(
      'compactThresholdBytes',
      opts.compactThresholdBytes,
      64 * 1024 * 1024,
    ),
    autoCompact: opts.autoCompact ?? true,
    maxMemoryBytes,
    maxMemoryPolicy: oneOf<MaxMemoryPolicy>(
      'maxMemoryPolicy',
      opts.maxMemoryPolicy,
      MAX_MEMORY_POLICIES,
      'reject',
    ),
    indexGenerationsEnabled: opts.indexGenerations ?? true,
    textBuildWorkerEnabled: opts.textBuildWorker ?? true,
    deferTextBuildsEnabled: opts.deferOpenTextBuilds ?? true,
    textBuildMemoryBytes: positiveFinite('textBuildMemoryBytes', opts.textBuildMemoryBytes, 64 * 1024 * 1024),
    maintenanceIoConcurrency: positiveFinite(
      'maintenanceIoConcurrency',
      opts.maintenanceIoConcurrency,
      4,
    ),
    recovery: oneOf<RecoveryModeValue>('recovery', opts.recovery, RECOVERY_MODES, 'resync'),
    activeExpireIntervalMs: nonNegativeFinite(
      'activeExpireIntervalMs',
      opts.activeExpireIntervalMs,
      1000,
    ),
  };
}

/**
 * Validate a TTL expressed in milliseconds. Rejects non-finite values (shared
 * with the write path) and negatives, which used to mean "already expired" and
 * silently dropped the value on the next read.
 */
export function parseTtlMs(ttlMs: number | undefined): number | undefined {
  if (ttlMs === undefined) return undefined;
  if (!Number.isFinite(ttlMs)) {
    throw new RangeError('ttl must be a finite number of milliseconds');
  }
  if (ttlMs < 0) {
    throw new RangeError('ttl must be a non-negative number of milliseconds');
  }
  return ttlMs;
}
