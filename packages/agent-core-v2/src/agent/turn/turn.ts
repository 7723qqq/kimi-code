import { createDecorator } from "#/_base/di";
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';
import type { Hooks } from '#/hooks';

export interface TurnResult {
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'filtered';
  readonly error?: unknown;
}

export interface Turn {
  readonly id: number;
  /** Id of the user message that triggered this turn, when launched from a prompt. */
  readonly promptMessageId?: string;
  readonly abortController: AbortController;
  readonly ready: Promise<void>;
  readonly result: Promise<TurnResult>;
}

export interface TurnRunContext {
  readonly turn: Turn;
  readonly origin: PromptOrigin;
  readonly promptMessage?: ContextMessage;
  result?: TurnResult;
}

export type TurnUserPromptDecision =
  | {
      readonly action: 'append';
      readonly event: string;
      readonly message: string;
      readonly text: string;
    }
  | {
      readonly action: 'block';
      readonly event: string;
      readonly message: string;
      readonly text: string;
    };

export interface TurnUserPromptSubmitContext {
  readonly turn: Turn;
  readonly promptMessage: ContextMessage;
  decision?: TurnUserPromptDecision;
}

export interface TurnEndedContext {
  readonly turn: Turn;
  readonly result: TurnResult;
}

export interface IAgentTurnService {
  readonly _serviceBrand: undefined;
  launch(origin: PromptOrigin, promptMessageId?: string): Turn;
  getActiveTurn(): Turn | undefined;
  /**
   * Reason the most recently finished turn ended with, or `undefined` when no
   * turn has ended yet (or after a new turn launches). Used by sessionActivity
   * to surface an `aborted` session status, mirroring v1's `_abortedTurns`.
   */
  lastEndedReason(): TurnResult['reason'] | undefined;

  readonly hooks: Hooks<{
    onLaunched: { turn: Turn };
    onWillSubmitUserPrompt: TurnUserPromptSubmitContext;
    onEnded: TurnEndedContext;
  }>;
}

export const IAgentTurnService = createDecorator<IAgentTurnService>('agentTurnService');
