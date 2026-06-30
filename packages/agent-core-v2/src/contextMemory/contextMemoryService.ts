import {
  Disposable,
} from "#/_base/di";
import { OrderedHookSlot } from '#/hooks';
import { IReplayBuilderService } from '#/replayBuilder';
import { IWireRecord, type WireRecord } from '#/wireRecord';
import { IContextMemory } from './contextMemory';
import { ensureMessageId } from './messageId';
import type { ContextMessage } from './types';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'context.splice': {
      start: number;
      deleteCount: number;
      messages: readonly ContextMessage[];
      tokens?: number;
    };
  }
}

export class ContextMemoryService extends Disposable implements IContextMemory {
  declare readonly _serviceBrand: undefined;
  private readonly history: ContextMessage[] = [];

  readonly hooks = {
    onSpliced: new OrderedHookSlot<{
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
  ) {
    super();
    this._register(
      wireRecord.register(
        'context.splice',
        (record) => {
          this.applySplice(record);
        },
        {
          blobs: (record) => record.messages.map((message, index) => ({
            parts: message.content,
            replace: (current, content) => ({
              ...current,
              messages: current.messages.map((item, itemIndex) =>
                itemIndex === index ? { ...item, content: [...content] } : item,
              ),
            }),
          })),
        },
      ),
    );
  }

  get(): readonly ContextMessage[] {
    return [...this.history];
  }

  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void {
    const stamped = messages.map(ensureMessageId);
    const record: WireRecord<'context.splice'> = {
      type: 'context.splice',
      start,
      deleteCount,
      messages: stamped,
      tokens,
    };
    this.wireRecord.append(record);
    this.applySplice(record);
  }

  private applySplice(record: WireRecord<'context.splice'>): void {
    const removedMessages =
      record.deleteCount > 0 && record.start > 0
        ? this.history.slice(record.start, record.start + record.deleteCount)
        : [];
    const messages = record.messages.map(ensureMessageId);
    this.history.splice(record.start, record.deleteCount, ...messages);
    this.replayBuilder.removeLastMessages(new Set(removedMessages));
    for (const message of messages) {
      this.replayBuilder.push({ type: 'message', message });
    }
    void this.hooks.onSpliced.run({
      start: record.start,
      deleteCount: record.deleteCount,
      messages,
      tokens: record.tokens,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IContextMemory,
  ContextMemoryService,
  InstantiationType.Delayed,
  'contextMemory',
);
