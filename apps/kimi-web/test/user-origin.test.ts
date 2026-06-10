// apps/kimi-web/test/user-origin.test.ts
//
// TUI parity (isReplayUserTurnRecord): user-role messages are only displayed
// when they are real user input — origin absent/'user', or a user-typed slash
// command. System-injected user messages (compaction summaries, hook results,
// background-task notifications, cron, retries…) must stay hidden.

import { describe, expect, it } from 'vitest';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { AppMessage } from '../src/api/types';

let n = 0;
function userMsg(text: string, origin?: Record<string, unknown>): AppMessage {
  n += 1;
  return {
    id: `m_${n}`,
    sessionId: 'sess_1',
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: new Date(1700000000000 + n * 1000).toISOString(),
    ...(origin !== undefined ? { metadata: { origin } } : {}),
  } as AppMessage;
}

function shownTexts(messages: AppMessage[]): string[] {
  return messagesToTurns(messages, [])
    .filter((t) => t.role === 'user')
    .map((t) => t.text);
}

describe('user message origin filtering (TUI parity)', () => {
  it('shows plain user input (no origin / origin user)', () => {
    expect(shownTexts([userMsg('hi'), userMsg('there', { kind: 'user' })])).toEqual(['hi', 'there']);
  });

  it('shows user-typed slash commands, hides model/nested skill activations', () => {
    expect(
      shownTexts([
        userMsg('/compact', { kind: 'skill_activation', trigger: 'user-slash' }),
        userMsg('skill body', { kind: 'skill_activation', trigger: 'model-tool' }),
        userMsg('nested', { kind: 'skill_activation', trigger: 'nested-skill' }),
      ]),
    ).toEqual(['/compact']);
  });

  it.each([
    ['compaction_summary'],
    ['injection'],
    ['system_trigger'],
    ['background_task'],
    ['cron_job'],
    ['cron_missed'],
    ['hook_result'],
    ['retry'],
  ])('hides origin kind %s', (kind) => {
    expect(shownTexts([userMsg('visible'), userMsg('hidden', { kind })])).toEqual(['visible']);
  });
});
