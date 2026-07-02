import { createDecorator } from '#/_base/di';
import type { TokenUsage } from '#/app/llmProtocol';
import type { Hooks } from '#/hooks';
import type { TurnResult } from './types';

export interface TurnBeforeStepContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
}

export interface TurnAfterStepContext extends TurnBeforeStepContext {
  continueTurn: boolean;
}

export interface TurnStepUsageContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly usage: TokenUsage;
  readonly stepNumber: number;
  readonly stepUuid: string;
  readonly toolCallCount: number;
  stopTurn: boolean;
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
    onStepUsage: TurnStepUsageContext;
    afterStep: TurnAfterStepContext;
    onContextOverflow: TurnContextOverflowContext;
  }>;
  runTurn(turnId: number, signal?: AbortSignal): Promise<TurnResult>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
