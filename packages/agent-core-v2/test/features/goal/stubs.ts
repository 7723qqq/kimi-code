import type { IAgentGoalJudgeService, JudgeVerdict } from '#/agent/goal/judge/goalJudgeService';
import type { IAgentGoalService } from '#/features/goal/goalService';
import type { GoalStatus } from '#/features/goal/types';
import type { IAgentSwarmService } from '#/features/swarm/agent/swarm';

export function stubGoalJudge(verdict: JudgeVerdict = { ok: true, reason: '' }): IAgentGoalJudgeService {
  return {
    _serviceBrand: undefined,
    evaluate: () => Promise.resolve(verdict),
  };
}

export function stubAgentSwarm(): IAgentSwarmService {
  return {
    _serviceBrand: undefined,
    isActive: false,
    enter: () => undefined,
    exit: () => undefined,
  };
}

export function stubGoal(status?: GoalStatus): IAgentGoalService {
  return {
    getGoal: () => ({ goal: status === undefined ? null : { status } }),
  } as unknown as IAgentGoalService;
}
