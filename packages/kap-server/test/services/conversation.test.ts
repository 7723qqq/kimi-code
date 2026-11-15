import { describe, expect, it } from 'bun:test';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';

import type { ConversationTurn } from '../../src/protocol/conversation';
import { applyConversationRecord, createConversationState, type ConversationState } from '../../src/services/conversation/conversationFold';

let clock = 1_000;

function record(type: string, payload: Record<string, unknown>): WireRecord {
  return { type, agentId: 'main', ...payload, time: clock++ };
}

const turnPrompt = (turnId: number | undefined, promptId: string | undefined): WireRecord =>
  record('turn.prompt', { turnId, promptId, origin: { kind: 'user' }, input: [] });

const userMessage = (id: string | undefined, text: string): WireRecord =>
  record('context.append_message', {
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], id, origin: { kind: 'user' } },
  });

const loop = (event: Record<string, unknown>): WireRecord => record('context.append_loop_event', { event });

const stepBegin = (turnId: number, step: number, uuid: string): WireRecord =>
  loop({ type: 'step.begin', uuid, turnId: String(turnId), step });

const contentPart = (
  turnId: number,
  step: number,
  stepUuid: string,
  part: Record<string, unknown>,
  block: number,
  timing: { startedAt?: number; durationMs?: number } = {},
): WireRecord => loop({ type: 'content.part', turnId: String(turnId), step, stepUuid, part, block, ...timing });

const toolCall = (turnId: number, step: number, stepUuid: string, toolCallId: string, name: string, args?: unknown): WireRecord =>
  loop({ type: 'tool.call', turnId: String(turnId), step, stepUuid, toolCallId, name, args });

const toolResult = (toolCallId: string, output: unknown, isError?: boolean): WireRecord =>
  loop({ type: 'tool.result', toolCallId, result: { output, isError, durationMs: 5 } });

const turnEnded = (turnId: number, reason: string, extra: Record<string, unknown> = {}): WireRecord =>
  record('turn.ended', { turnId, reason, ...extra });

function fold(records: readonly WireRecord[]): ConversationState {
  const state = createConversationState('main');
  for (const entry of records) applyConversationRecord(state, entry);
  return state;
}

function toolItem(turn: ConversationTurn | undefined, itemId: string) {
  const item = (turn?.items ?? []).find((candidate) => candidate.item_id === itemId);
  if (item?.type !== 'tool_call') throw new Error(`no tool call ${itemId}`);
  return item;
}

describe('conversation fold tool outcomes', () => {
  it('ends the tool calls a stop cuts short as interrupted and keeps earlier results as they were', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run them'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Read_0', 'Read', { path: 'a.ts' }),
      toolCall(0, 1, 's1', 'Read_1', 'Read', { path: 'missing.ts' }),
      toolCall(0, 1, 's1', 'Bash_2', 'Bash', { command: 'sleep 60' }),
      toolCall(0, 1, 's1', 'Bash_3', 'Bash', { command: 'make' }),
      toolResult('Read_0', 'file body'),
      toolResult('Read_1', 'file not found', true),
      record('turn.cancel', { turnId: 0, target: 'active', reason: 'user' }),
      toolResult('Bash_2', 'Interrupted by user', true),
      toolResult('Bash_3', 'The user manually interrupted "Bash".', true),
      turnEnded(0, 'cancelled'),
    ]);

    const [turn] = state.turns;
    expect(turn).toMatchObject({ outcome: 'interrupted' });
    expect(toolItem(turn, 'Read_0')).toMatchObject({ outcome: 'completed', output: 'file body' });
    const failed = toolItem(turn, 'Read_1');
    expect(failed).toMatchObject({ outcome: 'failed', error: 'file not found' });
    expect(failed).not.toHaveProperty('output', expect.anything());
    const interrupted = toolItem(turn, 'Bash_2');
    expect(interrupted).toMatchObject({ outcome: 'interrupted', error: 'Interrupted by user' });
    expect(interrupted).not.toHaveProperty('output', expect.anything());
    const unfinished = toolItem(turn, 'Bash_3');
    expect(unfinished).toMatchObject({ outcome: 'interrupted' });
    expect(unfinished).not.toHaveProperty('output', expect.anything());
  });

  it('keeps tool errors failed when the step failed instead of being stopped', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'run it'),
      stepBegin(0, 1, 's1'),
      toolCall(0, 1, 's1', 'Bash_0', 'Bash', { command: 'make' }),
      record('turn.step.interrupted', { turnId: 0, step: 1, stepId: 's1', reason: 'error' }),
      toolResult('Bash_0', 'Tool "Bash" was aborted', true),
      turnEnded(0, 'failed', { error: { name: 'ProviderError', message: 'boom' } }),
    ]);

    expect(toolItem(state.turns[0], 'Bash_0')).toMatchObject({ outcome: 'failed', error: 'Tool "Bash" was aborted' });
  });
});

describe('conversation fold reasoning timing', () => {
  it('takes the duration of a recorded step part and leaves parts without timing untimed', () => {
    const state = fold([
      turnPrompt(0, 'p1'),
      userMessage('p1', 'think'),
      stepBegin(0, 1, 's1'),
      contentPart(0, 1, 's1', { type: 'think', think: 'plan' }, 0, { startedAt: 1_000, durationMs: 1_500 }),
      contentPart(0, 1, 's1', { type: 'text', text: 'answer' }, 1),
      turnEnded(0, 'completed'),
    ]);

    const [turn] = state.turns;
    const reasoning = (turn?.items ?? []).find((item) => item.type === 'reasoning');
    expect(reasoning).toMatchObject({ item_id: 's1:0', text: 'plan', duration_ms: 1_500, started_at: new Date(1_000).toISOString() });
    const message = (turn?.items ?? []).find((item) => item.type === 'assistant_message');
    expect(message).toMatchObject({ item_id: 's1:1', text: 'answer' });
    expect(message).not.toHaveProperty('duration_ms', expect.anything());
  });
});
