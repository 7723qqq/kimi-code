import { createDecorator } from '../../../di';
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '../../../agent/goal';

export interface GoalReasonInput {
  readonly reason?: string;
}

export interface IGoalService {
  readonly _serviceBrand: undefined;
  readonly enabled: boolean;
  getGoal(): GoalToolResult;
  getActiveGoal(): GoalSnapshot | null;
  createGoal(input: CreateGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseActiveGoal(
    input?: GoalReasonInput,
    actor?: GoalActor,
  ): Promise<GoalSnapshot | null>;
  resumeGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor?: GoalActor,
  ): Promise<GoalSnapshot>;
  cancelGoal(actor?: GoalActor): Promise<GoalSnapshot>;
  markBlocked(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
  markComplete(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
  pauseOnInterrupt(input?: GoalReasonInput): Promise<GoalSnapshot | null>;
  recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null>;
  incrementTurn(): Promise<GoalSnapshot | null>;
}

declare module '../types' {
  interface WireRecordMap {
    'goal.create': {
      goalId: string;
      objective: string;
      completionCriterion?: string;
    };
    'goal.update': {
      status?: GoalStatus;
      reason?: string;
      turnsUsed?: number;
      tokensUsed?: number;
      wallClockMs?: number;
      budgetLimits?: GoalBudgetLimits;
      actor?: GoalActor;
    };
    'goal.clear': {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IGoalService = createDecorator<IGoalService>('agentGoalService');
