import { createDecorator } from '#/_base/di';
import type { TokenUsage } from '#/app/llmProtocol';
import type { Hooks } from '#/hooks';

import type { TurnResult } from './types';

export interface TurnBeforeStepContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
}

export interface TurnAfterStepContext extends TurnBeforeStepContext {
  readonly usage: TokenUsage;
  continueTurn: boolean;
}

export interface TurnContextOverflowContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly error: unknown;
  handled: boolean;
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;
  readonly hooks: Hooks<{
    beforeStep: TurnBeforeStepContext;
    afterStep: TurnAfterStepContext;
    onContextOverflow: TurnContextOverflowContext;
  }>;
  runTurn(turnId: number, signal?: AbortSignal): Promise<TurnResult>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
