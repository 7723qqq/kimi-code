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
 * The replay read model (`push` / `patchLast` / `removeMessages` / `cut` /
 * `buildReplay`) is owned here too — it is one more projection of the same
 * record stream, fed by `toReplay` facets (declarative) and by direct calls
 * from domain handlers (imperative — e.g. `contextMemory` forwarding a
 * context operation's replay projection). `cut()` marks history-reset
 * boundaries declared by context operations (compaction / clear) and drives
 * the partial-resume windowing. The former `eventSink` and `replayBuilder`
 * services are folded into this class; `wireRecord` remains the registered
 * persistence backend that this service coordinates.
 */

import { Disposable, toDisposable } from '#/_base/di';
import type { IDisposable } from '#/_base/di';
import { Emitter } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { AgentEvent } from '@moonshot-ai/protocol';

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
        // Once a cut() froze the windowed read model, the requested replay
        // window is complete — stop restoring further records.
        if (this.options.range !== undefined && this.frozen) {
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

  removeMessages(messageIds: ReadonlySet<string>): void {
    if (this.frozen) return;
    if (messageIds.size === 0) return;
    for (let i = this.replayRecords.length - 1; i >= 0; i--) {
      const record = this.replayRecords[i]!;
      if (
        record.type === 'message' &&
        record.message.id !== undefined &&
        messageIds.has(record.message.id)
      ) {
        this.replayRecords.splice(i, 1);
      }
    }
  }

  cut(): void {
    if (this.frozen) return;
    const start = this.options.range?.start;
    if (start === undefined) return;
    const nextSegmentStart = this.segmentStart + this.replayRecords.length;
    if (nextSegmentStart > start) {
      this.frozen = true;
      return;
    }
    this.segmentStart = nextSegmentStart;
    this.replayRecords.splice(0);
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

}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRecordService,
  AgentRecordService,
  InstantiationType.Delayed,
  'record',
);
