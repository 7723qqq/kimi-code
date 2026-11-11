import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';

import type { IAgentJournal } from './journal';
import type { RecordDehydrator, WireRecord } from './record';

export { ForkLineError, type ForkLineFailure } from './tree';
import type { WireLine } from './tree';

export interface WireRestoreChains {
  readonly restorable: readonly WireRecord[];
  readonly journal: readonly WireRecord[];
}

export interface IWireService extends IAgentJournal {
  readonly _serviceBrand: undefined;

  seal(): Promise<void>;
  appendRecord(record: WireRecord, dehydrate?: RecordDehydrator): void;
  onDidAppendRecord(listener: (record: WireRecord) => void): IDisposable;
  readJournal(): AsyncIterable<WireRecord>;
  readRestorable(): AsyncIterable<WireRecord>;
  readRestoreChains(): Promise<WireRestoreChains>;
  readHumanChain(): readonly WireLine[];
  flush(): Promise<void>;
  drainPersisted(): Promise<void>;
  lineCount(): number;
  lastContextClearLine(): number | undefined;
  journalPath(): string | undefined;
  externallyModified(): boolean;
}

export const IWireService: ServiceIdentifier<IWireService> =
  createDecorator<IWireService>('wireService');
