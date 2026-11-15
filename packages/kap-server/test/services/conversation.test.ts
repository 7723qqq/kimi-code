import { describe, expect, it } from 'bun:test';

import { applyMessage, createConversationState } from '../../src/services/conversation/conversationFold';

describe('conversation fold reasoning timing', () => {
  it('takes the duration a context message carries for its reasoning part', () => {
    const state = createConversationState('main');
    applyMessage(state, { role: 'user', content: [{ type: 'text', text: 'think' }], toolCalls: [], id: 'p1', origin: { kind: 'user' } }, 1_000);
    applyMessage(
      state,
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'plan' }, { type: 'text', text: 'answer' }],
        toolCalls: [],
        contentTimings: [{ startedAt: 4_000, durationMs: 2_500 }],
      },
      2_000,
    );

    const items = state.turns.flatMap((turn) => turn.items);
    const reasoning = items.find((item) => item.type === 'reasoning');
    expect(reasoning).toMatchObject({ text: 'plan', duration_ms: 2_500, started_at: new Date(4_000).toISOString() });
    const message = items.find((item) => item.type === 'assistant_message');
    expect(message).not.toHaveProperty('duration_ms', expect.anything());
  });
});

describe('conversation fold tool notes', () => {
  it('keeps the note of a tool result beside its output', () => {
    const note =
      'Read image file. Mime type: image/png. Size: 1234 bytes. Original dimensions: 640x480 pixels.';
    const state = createConversationState('main');
    applyMessage(
      state,
      { role: 'user', content: [{ type: 'text', text: 'look' }], toolCalls: [], id: 'p1', origin: { kind: 'user' } },
      1_000,
    );
    applyMessage(
      state,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        toolCalls: [{ type: 'function', id: 'ReadMediaFile_0', name: 'ReadMediaFile', arguments: '{}' }],
      },
      2_000,
    );
    applyMessage(
      state,
      {
        role: 'tool',
        content: [{ type: 'text', text: '<image path="/tmp/a.png"></image>' }],
        toolCalls: [],
        toolCallId: 'ReadMediaFile_0',
        note,
      },
      3_000,
    );

    const item = state.turns
      .flatMap((turn) => turn.items)
      .find((candidate) => candidate.type === 'tool_call' && candidate.item_id === 'ReadMediaFile_0');
    expect(item).toMatchObject({
      outcome: 'completed',
      output: '<image path="/tmp/a.png"></image>',
      note,
    });
  });
});

describe('conversation fold cron prompts', () => {
  it('shows only the scheduled prompt from a cron-fire envelope', () => {
    const state = createConversationState('main');
    applyMessage(
      state,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<cron-fire jobId="job-1" cron="0 3 * * *" recurring="true" coalescedCount="2" stale="false">\n<prompt>\nnightly report\n</prompt>\n</cron-fire>',
          },
        ],
        toolCalls: [],
        id: 'cron-1',
        origin: {
          kind: 'cron_job',
          jobId: 'job-1',
          cron: '0 3 * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
      },
      1_000,
    );

    const item = state.turns
      .flatMap((turn) => turn.items)
      .find((candidate) => candidate.type === 'user_message');
    expect(item).toMatchObject({
      text: 'nightly report',
      origin: {
        kind: 'cron',
        job_id: 'job-1',
        schedule: '0 3 * * *',
        recurring: true,
        coalesced_count: 2,
        stale: false,
      },
    });
  });

  it('unwraps only a complete cron-fire envelope', () => {
    const state = createConversationState('main');
    applyMessage(
      state,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<cron-fire jobId="job-3" cron="0 * * * *" recurring="true" coalescedCount="1" stale="false">\n<prompt>\nSummarize:\n<prompt>\ninner\n</prompt>\n</prompt>\n</cron-fire>',
          },
        ],
        toolCalls: [],
        id: 'cron-nested',
        origin: {
          kind: 'cron_job',
          jobId: 'job-3',
          cron: '0 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      1_000,
    );
    applyMessage(
      state,
      {
        role: 'user',
        content: [{ type: 'text', text: '<cron-fire jobId="job-4" cron="0 * * * *">\n<prompt>\nunclosed' }],
        toolCalls: [],
        id: 'cron-malformed',
        origin: {
          kind: 'cron_job',
          jobId: 'job-4',
          cron: '0 * * * *',
          recurring: true,
          coalescedCount: 1,
          stale: false,
        },
      },
      2_000,
    );

    const items = state.turns.flatMap((turn) => turn.items);
    const nested = items.find((candidate) => candidate.type === 'user_message' && candidate.item_id === 'cron-nested');
    expect(nested).toMatchObject({ text: 'Summarize:\n<prompt>\ninner\n</prompt>' });
    const malformed = items.find((candidate) => candidate.type === 'user_message' && candidate.item_id === 'cron-malformed');
    expect(malformed).toMatchObject({ text: '<cron-fire jobId="job-4" cron="0 * * * *">\n<prompt>\nunclosed' });
  });
});
