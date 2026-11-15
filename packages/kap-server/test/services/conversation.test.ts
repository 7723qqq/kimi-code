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
