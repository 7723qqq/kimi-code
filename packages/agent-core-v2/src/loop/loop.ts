import { createDecorator } from "#/_base/di";
import type { HookSlot } from '#/hooks';
import type { Turn, TurnContextOverflowContext, TurnResult, TurnStepContext } from '#/turn';

export interface LoopRunHooks {
  readonly beforeStep: HookSlot<TurnStepContext>;
  readonly afterStep: HookSlot<TurnStepContext>;
  readonly onContextOverflow: HookSlot<TurnContextOverflowContext>;
}

export interface ILoopService {
  runTurn(turn: Turn, hooks?: LoopRunHooks): Promise<TurnResult>;
}

export const ILoopService = createDecorator<ILoopService>('agentLoopService');
