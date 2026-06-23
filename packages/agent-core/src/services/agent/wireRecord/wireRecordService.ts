import { join } from 'pathe';

import {
  Disposable,
  InstantiationType,
  registerSingleton,
  toDisposable,
} from '../../../di';
import {
  AGENT_WIRE_PROTOCOL_VERSION,
  isNewerWireVersion,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
  type WireMigrationRecord,
} from '../../../agent/records/migration';

import { OrderedHookSlot } from '../hooks';
import type { WireRecord, WireRecordMap } from '../types';
import {
  IWireRecord,
  type PersistedWireRecord,
  type WireRecordMetadata,
  type WireRecordPersistence,
  type WireRecordRestoreOptions,
  type WireRecordRestoreResult,
  type WireRecordServiceOptions,
} from './wireRecord';
import { FileSystemWireRecordPersistence } from './persistence';

type Resumer<T extends keyof WireRecordMap> = (data: WireRecord<T>) => void | Promise<void>;

export class WireRecordService extends Disposable implements IWireRecord {
  private readonly records: WireRecord[] = [];
  private readonly resumers = new Map<keyof WireRecordMap, Set<Resumer<keyof WireRecordMap>>>();
  private readonly persistence: WireRecordPersistence | undefined;
  private _restoring: { time?: number } | null = null;
  private metadataInitialized = false;
  readonly hooks = {
    onResumeEnded: new OrderedHookSlot<{}>(),
  };

  constructor(private readonly options: WireRecordServiceOptions = {}) {
    super();
    this.persistence =
      options.persistence ??
      (options.homedir === undefined
        ? undefined
        : new FileSystemWireRecordPersistence(join(options.homedir, 'wire.jsonl'), {
            onError: (error) => {
              this.reportPersistenceError(error);
            },
          }));
  }

  get restoring() {
    return this._restoring;
  }

  append(record: WireRecord): void {
    if (this._restoring !== null) return;
    const stamped: WireRecord =
      record.time !== undefined ? record : ({ ...record, time: Date.now() } as WireRecord);
    this.records.push(stamped);
    this.appendPersistent(stamped);
  }

  register<T extends keyof WireRecordMap>(
    type: T,
    resumer: (data: WireRecord<T>) => void | Promise<void>,
  ) {
    const typed = resumer as unknown as Resumer<keyof WireRecordMap>;
    let set = this.resumers.get(type);
    if (set === undefined) {
      set = new Set();
      this.resumers.set(type, set);
    }
    set.add(typed);
    return toDisposable(() => {
      set?.delete(typed);
    });
  }

  async restore(
    records?: readonly PersistedWireRecord[],
    options: WireRecordRestoreOptions = {},
  ): Promise<WireRecordRestoreResult> {
    const fromPersistence = records === undefined;
    const source = records ?? this.persistence?.read();
    if (source === undefined) {
      await this.runResumeEndedHooks();
      return {};
    }

    const rewriteMigratedRecords =
      fromPersistence && (options.rewriteMigratedRecords ?? true);
    const restoredRecords: PersistedWireRecord[] | undefined =
      rewriteMigratedRecords ? [] : undefined;
    const requireMetadata = fromPersistence && this.persistence !== undefined;
    let migrations: readonly WireMigration[] = [];
    let sawRecord = false;
    let shouldRewrite = false;
    let warning: string | undefined;

    for await (const record of toAsyncIterable(source)) {
      if (!sawRecord) {
        sawRecord = true;
        if (record.type === 'metadata') {
          this.metadataInitialized = true;
          const readVersion = record.protocol_version;
          if (isNewerWireVersion(readVersion)) {
            warning = `Session wire protocol version ${readVersion} is newer than the current version ${AGENT_WIRE_PROTOCOL_VERSION}. Records will be restored without migration.`;
            shouldRewrite = false;
          } else {
            migrations = resolveWireMigrations(readVersion);
            shouldRewrite = readVersion !== AGENT_WIRE_PROTOCOL_VERSION;
          }
        } else if (requireMetadata) {
          throw new Error('WireRecord restore expected metadata as the first record');
        }
      }

      let migratedRecord = migrateWireRecord(
        record as WireMigrationRecord,
        migrations,
      ) as PersistedWireRecord;
      if (migratedRecord.type === 'metadata') {
        migratedRecord = {
          ...migratedRecord,
          protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        };
        this.metadataInitialized = true;
      }
      restoredRecords?.push(migratedRecord);
      if (migratedRecord.type === 'metadata') continue;

      await this.restoreRecord(migratedRecord);
    }

    if (shouldRewrite && restoredRecords !== undefined) {
      this.persistence?.rewrite(restoredRecords);
      await this.persistence?.flush();
    }
    await this.runResumeEndedHooks();
    return warning === undefined ? {} : { warning };
  }

  async flush(): Promise<void> {
    await this.persistence?.flush();
  }

  async close(): Promise<void> {
    await this.persistence?.close();
  }

  private appendPersistent(record: PersistedWireRecord): void {
    if (this.persistence === undefined) return;
    if (!this.metadataInitialized && record.type !== 'metadata') {
      const metadata: WireRecordMetadata = {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: Date.now(),
      };
      try {
        this.persistence.append(metadata);
        this.metadataInitialized = true;
      } catch (error) {
        this.reportPersistenceError(error, metadata);
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      }
    }
    if (record.type === 'metadata') {
      this.metadataInitialized = true;
    }
    try {
      this.persistence.append(record);
    } catch (error) {
      this.reportPersistenceError(error, record);
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw error;
    }
  }

  private async restoreRecord(record: WireRecord): Promise<void> {
    this.records.push(record);
    this._restoring = { time: record.time ?? Date.now() };
    try {
      const resumers = this.resumers.get(record.type);
      if (resumers !== undefined) {
        const currentResumers = Array.from(resumers);
        for (const resumer of currentResumers) {
          await resumer(record);
        }
      }
    } finally {
      this._restoring = null;
    }
  }

  private async runResumeEndedHooks(): Promise<void> {
    await this.hooks.onResumeEnded.run({});
  }

  private reportPersistenceError(
    error: unknown,
    record?: PersistedWireRecord,
  ): void {
    this.options.onPersistenceError?.(error, record);
  }
}

async function* toAsyncIterable<T>(
  source: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const item of source) {
    yield item;
  }
}

registerSingleton(IWireRecord, WireRecordService, InstantiationType.Delayed);
