import { describe, expect, it } from 'vitest';

import { toTurnEngineGoalContext } from '#/features/goal/goalAgentRuntime';
import type { GoalBudgetReport, GoalSnapshot, GoalStatus } from '#/features/goal/types';

function budget(overrides: Partial<GoalBudgetReport> = {}): GoalBudgetReport {
  return {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
    inputTokensUsed: 0,
    outputTokensUsed: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: 'goal-1',
    objective: 'Write the tests',
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    inputTokensUsed: 0,
    outputTokensUsed: 0,
    wallClockMs: 0,
    budget: budget(),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('toTurnEngineGoalContext', () => {
  it('projects the snapshot onto the engine wire shape', () => {
    const wire = toTurnEngineGoalContext(
      snapshot({
        status: 'budget_limited',
        turnsUsed: 9,
        tokensUsed: 4900,
        wallClockMs: 120000,
        budget: budget({
          tokenBudget: 5000,
          turnBudget: 20,
          wallClockBudgetMs: 300000,
          remainingTokens: 0,
        }),
      }),
    );

    expect(wire).toEqual({
      goalId: 'goal-1',
      objective: 'Write the tests',
      status: 'budgetLimited',
      tokenBudget: 5000,
      turnBudget: 20,
      wallClockBudgetMs: 300000,
      wallClockMs: 120000,
      tokensUsed: 4900,
      turnsUsed: 9,
    });
  });

  it('maps usage_limited and keeps plain statuses as-is', () => {
    const statuses: Array<[GoalStatus, string]> = [
      ['active', 'active'],
      ['paused', 'paused'],
      ['blocked', 'blocked'],
      ['complete', 'complete'],
      ['usage_limited', 'usageLimited'],
    ];
    for (const [status, expected] of statuses) {
      expect(toTurnEngineGoalContext(snapshot({ status })).status).toBe(expected);
    }
  });

  it('maps null budgets to undefined', () => {
    const wire = toTurnEngineGoalContext(snapshot());
    expect(wire.tokenBudget).toBeUndefined();
    expect(wire.turnBudget).toBeUndefined();
    expect(wire.wallClockBudgetMs).toBeUndefined();
  });
});
