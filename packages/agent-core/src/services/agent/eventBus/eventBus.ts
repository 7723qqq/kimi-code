import { createDecorator } from '../../../di';
import type { IDisposable } from '../../../di';

import type { AgentEvent } from '../types';

export interface IEventBus {
  emit(event: AgentEvent): void;
  on(handler: (event: AgentEvent) => void): IDisposable;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventBus = createDecorator<IEventBus>('agentEventBusService');
