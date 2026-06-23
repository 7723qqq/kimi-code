import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import { OrderedHookSlot } from '../hooks';
import type { ContextMessage, WireRecord } from '../types';
import { IEventBus } from '../eventBus/eventBus';
import { IWireRecord } from '../wireRecord/wireRecord';
import { IContextMemory } from './contextMemory';

declare module '../types' {
  interface AgentEventMap {
    'context.spliced': {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
    };
  }

  interface WireRecordMap {
    'context.splice': {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
    };
  }
}

export class ContextMemoryService extends Disposable implements IContextMemory {
  private readonly history: ContextMessage[] = [];

  readonly hooks = {
    onSpliced: new OrderedHookSlot<{
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(
      wireRecord.register('context.splice', (record) => {
        this.applySplice(record);
      }),
    );
  }

  getHistory(): readonly ContextMessage[] {
    return [...this.history];
  }

  spliceHistory(start: number, deleteCount: number, ...messages: ContextMessage[]): void {
    const record: WireRecord<'context.splice'> = {
      type: 'context.splice',
      start,
      deleteCount,
      messages,
    };
    this.wireRecord.append(record);
    this.applySplice(record);
  }

  private applySplice(record: WireRecord<'context.splice'>): void {
    const messages = [...record.messages];
    this.history.splice(record.start, record.deleteCount, ...messages);
    const context = {
      start: record.start,
      deleteCount: record.deleteCount,
      messages,
    };
    void this.hooks.onSpliced.run(context);
    this.eventBus.emit({ type: 'context.spliced', ...context });
  }
}

registerSingleton(IContextMemory, new SyncDescriptor(ContextMemoryService, [], true));
