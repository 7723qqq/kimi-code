import type { IDisposable } from "#/_base/di";
import { createDecorator } from "#/_base/di";
import type { AgentEvent } from '@moonshot-ai/protocol';

export interface IAgentEventSinkService {
  readonly _serviceBrand: undefined;
  emit(event: AgentEvent): void;
  on(handler: (event: AgentEvent) => void): IDisposable;
}

export const IAgentEventSinkService = createDecorator<IAgentEventSinkService>('agentEventSinkService');
