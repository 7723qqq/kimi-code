import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import type { ToolStoreData, ToolStoreKey } from '../../../tools/store';
import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import type { WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { IToolStoreService } from './toolStore';

declare module '../types' {
  interface WireRecordMap {
    'tools.update_store': {
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
    };
  }

  interface AgentEventMap {
    'tool.store.updated': {
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
      store: Readonly<Partial<ToolStoreData>>;
    };
  }
}

export class ToolStoreService extends Disposable implements IToolStoreService {
  private readonly store: Partial<ToolStoreData> = {};

  readonly hooks = {
    onUpdated: new OrderedHookSlot<{
      key: ToolStoreKey;
      value: ToolStoreData[ToolStoreKey];
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
  ) {
    super();
    this._register(
      wireRecord.register('tools.update_store', (record) => {
        this.apply(record.key, record.value);
      }),
    );
  }

  get<K extends ToolStoreKey>(key: K): ToolStoreData[K] | undefined {
    return this.store[key];
  }

  set<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    const record: WireRecord<'tools.update_store'> = {
      type: 'tools.update_store',
      key,
      value,
    };
    this.wireRecord.append(record);
    this.apply(key, value);
  }

  data(): Readonly<Partial<ToolStoreData>> {
    return { ...this.store };
  }

  private apply<K extends ToolStoreKey>(key: K, value: ToolStoreData[K]): void {
    this.store[key] = value;
    void this.hooks.onUpdated.run({ key, value });
    this.events.emit({
      type: 'tool.store.updated',
      key,
      value,
      store: this.data(),
    });
  }
}

registerSingleton(IToolStoreService, new SyncDescriptor(ToolStoreService, [], true));
