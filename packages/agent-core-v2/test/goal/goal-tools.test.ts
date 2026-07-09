import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IAgentGoalService } from '#/agent/goal/goal';
import { SetGoalBudgetTool } from '#/agent/goal/tools/set-goal-budget';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentTurnService } from '#/agent/turn/turn';
import { IEventBus } from '#/app/event/eventBus';

import { agentService, createTestAgent, type TestAgentContext } from '../harness';
import { stubLoopWithHooks, stubTurn } from '../turn/stubs';

const signal = new AbortController().signal;

describe('goal tools', () => {
  let ctx: TestAgentContext;
  let goals: IAgentGoalService;
  let loopService: IAgentLoopService;
  let eventBus: IEventBus;
  let tool: SetGoalBudgetTool;

  beforeEach(() => {
    loopService = stubLoopWithHooks();
    ctx = createTestAgent(
      agentService(IAgentTurnService, stubTurn({ hasActiveTurn: true })),
      agentService(IAgentLoopService, loopService),
    );
    goals = ctx.get(IAgentGoalService);
    eventBus = ctx.get(IEventBus);
    tool = new SetGoalBudgetTool(goals);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('SetGoalBudget reports no current goal without failing', async () => {
    const execution = tool.resolveExecution({ value: 20, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.isError).toBeFalsy();
    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget not set: no current goal.');
  });

  it('SetGoalBudget returns stop signals when the requested limit is already exhausted', async () => {
    await goals.createGoal({ objective: 'work' });
    await countGoalTurn(1);

    const execution = tool.resolveExecution({ value: 1, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBe(true);
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.stopTurn).toBe(true);
    expect(result.output).toContain('will stop now');
    expect(goals.getGoal().goal).toMatchObject({
      status: 'blocked',
      budget: { overBudget: true },
    });
  });

  it('SetGoalBudget leaves the turn running when the requested limit has room', async () => {
    await goals.createGoal({ objective: 'work' });
    await countGoalTurn(2);

    const execution = tool.resolveExecution({ value: 5, unit: 'turns' });
    if (execution.isError === true) throw new Error('execution should not be an error');

    expect(execution.stopBatchAfterThis).toBeFalsy();
    const result = await execution.execute({ turnId: 0, toolCallId: 'call_1', signal });

    expect(result.stopTurn).toBeFalsy();
    expect(result.output).toBe('Goal budget set: 5 turns.');
    expect(goals.getGoal().goal).toMatchObject({
      status: 'active',
      budget: { turnBudget: 5, overBudget: false },
    });
  });

  async function countGoalTurn(turnId: number): Promise<void> {
    const abortController = new AbortController();
    eventBus.publish({ type: 'turn.started', turnId, origin: USER_PROMPT_ORIGIN });
    await loopService.hooks.beforeStep.run({
      turnId,
      step: 1,
      signal: abortController.signal,
    });
  }
});
