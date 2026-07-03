import { createDecorator } from '#/_base/di';
import type { TokenUsage } from '#/app/llmProtocol';
import type { Hooks } from '#/hooks';

import type { TurnResult } from './types';

export interface TurnBeforeStepContext {
  readonly turnId: number;
  readonly step: number;
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

export interface TurnWillStopContext {
  readonly signal: AbortSignal;
  continuationPrompt?: string;
}

export interface RunTurnOptions {
  readonly signal?: AbortSignal;
  /** Fires on the first model response event for a step, or at step completion. */
  readonly onStepStarted?: (step: number) => void;
}

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;
  readonly hooks: Hooks<{
    beforeStep: TurnBeforeStepContext;
    afterStep: TurnAfterStepContext;
    onContextOverflow: TurnContextOverflowContext;
    onWillStop: TurnWillStopContext;
  }>;
  runTurn(turnId: number, options?: RunTurnOptions): Promise<TurnResult>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
