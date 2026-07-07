import { createDecorator } from '#/_base/di/instantiation';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';

export interface ContextSizeStatus {
  readonly contextTokens: number;
  readonly contextTokensWithPending: number;
}

export interface IAgentContextSizeService {
  readonly _serviceBrand: undefined;

  getStatus(): ContextSizeStatus;
  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void;
}

export const IAgentContextSizeService =
  createDecorator<IAgentContextSizeService>('agentContextSizeService');
