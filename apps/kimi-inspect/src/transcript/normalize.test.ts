/**
 * Wire → model narrowing tests.
 *
 * The package schema admits the goal domain's two budget statuses
 * (`budget_limited` / `usage_limited`); the transcript model does not. Parsed
 * values must be projected exactly the way kap-server projects them before
 * they reach model-typed structures: both statuses fold into `paused`.
 */

import { transcriptMetaSchema, transcriptOperationSchema } from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import { toModelMeta, toModelOperation } from './normalize';

describe('transcript wire → model narrowing', () => {
  it('projects the goal budget statuses onto `paused`', () => {
    for (const status of ['budget_limited', 'usage_limited'] as const) {
      const wire = transcriptMetaSchema.parse({
        goal: { objective: 'ship it', status, budgetUsed: 3, budgetLimit: 5 },
      });
      expect(toModelMeta(wire)).toEqual({
        goal: { objective: 'ship it', status: 'paused', budgetUsed: 3, budgetLimit: 5 },
      });
    }
  });

  it('passes model statuses through and keeps an absent goal absent', () => {
    expect(
      toModelMeta(transcriptMetaSchema.parse({ goal: { objective: 'go', status: 'active' } })),
    ).toEqual({ goal: { objective: 'go', status: 'active' } });
    expect(toModelMeta(transcriptMetaSchema.parse({ activity: 'idle' }))).toEqual({
      activity: 'idle',
    });
  });

  it('narrows reset snapshots, meta.merge goals (null clears) and plain ops', () => {
    const reset = transcriptOperationSchema.parse({
      op: 'reset',
      agentId: 'main',
      snapshot: {
        items: [],
        tasks: [],
        meta: { goal: { objective: 'go', status: 'usage_limited' } },
      },
    });
    const narrowedReset = toModelOperation(reset);
    expect(narrowedReset).toMatchObject({
      op: 'reset',
      snapshot: { meta: { goal: { objective: 'go', status: 'paused' } } },
    });

    const merge = transcriptOperationSchema.parse({
      op: 'meta.merge',
      meta: { goal: { objective: 'go', status: 'budget_limited' } },
    });
    expect(toModelOperation(merge)).toEqual({
      op: 'meta.merge',
      meta: { goal: { objective: 'go', status: 'paused' } },
    });
    expect(
      toModelOperation(transcriptOperationSchema.parse({ op: 'meta.merge', meta: { goal: null } })),
    ).toEqual({ op: 'meta.merge', meta: { goal: null } });

    const append = transcriptOperationSchema.parse({
      op: 'append',
      target: { type: 'task', taskId: 'task-1' },
      offset: 0,
      text: 'hi',
    });
    expect(toModelOperation(append)).toBe(append);
  });
});
