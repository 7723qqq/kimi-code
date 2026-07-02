/**
 * `record` domain (L3) — `IAgentRecordService` implementation.
 *
 * Owns the unified `append` / `signal` / `define` API: one `append(record)`
 * fans out to durable persistence (delegated to `wireRecord`), live broadcast
 * (an owned `Emitter<AgentEvent>`), and the replay read model (an owned
 * buffer). `signal(event)` emits a live-only event that is never recorded.
 * Live emission is suppressed while restoring, so edge consumers never receive
 * historical events.
 *
 * The replay read model (`push` / `patchLast` / `removeLastMessages` /
 * `buildReplay`) is owned here too — it is one more projection of the same
 * record stream, fed by `toReplay` facets (declarative) and by direct `push`
 * calls from domain handlers (imperative). The former `eventSink` and
 * `replayBuilder` services are folded into this class; `wireRecord` remains the
 * registered persistence backend that this service coordinates.
 */

import { Disposable, toDisposable } from '#/_base/di';
import type { IDisposable } from '#/_base/di';
import { Emitter } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { AgentEvent } from '@moonshot-ai/protocol';

import type { ContextMessage } from '#/agent/contextMemory';
import {
  IAgentWireRecordService,
  type WireRecord,
  type WireRecordBlobSelector,
  type WireRecordMap,
  type WireRecordRestoringContext,
} from '#/agent/wireRecord';
import type { AgentReplayRecord, AgentReplayRecordPayload } from '#/agent/replayBuilder/types';

import {
  IAgentRecordService,
  type AgentRecord,
  type AgentRecordMap,
  type RecordFacets,
  type RecordServiceOptions,
} from './record';

// An undo boundary is a `context.splice` that removes messages from the start of
// the history. It is the canonical (post v1.5 migration) equivalent of the legacy
// `context.clear` and `context.apply_compaction` records, both of which the v1.5
// migration rewrites into a `context.splice` with `start === 0` and
// `deleteCount > 0` (see wireRecord/migration/v1.5.ts). A splice that only
// appends (`deleteCount === 0`) or removes messages from the middle/end of the
// history (`start > 0`, e.g. a migrated `context.undo`) is not a boundary.
function isUndoBoundaryRecord(record: WireRecord): boolean {
  return record.type === 'context.splice' && record.start === 0 && record.deleteCount > 0;
}

export class AgentRecordService extends Disposable implements IAgentRecordService {
  declare readonly _serviceBrand: undefined;
  private readonly facets = new Map<keyof AgentRecordMap, RecordFacets<keyof AgentRecordMap>>();
  private readonly liveEmitter = this._register(new Emitter<AgentEvent>());

  // Replay read model state.
  captureLiveRecords = false;
  private readonly replayRecords: AgentReplayRecord[] = [];
  private _postRestoring = false;
  private frozen = false;
  private segmentStart = 0;

  constructor(
    private readonly options: RecordServiceOptions = {},
    @IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService,
  ) {
    super();
    // Restore-time replay capture: every restored record runs its `toReplay`
    // facet (declarative projection), then the range/segment logic applies.
    // Domain resumers (which run before this hook) perform the imperative
    // `push` calls, so by the time we run here their contributions are already
    // in the buffer.
    this._register(
      wireRecord.hooks.onRestoredRecord.register('record-replay', async (ctx, next) => {
        await next();
        this.runReplayFacet(ctx.record as unknown as AgentRecord);
        if (this.finishRestoringRecord(ctx.record)) {
          ctx.stop = true;
        }
      }),
    );
  }

  append(record: AgentRecord): void {
    this.wireRecord.append(record as unknown as WireRecord);
    const facet = this.facets.get(record.type);
    if (facet?.toLive !== undefined) {
      this.emitLive(facet.toLive(record));
    }
    if (facet?.toReplay !== undefined) {
      this.runReplayFacet(record);
    }
  }

  on(handler: (event: AgentEvent) => void): IDisposable {
    return this.liveEmitter.event(handler);
  }

