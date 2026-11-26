import { describe, expect, it } from 'bun:test';

import type { WireRecord } from '@moonshot-ai/agent-core-v2';

import {
  applyConversationRecord,
  createConversationState,
  undoConversationTurns,
} from '../../src/services/conversation/conversationFold';

function record(type: string, payload: Record<string, unknown>, time: number): WireRecord {
  return { type, agentId: 'main', ...payload, time };
}

function records() {
  return [
    record('turn.prompt', { turnId: 7, promptId: 'p1', origin: { kind: 'user' }, input: [] }, 1000),
    record(
      'context.append_message',
      {
        message: {
          id: 'p1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
      1001,
    ),
    record(
      'context.append_loop_event',
      { event: { type: 'step.begin', uuid: 's1', turnId: '7', step: 1 } },
      2000,
    ),
    record(
      'context.append_loop_event',
      {
        event: {
          type: 'content.part',
          stepUuid: 's1',
          turnId: '7',
          step: 1,
          block: 0,
          part: { type: 'text', text: 'answer' },
        },
      },
      2500,
    ),
    record(
      'context.append_loop_event',
      {
        event: {
          type: 'tool.call',
          stepUuid: 's1',
          turnId: '7',
          step: 1,
          toolCallId: 'c1',
          name: 'Bash',
          args: { command: 'bun test' },
        },
      },
      2600,
    ),
  ];
}

function fold(entries: readonly WireRecord[]) {
  const state = createConversationState('main');
  for (const entry of entries) applyConversationRecord(state, entry);
  return state;
}

describe('official conversation record contract', () => {
  it('keeps actual turn numbers, timestamps and step-keyed items', () => {
    const state = fold(records());
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      turn_number: 7,
      started_at: new Date(1001).toISOString(),
      status: 'running',
    });
    expect(state.steps[state.turns[0]!.turn_id]).toEqual([
      { id: 's1', index: 1, startedAt: 2000, ended: false },
    ]);
    expect(state.turns[0]!.items).toContainEqual(
      expect.objectContaining({ item_id: 's1:0', step_index: 1, text: 'answer' }),
    );
  });

  it('retains visible history across compaction and restores stable ids', () => {
    const history = [...records(), record('turn.ended', { turnId: 7, reason: 'completed' }, 3000)];
    const initial = fold(history);
    const state = fold([
      ...history,
      record(
        'context.apply_compaction',
        { summary: 'summary', compactedCount: 2, tokensBefore: 1000, tokensAfter: 100 },
        4000,
      ),
    ]);
    expect(state.turns[0]).toEqual(initial.turns[0]);
    expect(state.turns.at(-1)?.items.at(-1)).toMatchObject({
      type: 'system',
      kind: 'compaction',
      summary: 'summary',
    });
    expect(undoConversationTurns(state, 1).turns).toEqual([]);
  });

  it('clears the recorded retry state when the next attempt starts', () => {
    const state = fold(records());
    applyConversationRecord(
      state,
      record(
        'turn.step.retrying',
        {
          turnId: 7,
          step: 1,
          stepId: 'retry-alias',
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 500,
          errorName: 'APIStatusError',
          errorMessage: 'rate limited',
          statusCode: 429,
        },
        2700,
      ),
    );

    expect(state.turns[0]?.retry).toEqual({
      attempt: 1,
      next_attempt: 2,
      max_attempts: 3,
      delay_ms: 500,
      error: { name: 'APIStatusError', message: 'rate limited', status_code: 429 },
    });
    expect(state.turns[0]?.items).toContainEqual(
      expect.objectContaining({ item_id: 's1:attempt1:0', text: 'answer' }),
    );
    expect(state.turns[0]?.items.some((item) => item.item_id === 's1:0')).toBe(false);

    applyConversationRecord(
      state,
      record('turn.step.started', { turnId: 7, step: 1, stepId: 's1' }, 2800),
    );

    expect(state.turns[0]?.retry).toBeUndefined();
    expect(state.turns[0]?.status).toBe('running');

    applyConversationRecord(
      state,
      record(
        'context.append_loop_event',
        { event: { type: 'step.end', uuid: 's1', finishReason: 'end_turn' } },
        2900,
      ),
    );
    expect(state.turns[0]?.items.some((item) => item.item_id.startsWith('s1:attempt'))).toBe(false);
  });

  it('ignores malformed task records without changing the tool', () => {
    const state = fold(records());
    const before = structuredClone(state);
    for (const info of [
      null,
      {},
      { taskId: 123, parentToolCallId: 'c1' },
      { taskId: 'x', parentToolCallId: '' },
    ]) {
      applyConversationRecord(state, record('task.started', { info }, state.clock));
    }
    expect(state).toEqual(before);
  });

  it('preserves recorded subagent references through tool sealing and removes them on clear', () => {
    const state = fold([
      ...records(),
      record(
        'subagent.spawned',
        { parentToolCallId: 'c1', subagentId: 'child-1', taskId: 'agent-1' },
        2700,
      ),
      record(
        'subagent.spawned',
        { parentToolCallId: 'c1', subagentId: 'member-1', swarmIndex: 0, taskId: 'swarm-1' },
        2701,
      ),
      record(
        'subagent.spawned',
        { parentToolCallId: 'c1', subagentId: 'child-1', taskId: 'agent-1' },
        2702,
      ),
      record(
        'context.append_loop_event',
        {
          event: {
            type: 'tool.result',
            toolCallId: 'c1',
            result: { output: 'not an agent id', note: 'recorded note' },
          },
        },
        2800,
      ),
      record('turn.ended', { turnId: 7, reason: 'completed' }, 3000),
    ]);
    expect(state.turns[0]!.items.at(-1)).toMatchObject({
      item_id: 'c1',
      output: 'not an agent id',
      note: 'recorded note',
      agent_refs: [
        { agent_id: 'member-1', role: 'member', swarm_index: 0, task_id: 'swarm-1' },
        { agent_id: 'child-1', role: 'child', task_id: 'agent-1' },
      ],
    });
    applyConversationRecord(state, record('context.clear', {}, 4000));
    expect(state.turns).toEqual([]);
    expect(state.tools).toEqual({});
    expect(state.steps).toEqual({});
    expect(state.interactions).toEqual({});
    for (const entry of records()) applyConversationRecord(state, entry);
    expect(state.turns[0]!.ordinal).toBe(0);
    expect(state.turns[0]!.items.at(-1)).not.toHaveProperty('agent_refs', expect.anything());
  });

  it('keeps fork inheritance out of the child conversation until its recorded prompt', () => {
    const state = createConversationState('child', { source: 'btw', forkedFrom: 'main' });
    applyConversationRecord(
      state,
      record(
        'context.append_message',
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'inherited' }],
            toolCalls: [],
          },
        },
        500,
      ),
    );
    for (const entry of records()) applyConversationRecord(state, entry);
    expect(state.turns[0]!.items[0]).toMatchObject({
      kind: 'fork_boundary',
      source: 'btw',
      forked_from: { agent_id: 'main' },
    });
    expect(state.turns).toHaveLength(2);
    expect(state.turns[1]).toMatchObject({ turn_number: 7 });
    expect(JSON.stringify(state.turns)).not.toContain('inherited');
  });

  it('links an approval and a background task to the same tool', () => {
    const state = fold([
      ...records(),
      record(
        'interaction.request',
        {
          id: 'approve-1',
          kind: 'approval',
          toolCallId: 'c1',
          request: { toolName: 'Bash', turnId: 7 },
        },
        2700,
      ),
      record('task.started', { info: { taskId: 'bash-1', parentToolCallId: 'c1' } }, 2800),
    ]);
    expect(state.turns[0]!.items.at(-1)).toMatchObject({
      item_id: 'c1',
      interaction_id: 'approve-1',
      stage: 'awaiting_approval',
      task_id: 'bash-1',
    });
    applyConversationRecord(
      state,
      record('interaction.resolved', { id: 'approve-1', response: { decision: 'approved' } }, 2900),
    );
    expect(state.turns[0]!.items.at(-1)).toMatchObject({ item_id: 'c1', stage: 'executing' });
  });
});
