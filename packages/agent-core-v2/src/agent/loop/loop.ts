import { createDecorator } from "#/_base/di";
import type { Hooks } from '#/hooks';
import type {
  Turn,
  TurnContextOverflowContext,
  TurnResult,
  TurnStepContext,
  TurnStepUsageContext,
} from '#/agent/turn';

export interface IAgentLoopService {
  readonly _serviceBrand: undefined;
  readonly hooks: Hooks<{
    beforeStep: TurnStepContext;
    onStepUsage: TurnStepUsageContext;
    afterStep: TurnStepContext;
    onContextOverflow: TurnContextOverflowContext;
  }>;
  runTurn(turn: Turn): Promise<TurnResult>;
}

export const IAgentLoopService = createDecorator<IAgentLoopService>('agentLoopService');
