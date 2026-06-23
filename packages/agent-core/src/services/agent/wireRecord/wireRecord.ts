import { createDecorator } from '../../../di';
import type { IDisposable } from '../../../di';

import type { Hooks } from '../hooks';
import type { WireRecord, WireRecordMap } from '../types';

export interface IWireRecord {
  append(record: WireRecord): void;
  register<T extends keyof WireRecordMap>(
    type: T,
    resumer: (data: WireRecord<T>) => void | Promise<void>,
  ): IDisposable;

  readonly hooks: Hooks<{
    onResumeEnded: {};
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWireRecord = createDecorator<IWireRecord>('agentWireRecordService');
