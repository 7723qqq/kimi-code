import { createDecorator } from "#/_base/di";
import type {
  CreateGoalInput,
  GoalActor,
  GoalSnapshot,
  GoalToolResult,
} from './types';

export interface GoalReasonInput {
  readonly reason?: string;
}

export interface IGoalService {
  readonly _serviceBrand: undefined;
  getGoal(): GoalToolResult;
  createGoal(input: CreateGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  resumeGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  cancelGoal(actor?: GoalActor): Promise<GoalSnapshot>;
}

export const IGoalService = createDecorator<IGoalService>('agentGoalService');
