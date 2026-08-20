import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

export interface TokenCountingRequest {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
}

export interface IAgentTokenCountingService {
  readonly _serviceBrand: undefined;
  get(): ContextSize;
}

export const IAgentTokenCountingService: ServiceIdentifier<IAgentTokenCountingService> =
  createDecorator<IAgentTokenCountingService>('agentTokenCountingService');
