// apps/kimi-web/test/compaction.test.ts
//
// Compaction events stream through the REAL pipeline — projector → reducer —
// and surface as per-session compaction status (running banner → done note),
// plus the historyCompacted reload signal on completion.

import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { createInitialState, reduceAppEvent, type KimiClientState } from '../src/api/daemon/eventReducer';
import type { AppEvent } from '../src/api/types';

const SESSION = 'sess_1';

function play(events: [string, unknown][]): { state: KimiClientState; appEvents: AppEvent[] } {
  const projector = createAgentProjector();
  let state = createInitialState();
  const appEvents: AppEvent[] = [];
  let seq = 0;
  for (const [type, payload] of events) {
    for (const appEvent of projector.project(type, payload, SESSION)) {
      appEvents.push(appEvent);
      state = reduceAppEvent(state, appEvent, { sessionId: SESSION, seq: ++seq });
    }
  }
  return { state, appEvents };
}

describe('compaction pipeline', () => {
  it('compaction.started marks the session as compacting', () => {
    const { state } = play([
      ['compaction.started', { trigger: 'manual', instruction: 'keep recent work' }],
    ]);
    expect(state.compactionBySession[SESSION]).toEqual({
      status: 'running',
      trigger: 'manual',
    });
  });

  it('compaction.completed flips to a done note with token counts and signals a reload', () => {
    const { state, appEvents } = play([
      ['compaction.started', { trigger: 'auto' }],
      ['compaction.completed', { result: { summary: 's', compactedCount: 12, tokensBefore: 90000, tokensAfter: 12000 } }],
    ]);

    expect(state.compactionBySession[SESSION]).toEqual({
      status: 'completed',
      trigger: 'auto',
      tokensBefore: 90000,
      tokensAfter: 12000,
    });
    // The reload signal must still fire (client routes it to onResync).
    expect(appEvents.some((e) => e.type === 'historyCompacted')).toBe(true);
  });

  it('compaction.cancelled clears the compacting state', () => {
    const { state } = play([
      ['compaction.started', { trigger: 'manual' }],
      ['compaction.cancelled', {}],
    ]);
    expect(state.compactionBySession[SESSION]).toBeUndefined();
  });

  it('a completed event without a prior started still produces a done note', () => {
    const { state } = play([
      ['compaction.completed', { result: { summary: 's', compactedCount: 3, tokensBefore: 50000, tokensAfter: 8000 } }],
    ]);
    expect(state.compactionBySession[SESSION]).toMatchObject({
      status: 'completed',
      tokensBefore: 50000,
      tokensAfter: 8000,
    });
  });
});