  signal(event: AgentEvent): void {
    this.emitLive(event);
  }

  define<K extends keyof AgentRecordMap>(type: K, facets: RecordFacets<K>): IDisposable {
    // Merge live/replay facets rather than overwriting: the record type's owner
    // supplies `toLive`/`toReplay`, while secondary resumers (other domains that
    // listen to the same type, e.g. microCompaction listening to
    // `full_compaction.complete`) only contribute a `resume`. First writer wins
    // for live/replay; every `resume` is kept (the durable store supports
    // multiple resumers per type).
    const previous = this.facets.get(type);
    this.facets.set(type, {
      toLive: facets.toLive ?? previous?.toLive,
      toReplay: facets.toReplay ?? previous?.toReplay,
    } as RecordFacets<keyof AgentRecordMap>);
    const resumeReg =
      facets.resume === undefined
        ? undefined
        : this.wireRecord.register(
            type as unknown as keyof WireRecordMap,
            (record) => facets.resume!(record as unknown as AgentRecord<K>),
            facets.blobs === undefined
              ? undefined
              : {
                  blobs: facets.blobs as unknown as WireRecordBlobSelector<
                    WireRecord<keyof WireRecordMap>
                  >,
                },
          );
    return toDisposable(() => {
      resumeReg?.dispose();
    });
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

    this.replayRecords.push({
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

    const last = this.replayRecords.at(-1);
    if (last?.type === type) {
      Object.assign(last, patch);
    }
  }

  removeLastMessages(removedMessages: ReadonlySet<ContextMessage>): void {
    if (this.frozen) return;
    if (removedMessages.size === 0) return;
    this.removeMessagesFrom(this.replayRecords, removedMessages);
  }

  buildReplay(): readonly AgentReplayRecord[] {
    const range = this.options.range;
    if (range !== undefined) {
      if (range.start === undefined && range.count !== undefined) {
        const offset = Math.max(0, this.replayRecords.length - range.count);
        return this.replayRecords.slice(offset);
      }
      const start = range.start ?? 0;
      const offset = Math.max(0, start - this.segmentStart);
      const count = range.count;
      const end = count === undefined ? undefined : offset + count;
      return this.replayRecords.slice(offset, end);
    }
    return this.replayRecords;
  }

  get restoring(): WireRecordRestoringContext | null {
    return this.wireRecord.restoring;
  }

  get postRestoring(): boolean {
    return this._postRestoring || this.wireRecord.postRestoring;
  }

  set postRestoring(value: boolean) {
    this._postRestoring = value;
  }

  get hooks(): IAgentWireRecordService['hooks'] {
    return this.wireRecord.hooks;
  }

  private emitLive(event: AgentEvent): void {
    // Suppress live emission while restoring so edge consumers never receive
    // historical events (matches the former `eventSink.emit` guard).
    if (this.wireRecord.restoring !== null) return;
    this.liveEmitter.fire(event);
  }

  private runReplayFacet(record: AgentRecord): void {
    const facet = this.facets.get(record.type);
    if (facet?.toReplay === undefined) return;
    const out = facet.toReplay(record);
    if (out === undefined) return;
    const list = Array.isArray(out) ? out : [out];
    for (const replayRecord of list) {
      this.push(replayRecord);
    }
  }

  private finishRestoringRecord(record: WireRecord): boolean {
    const range = this.options.range;
    if (range === undefined) return false;
    if (this.frozen) return true;
    if (!isUndoBoundaryRecord(record)) return false;
    if (range.start === undefined) return false;

    const start = range.start;
    const nextSegmentStart = this.segmentStart + this.replayRecords.length;
    if (nextSegmentStart > start) {
      this.frozen = true;
      return true;
    }

    this.segmentStart = nextSegmentStart;
    this.replayRecords.splice(0);
    return false;
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentRecordService,
  AgentRecordService,
  InstantiationType.Delayed,
  'record',
);
