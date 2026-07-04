import { createDecorator } from "#/_base/di";
import type { TurnResult } from '#/agent/loop';
import type { PromptOrigin } from '#/agent/contextMemory';
import type { Hooks } from '#/hooks';

export type { TurnResult } from '#/agent/loop';

export interface Turn {
  readonly id: number;
  readonly abortController: AbortController;
  /**
   * Resolves on the first model response event for the first loop step, or at
   * step completion; rejects if the turn ends earlier.
   */
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface TurnEndedContext {
  readonly turn: Turn;
  readonly result: TurnResult;
}

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;
  launch(origin: PromptOrigin): Turn;
  getActiveTurn(): Turn | undefined;

  readonly hooks: Hooks<{
    onLaunched: { turn: Turn };
    onEnded: TurnEndedContext;
  }>;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
