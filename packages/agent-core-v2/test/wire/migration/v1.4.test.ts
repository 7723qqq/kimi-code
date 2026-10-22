import { describe, expect, it } from 'bun:test';

import { GoalClear, GoalCreate, GoalUpdate } from '#/features/goal/goalOps';
import { migrateV1_3ToV1_4 } from '#/wire/migration/migration';
import { runMigration } from './utils';
import { renderSnapshot } from '../../harness/snapshots';

describe('1.3 to 1.4', () => {
  it('rewrites legacy goal audit records to replayable goal state records', () => {
    expect(renderSnapshot(
      runMigration(migrateV1_3ToV1_4, [
        {
          type: 'metadata',
          protocol_version: '1.3',
          created_at: 1,
        },
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'ship the feature',
          completionCriterion: 'tests pass',
          status: 'active',
          actor: 'user',
          budgetLimits: {},
          time: 10,
        },
        {
          type: 'goal.account_usage',
          goalId: 'goal-1',
          usageKind: 'token',
          delta: 5,
          agentId: 'main',
          agentType: 'main',
          source: 'session',
          tokensUsed: 5,
          wallClockMs: 0,
          time: 20,
        },
        {
          type: 'goal.continuation',
          goalId: 'goal-1',
          turnsUsed: 1,
          time: 30,
        },
        {
          type: 'goal.update',
          goalId: 'goal-1',
          status: 'paused',
          actor: 'runtime',
          reason: 'Paused after session resume',
          turnsUsed: 1,
          tokensUsed: 5,
          wallClockMs: 0,
          time: 40,
        },
        {
          type: 'goal.clear',
          goalId: 'goal-1',
          actor: 'user',
          reason: 'Cancelled',
          time: 50,
        },
        {
          type: 'forked',
          time: 60,
        },
      ]),
    )).toMatchInlineSnapshot(`
      "[wire] metadata      { "protocol_version": "1.4", "created_at": "<time>" }
      [wire] goal.create   { "goalId": "goal-1", "objective": "ship the feature", "completionCriterion": "tests pass", "time": "<time>" }
      [wire] goal.update   { "goalId": "goal-1", "tokensUsed": 5, "wallClockMs": 0, "time": "<time>" }
      [wire] goal.update   { "goalId": "goal-1", "turnsUsed": 1, "time": "<time>" }
      [wire] goal.update   { "goalId": "goal-1", "status": "paused", "reason": "Paused after session resume", "turnsUsed": 1, "tokensUsed": 5, "wallClockMs": 0, "actor": "runtime", "time": "<time>" }
      [wire] goal.clear    { "goalId": "goal-1", "time": "<time>" }
      [wire] forked        { "time": "<time>" }"
    `);
  });

  it('every migrated goal record satisfies the Event2 schema that consumes it', () => {
    const legacy = [
      { type: 'goal.create', goalId: 'goal-1', objective: 'ship it', time: 1 },
      { type: 'goal.update', goalId: 'goal-1', status: 'active', time: 2 },
      { type: 'goal.account_usage', goalId: 'goal-1', tokensUsed: 5, time: 3 },
      { type: 'goal.continuation', goalId: 'goal-1', turnsUsed: 1, time: 4 },
      { type: 'goal.clear', goalId: 'goal-1', time: 5 },
    ];

    const schemas = {
      'goal.create': GoalCreate.schema,
      'goal.update': GoalUpdate.schema,
      'goal.clear': GoalClear.schema,
    } as const;

    for (const record of legacy) {
      const migrated = migrateV1_3ToV1_4.migrateRecord(record as never);
      expect(migrated['goalId'], `${record.type} must keep its goalId`).toBe('goal-1');
      const schema = schemas[migrated.type as keyof typeof schemas];
      const parsed = schema.safeParse({ ...migrated, agentId: 'agent-1' });
      expect(parsed.success, `${migrated.type} must satisfy its Event2 schema`).toBe(true);
    }
  });
});
