import type { IDisposable } from "#/_base/di";
import { createDecorator } from "#/_base/di";
import type { AgentEvent } from '@moonshot-ai/protocol';

export interface IEventSink {
  readonly _serviceBrand: undefined;
  emit(event: AgentEvent): void;
  on(handler: (event: AgentEvent) => void): IDisposable;
}

export const IEventSink = createDecorator<IEventSink>('agentEventSink');
