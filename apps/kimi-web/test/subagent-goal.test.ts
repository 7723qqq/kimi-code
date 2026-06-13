import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import { toAppEvent } from '../src/api/daemon/mappers';

describe('subagent and goal projection', () => {
  it('tracks subagent lifecycle metadata across partial events', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';

    const spawned = projector.project('subagent.spawned', {
      subagentId: 'agent_1',
      subagentName: 'coder',
      parentToolCallId: 'tc_agent',
      description: 'Review API timeout',
      swarmIndex: 2,
    }, sid);
    expect(spawned).toEqual([
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({
          id: 'agent_1',
          description: 'Review API timeout',
          subagentPhase: 'queued',
          subagentType: 'coder',
          parentToolCallId: 'tc_agent',
          swarmIndex: 2,
        }),
      }),
    ]);

    const started = projector.project('subagent.started', { subagentId: 'agent_1' }, sid);
    expect(started[0]).toEqual(expect.objectContaining({
      type: 'taskCreated',
      task: expect.objectContaining({
        id: 'agent_1',
        description: 'Review API timeout',
        subagentPhase: 'working',
        parentToolCallId: 'tc_agent',
      }),
    }));

    const suspended = projector.project('subagent.suspended', { subagentId: 'agent_1', reason: 'rate limit' }, sid);
    expect(suspended[0]).toEqual(expect.objectContaining({
      type: 'taskCreated',
      task: expect.objectContaining({
        subagentPhase: 'suspended',
        suspendedReason: 'rate limit',
      }),
    }));

    const completed = projector.project('subagent.completed', { subagentId: 'agent_1', resultSummary: 'ok' }, sid);
    expect(completed).toEqual([
      expect.objectContaining({
        type: 'taskCreated',
        task: expect.objectContaining({
          subagentPhase: 'completed',
          status: 'completed',
          outputPreview: 'ok',
        }),
      }),
      expect.objectContaining({
        type: 'taskCompleted',
        taskId: 'agent_1',
        status: 'completed',
        outputPreview: 'ok',
      }),
    ]);
  });

  it('stores active goals and clears complete/null goals in the reducer', () => {
    const projector = createAgentProjector();
    const sid = 'ses_1';
    const [active] = projector.project('goal.updated', {
      snapshot: {
        goalId: 'goal_1',
        objective: 'Ship P3',
        completionCriterion: 'All checks pass',
        status: 'active',
        turnsUsed: 3,
        tokensUsed: 1200,
        wallClockMs: 90_000,
        budget: {
          tokenBudget: 10_000,
          remainingTokens: 8_800,
          turnBudget: 10,
          remainingTurns: 7,
          wallClockBudgetMs: null,
          remainingWallClockMs: null,
          overBudget: false,
        },
      },
    }, sid);

    let state = reduceAppEvent(createInitialState(), active!, { sessionId: sid, seq: 1 });
    expect(state.goalBySession[sid]).toEqual(expect.objectContaining({
      goalId: 'goal_1',
      objective: 'Ship P3',
      status: 'active',
      turnsUsed: 3,
    }));

    const [complete] = projector.project('goal.updated', {
      snapshot: {
        goalId: 'goal_1',
        objective: 'Ship P3',
        status: 'complete',
        turnsUsed: 4,
        tokensUsed: 1600,
        wallClockMs: 100_000,
        budget: { tokenBudget: null, remainingTokens: null, turnBudget: null, remainingTurns: null, wallClockBudgetMs: null, remainingWallClockMs: null, overBudget: false },
      },
    }, sid);
    state = reduceAppEvent(state, complete!, { sessionId: sid, seq: 2 });
    expect(state.goalBySession[sid]).toBeUndefined();

    const [cleared] = projector.project('goal.updated', { snapshot: null }, sid);
    state = reduceAppEvent(state, cleared!, { sessionId: sid, seq: 3 });
    expect(state.goalBySession[sid]).toBeUndefined();
  });

  it('maps projected goal events from the daemon wire protocol', () => {
    const event = toAppEvent({
      type: 'event.goal.updated',
      seq: 1,
      session_id: 'ses_1',
      timestamp: '2026-06-13T00:00:00.000Z',
      payload: {
        snapshot: {
          goal_id: 'goal_1',
          objective: 'Ship P3',
          completion_criterion: 'All checks pass',
          status: 'active',
          turns_used: 3,
          tokens_used: 1200,
          wall_clock_ms: 90_000,
          budget: {
            token_budget: 10_000,
            remaining_tokens: 8_800,
            turn_budget: 10,
            remaining_turns: 7,
            over_budget: false,
          },
        },
      },
    } as never);

    expect(event).toEqual(expect.objectContaining({
      type: 'goalUpdated',
      sessionId: 'ses_1',
      goal: expect.objectContaining({
        goalId: 'goal_1',
        objective: 'Ship P3',
        completionCriterion: 'All checks pass',
        status: 'active',
        turnsUsed: 3,
      }),
    }));
  });
});
