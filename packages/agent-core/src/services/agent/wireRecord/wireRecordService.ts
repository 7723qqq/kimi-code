import {
  Disposable,
  InstantiationType,
  registerSingleton,
  toDisposable,
} from '../../../di';

import { OrderedHookSlot } from '../hooks';
import type { WireRecord, WireRecordMap } from '../types';
import { IWireRecord } from './wireRecord';

type Resumer<T extends keyof WireRecordMap> = (data: WireRecord<T>) => void | Promise<void>;

export class WireRecordService extends Disposable implements IWireRecord {
  private readonly records: WireRecord[] = [];
  private readonly resumers = new Map<keyof WireRecordMap, Set<Resumer<keyof WireRecordMap>>>();
  readonly hooks = { onResumeEnded: new OrderedHookSlot<{}>() };

  append(record: WireRecord): void {
    this.records.push(record);
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

  async restore(records: readonly WireRecord[]): Promise<void> {
    for (const record of records) {
      const resumers = this.resumers.get(record.type);
      if (resumers === undefined) continue;
      const currentResumers = Array.from(resumers);
      for (const resumer of currentResumers) {
        await resumer(record);
      }
    }
    await this.hooks.onResumeEnded.run({});
  }

  snapshot(): readonly WireRecord[] {
    return [...this.records];
  }
}

registerSingleton(IWireRecord, WireRecordService, InstantiationType.Delayed);
