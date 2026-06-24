import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '../../../rpc/resumed';

import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IReplayBuilderService,
  type ReplayBuilderServiceOptions,
} from './replayBuilder';

const UNDO_BOUNDARY_RECORD_TYPES = new Set(['context.clear', 'context.apply_compaction']);

export class ReplayBuilderService extends Disposable implements IReplayBuilderService {
  declare readonly _serviceBrand: undefined;

  captureLiveRecords = false;

  private readonly records: AgentReplayRecord[] = [];
  private _postRestoring = false;
  private frozen = false;
  private segmentStart = 0;

  constructor(
    private readonly options: ReplayBuilderServiceOptions = {},
    @IWireRecord private readonly wireRecord: IWireRecord,
  ) {
    super();
    this._register(
      wireRecord.hooks.onRestoredRecord.register('replay-builder', async (context, next) => {
        await next();
        if (this.finishRestoringRecord(context.record.type)) {
          context.stop = true;
        }
      }),
    );
  }

  get postRestoring(): boolean {
    return this._postRestoring || this.wireRecord.postRestoring;
  }

  set postRestoring(value: boolean) {
    this._postRestoring = value;
  }

  push(record: AgentReplayRecordPayload): void {
    if (
      !this.captureLiveRecords &&
      this.wireRecord.restoring === null &&
      !this.postRestoring
    ) {
      return;
    }
    if (this.frozen) return;

    this.records.push({
      ...record,
      time: this.wireRecord.restoring?.time ?? Date.now(),
    });
  }

  patchLast<T extends AgentReplayRecord['type']>(
    type: T,
    patch: Partial<Extract<AgentReplayRecord, { type: T }>>,
  ): void {
    if (this.frozen) return;
    if (this.wireRecord.restoring === null) return;

    const last = this.records.at(-1);
    if (last?.type === type) {
      Object.assign(last, patch);
    }
  }

  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (this.frozen) return;
    if (removedMessages.size === 0) return;
    this.removeMessagesFrom(this.records, removedMessages);
  }

  finishRestoringRecord(type: string): boolean {
    const range = this.options.range;
    if (range === undefined) return false;
    if (this.frozen) return true;
    if (!UNDO_BOUNDARY_RECORD_TYPES.has(type)) return false;
    if (range.start === undefined) return false;

    const start = range.start;
    const nextSegmentStart = this.segmentStart + this.records.length;
    if (nextSegmentStart > start) {
      this.frozen = true;
      return true;
    }

    this.segmentStart = nextSegmentStart;
    this.records.splice(0);
    return false;
  }

  buildResult(): readonly AgentReplayRecord[] {
    const range = this.options.range;
    if (range !== undefined) {
      if (range.start === undefined && range.count !== undefined) {
        const offset = Math.max(0, this.records.length - range.count);
        return this.records.slice(offset);
      }
      const start = range.start ?? 0;
      const offset = Math.max(0, start - this.segmentStart);
      const count = range.count;
      const end = count === undefined ? undefined : offset + count;
      return this.records.slice(offset, end);
    }
    return this.records;
  }

  private removeMessagesFrom(
    records: AgentReplayRecord[],
    removedMessages: ReadonlySet<ContextMessage>,
  ): void {
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.type === 'message' && removedMessages.has(record.message)) {
        records.splice(i, 1);
      }
    }
  }
}

registerSingleton(
  IReplayBuilderService,
  new SyncDescriptor(ReplayBuilderService, [{}], true),
);
