import { describe, expect, it } from 'bun:test';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { foldWireRecords, selectFoldableWireRecords } from '#/agent/replayBuilder/fold';
import type { AgentReplayRecord } from '#/agent/replayBuilder/types';
import type { WireRecord } from '#/wire/record';

const METADATA: WireRecord = { type: 'metadata', protocol_version: '1.5', created_at: 0 };

function fold(records: readonly WireRecord[]) {
  return foldWireRecords([METADATA, ...records]);
}

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin,
  };
}

function appendMessage(message: ContextMessage, time = 1): WireRecord {
  return { type: 'context.append_message', message, time };
}

function loopEvent(event: Record<string, unknown>, time = 1): WireRecord {
  return { type: 'context.append_loop_event', event, time };
}

function messageRecords(replay: readonly AgentReplayRecord[]) {
  return replay.filter((record) => record.type === 'message');
}

describe('foldWireRecords', () => {
  it('returns an empty fold for an empty journal', () => {
    expect(foldWireRecords([])).toEqual({ replay: [], toolStore: {} });
    expect(foldWireRecords([METADATA])).toEqual({ replay: [], toolStore: {} });
  });

  it('tolerates a journal without a metadata header', () => {
    const folded = foldWireRecords([appendMessage(userMessage('hi'), 7)]);
    expect(folded.replay).toHaveLength(1);
    expect(folded.replay[0]).toMatchObject({ type: 'message', time: 7 });
  });

  it('assembles assistant messages from loop events with display round-trip', () => {
    const display = { kind: 'command', command: 'ls' } as const;
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 10),
      loopEvent(
        { type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'working' } },
        11,
      ),
      loopEvent(
        {
          type: 'tool.call',
          stepUuid: 's1',
          toolCallId: 'tc1',
          rawId: 'call_native',
          name: 'Shell',
          args: { command: 'ls' },
          display,
        },
        12,
      ),
      loopEvent(
        { type: 'tool.result', toolCallId: 'tc1', result: { output: 'file.txt', isError: false } },
        13,
      ),
      loopEvent({ type: 'step.end', uuid: 's1' }, 14),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const [assistant, tool] = messages;
    expect(assistant).toMatchObject({ type: 'message', time: 10 });
    if (assistant?.type !== 'message') throw new Error('expected message record');
    expect(assistant.message.role).toBe('assistant');
    expect(assistant.message.content).toEqual([{ type: 'text', text: 'working' }]);
    expect(assistant.message.toolCalls).toEqual([
      {
        type: 'function',
        id: 'tc1',
        rawId: 'call_native',
        name: 'Shell',
        arguments: '{"command":"ls"}',
        extras: undefined,
      },
    ]);
    expect(assistant.message.toolCallDisplays).toEqual({ tc1: display });
    if (tool?.type !== 'message') throw new Error('expected message record');
    expect(tool.message).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      content: [{ type: 'text', text: 'file.txt' }],
      isError: false,
    });
    expect(tool.time).toBe(13);
  });

  it('rebuilds tool call arguments from argsRaw when present and keeps legacy records unchanged', () => {
    const raw = '{ "command":  "ls", "timeout": 1e3 }';
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        {
          type: 'tool.call',
          stepUuid: 's1',
          toolCallId: 'tc1',
          name: 'Shell',
          args: { command: 'ls', timeout: 1000 },
          argsRaw: raw,
        },
        2,
      ),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc2', name: 'Shell', args: { command: 'pwd' } },
        3,
      ),
      loopEvent({ type: 'step.end', uuid: 's1' }, 4),
    ]);
    const [assistant] = messageRecords(folded.replay);
    if (assistant?.type !== 'message' || assistant.message.role !== 'assistant') {
      throw new Error('expected assistant message');
    }
    expect(assistant.message.toolCalls.map((call) => call.arguments)).toEqual([
      raw,
      '{"command":"pwd"}',
    ]);
  });

  it('defers messages behind an open tool exchange and flushes them in order', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
      appendMessage(userMessage('deferred', { kind: 'injection', variant: 'x' }), 3),
      loopEvent({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'done' } }, 4),
    ]);
    const messages = messageRecords(folded.replay);
    expect(
      messages.map((record) => (record.type === 'message' ? record.message.role : '')),
    ).toEqual(['assistant', 'tool', 'user']);
    const deferred = messages[2];
    if (deferred?.type !== 'message') throw new Error('expected message record');
    expect(deferred.time).toBe(4);
  });

  it('synthesizes interrupted tool results at a mid-history step boundary', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
      loopEvent({ type: 'step.begin', uuid: 's2' }, 5),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(3);
    const synthesized = messages[1];
    if (synthesized?.type !== 'message') throw new Error('expected message record');
    expect(synthesized.message).toMatchObject({
      role: 'tool',
      toolCallId: 'tc1',
      isError: true,
    });
    expect(synthesized.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('interrupted'),
    });
    expect(synthesized.time).toBe(5);
  });

  it('closes a trailing open exchange at the end of the journal', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent(
        { type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} },
        2,
      ),
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const synthesized = messages[1];
    if (synthesized?.type !== 'message') throw new Error('expected message record');
    expect(synthesized.message).toMatchObject({ role: 'tool', toolCallId: 'tc1', isError: true });
  });

  it('drops a tool result whose call is not pending', () => {
    const folded = fold([
      loopEvent({ type: 'step.begin', uuid: 's1' }, 1),
      loopEvent({ type: 'tool.result', toolCallId: 'ghost', result: { output: 'late' } }, 2),
    ]);
    expect(messageRecords(folded.replay)).toHaveLength(1);
  });

  it('removes replayed messages on context.undo', () => {
    const folded = fold([
      appendMessage(userMessage('first', { kind: 'user' }), 1),
      loopEvent({ type: 'step.begin', uuid: 's1' }, 2),
      loopEvent({ type: 'step.end', uuid: 's1' }, 3),
      appendMessage(userMessage('second', { kind: 'user' }), 4),
      { type: 'context.undo', count: 1, time: 5 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(2);
    const [first, assistant] = messages;
    if (first?.type !== 'message' || assistant?.type !== 'message') {
      throw new Error('expected message records');
    }
    expect(first.message.content[0]).toMatchObject({ text: 'first' });
    expect(assistant.message.role).toBe('assistant');
  });

  it('keeps injection messages out of the undo walk but stops at a compaction boundary', () => {
    const compaction: WireRecord[] = [
      { type: 'full_compaction.begin', instruction: 'sum', time: 10 },
      {
        type: 'context.apply_compaction',
        summary: 'summary text',
        contextSummary: 'summary text',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 0,
        droppedCount: 0,
        time: 11,
      },
    ];
    const folded = fold([
      appendMessage(userMessage('old', { kind: 'user' }), 1),
      ...compaction,
      appendMessage(userMessage('new', { kind: 'user' }), 12),
      { type: 'context.undo', count: 1, time: 13 },
      { type: 'context.undo', count: 1, time: 14 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(1);
    const [remaining] = messages;
    if (remaining?.type !== 'message') throw new Error('expected message record');
    expect(remaining.message.content[0]).toMatchObject({ text: 'old' });
  });

  it('tracks compaction begin, apply, and cancel through the last compaction record', () => {
    const applied = fold([
      { type: 'full_compaction.begin', instruction: 'compress', time: 1 },
      {
        type: 'context.apply_compaction',
        summary: 'model summary',
        contextSummary: 'context summary',
        compactedCount: 3,
        tokensBefore: 500,
        tokensAfter: 50,
        keptUserMessageCount: 2,
        keptHeadUserMessageCount: 1,
        droppedCount: 1,
        time: 2,
      },
    ]);
    expect(applied.replay).toEqual([
      {
        type: 'compaction',
        instruction: 'compress',
        time: 1,
        result: {
          summary: 'model summary',
          contextSummary: 'context summary',
          compactedCount: 3,
          tokensBefore: 500,
          tokensAfter: 50,
          keptUserMessageCount: 2,
          keptHeadUserMessageCount: 1,
          droppedCount: 1,
        },
      },
    ]);

    const cancelled = fold([
      { type: 'full_compaction.begin', time: 1 },
      { type: 'full_compaction.cancel', time: 2 },
    ]);
    expect(cancelled.replay).toEqual([
      { type: 'compaction', instruction: undefined, time: 1, result: 'cancelled' },
    ]);

    const orphanApply = fold([
      {
        type: 'context.apply_compaction',
        summary: 's',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        time: 1,
      },
    ]);
    expect(orphanApply.replay).toEqual([]);
  });

  it('folds goal create/update/clear into goal_updated records', () => {
    const folded = fold([
      { type: 'goal.create', goalId: 'g1', objective: 'ship it', time: 1 },
      { type: 'goal.update', turnsUsed: 3, time: 2 },
      { type: 'goal.update', status: 'paused', reason: 'wait', actor: 'user', time: 3 },
      { type: 'goal.update', status: 'complete', actor: 'model', time: 4 },
      { type: 'goal.clear', time: 5 },
    ]);
    expect(folded.replay).toHaveLength(3);
    const [created, paused, completed] = folded.replay;
    expect(created).toMatchObject({
      type: 'goal_updated',
      time: 1,
      change: { kind: 'created' },
      snapshot: { goalId: 'g1', objective: 'ship it', status: 'active' },
    });
    expect(paused).toMatchObject({
      type: 'goal_updated',
      time: 3,
      change: { kind: 'lifecycle', status: 'paused', reason: 'wait', actor: 'user' },
      snapshot: { status: 'paused', turnsUsed: 3, terminalReason: 'wait' },
    });
    expect(completed).toMatchObject({
      type: 'goal_updated',
      time: 4,
      change: {
        kind: 'completion',
        status: 'complete',
        actor: 'model',
        stats: { turnsUsed: 3, tokensUsed: 0, wallClockMs: 0 },
      },
    });
  });

  it('carries an edited objective into later goal_updated records without a transcript entry', () => {
    const folded = fold([
      { type: 'goal.create', goalId: 'g1', objective: 'old task', time: 1 },
      { type: 'goal.update', objective: 'new task', actor: 'user', time: 2 },
      { type: 'goal.update', status: 'paused', reason: 'wait', time: 3 },
    ]);
    expect(folded.replay).toHaveLength(2);
    expect(folded.replay[1]).toMatchObject({
      type: 'goal_updated',
      time: 3,
      snapshot: { goalId: 'g1', objective: 'new task', status: 'paused' },
    });
  });

  it('clears the goal and appends the fork reminder on forked', () => {
    const folded = fold([
      { type: 'goal.create', goalId: 'g1', objective: 'ship it', time: 1 },
      { type: 'forked', time: 2 },
    ]);
    expect(folded.replay).toHaveLength(2);
    const reminder = folded.replay[1];
    if (reminder?.type !== 'message') throw new Error('expected message record');
    expect(reminder.message.origin).toEqual({ kind: 'system_trigger', name: 'goal_fork_cleared' });

    const noGoal = fold([{ type: 'forked', time: 1 }]);
    expect(noGoal.replay).toEqual([]);
  });

  it('folds plan, permission, approval, and config records', () => {
    const folded = fold([
      { type: 'plan_mode.enter', id: 'p1', time: 1 },
      { type: 'plan_mode.exit', id: 'p1', time: 2 },
      { type: 'plan_mode.enter', id: 'p2', time: 3 },
      { type: 'plan_mode.cancel', time: 4 },
      { type: 'permission.set_mode', mode: 'yolo', time: 5 },
      {
        type: 'permission.record_approval_result',
        turnId: 1,
        toolCallId: 'tc1',
        toolName: 'Shell',
        action: 'run',
        sessionApprovalRule: 'Shell(*)',
        result: { decision: 'approved', scope: 'session' },
        time: 6,
      },
      { type: 'config.update', modelAlias: 'k2', thinkingEffort: 'high', time: 7 },
    ]);
    expect(folded.replay).toEqual([
      { type: 'plan_updated', enabled: true, time: 1 },
      { type: 'plan_updated', enabled: false, time: 2 },
      { type: 'plan_updated', enabled: true, time: 3 },
      { type: 'plan_updated', enabled: false, time: 4 },
      { type: 'permission_updated', mode: 'yolo', time: 5 },
      {
        type: 'approval_result',
        time: 6,
        record: {
          turnId: 1,
          toolCallId: 'tc1',
          toolName: 'Shell',
          action: 'run',
          sessionApprovalRule: 'Shell(*)',
          result: { decision: 'approved', scope: 'session' },
        },
      },
      {
        type: 'config_updated',
        time: 7,
        config: {
          modelAlias: 'k2',
          profileName: undefined,
          thinkingLevel: 'high',
          systemPrompt: undefined,
        },
      },
    ]);
  });

  it('applies tools.update_store last-wins into the tool store', () => {
    const folded = fold([
      { type: 'tools.update_store', key: 'todo', value: ['a'], time: 1 },
      { type: 'tools.update_store', key: 'todo', value: ['b'], time: 2 },
      { type: 'tools.update_store', key: 'other', value: { x: 1 }, time: 3 },
    ]);
    expect(folded.replay).toEqual([]);
    expect(folded.toolStore).toEqual({ todo: ['b'], other: { x: 1 } });
  });

  it('ignores state-only, observability, and v2-only record types', () => {
    const folded = fold([
      { type: 'turn.prompt', input: [], origin: { kind: 'user' }, time: 1 },
      { type: 'usage.record', model: 'k2', usage: {}, time: 2 },
      { type: 'profile.bind', modelAlias: 'k2', disallowedTools: [], time: 3 },
      { type: 'task.started', taskId: 't1', time: 4 },
      { type: 'task.terminated', taskId: 't1', time: 5 },
      { type: 'interaction.requested', id: 'i1', time: 6 },
      { type: 'llm.request', kind: 'loop', time: 7 },
      { type: 'mcp.tools_discovered', serverName: 's', hash: 'h', time: 8 },
      { type: 'token_counting.measured', tokens: 1, time: 9 },
      { type: 'context.update_token_count', tokenCount: 10, time: 10 },
      { type: 'full_compaction.complete', time: 11 },
      { type: 'tools.set_active_tools', names: ['Shell'], time: 12 },
      { type: 'totally.unknown.op', time: 13 },
    ]);
    expect(folded).toEqual({ replay: [], toolStore: {} });

    const turnClock = fold([
      {
        type: 'turn.prompt',
        turnId: 4,
        input: [{ type: 'text', text: 'current' }],
        origin: { kind: 'user' },
        time: 1,
      },
      {
        type: 'turn.steer',
        input: [{ type: 'text', text: 'steered' }],
        origin: { kind: 'user' },
        time: 2,
      },
      { type: 'turn.cancel', turnId: 5, time: 3 },
      appendMessage(userMessage('current', { kind: 'user' }), 4),
      appendMessage(userMessage('steered', { kind: 'user' }), 4.5),
      { type: 'turn.cancel', turnId: 5, target: 'queued', time: 5 },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'next' }],
        origin: { kind: 'user' },
        time: 6,
      },
      appendMessage(userMessage('next', { kind: 'user' }), 7),
    ]);
    expect(
      messageRecords(turnClock.replay).map((record) =>
        record.type === 'message' ? record.turnId : undefined,
      ),
    ).toEqual([4, 4, 6]);

    const mixed = fold([
      {
        type: 'turn.prompt',
        turnId: 7,
        input: [{ type: 'text', text: 'persistent' }],
        origin: { kind: 'user' },
        time: 1,
      },
      appendMessage(userMessage('persistent', { kind: 'user' }), 2),
      { type: 'turn.ended', turnId: 7, reason: 'completed', time: 3 },
      appendMessage(userMessage('legacy tail', { kind: 'user' }), 4),
      appendMessage({ role: 'assistant', content: [], toolCalls: [] }, 5),
    ]);
    expect(
      messageRecords(mixed.replay).map((record) =>
        record.type === 'message' ? record.turnId : undefined,
      ),
    ).toEqual([7, undefined, undefined]);

    const ordered = fold([
      appendMessage(userMessage('same', { kind: 'user' }), 1),
      {
        type: 'turn.prompt',
        turnId: 7,
        input: [{ type: 'text', text: 'same' }],
        origin: { kind: 'user' },
        time: 2,
      },
      appendMessage(userMessage('same', { kind: 'user' }), 3),
    ]);
    expect(
      messageRecords(ordered.replay).map((record) =>
        record.type === 'message' ? record.turnId : undefined,
      ),
    ).toEqual([undefined, 7]);
  });

  it('migrates older protocol journals before folding', () => {
    const legacy: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.0', created_at: 0 },
      appendMessage(userMessage('hi'), 3),
    ];
    const folded = foldWireRecords(legacy);
    expect(folded.replay).toHaveLength(1);
    expect(folded.replay[0]).toMatchObject({ type: 'message', time: 3 });
  });

  it('clears replay-visible state on context.clear without touching earlier replay records', () => {
    const folded = fold([
      appendMessage(userMessage('before', { kind: 'user' }), 1),
      { type: 'context.clear', time: 2 },
      appendMessage(userMessage('after', { kind: 'user' }), 3),
      { type: 'context.undo', count: 1, time: 4 },
    ]);
    const messages = messageRecords(folded.replay);
    expect(messages).toHaveLength(1);
    const [remaining] = messages;
    if (remaining?.type !== 'message') throw new Error('expected message record');
    expect(remaining.message.content[0]).toMatchObject({ text: 'before' });
  });
});

describe('foldWireRecords turn endings', () => {
  const refusal = {
    code: 'provider.api_error',
    message: 'The example service refused this request.',
    retryable: false,
  } as const;

  function turnEnded(
    turnId: number,
    reason: string,
    time: number,
    extra: Record<string, unknown> = {},
  ): WireRecord {
    return { type: 'turn.ended', agentId: 'main', turnId, reason, durationMs: 5, ...extra, time };
  }

  function outline(replay: readonly AgentReplayRecord[]): string[] {
    return replay.map((record) => {
      if (record.type === 'turn_ended') return `ended ${record.turnId} ${record.reason}`;
      if (record.type !== 'message') return record.type;
      const { message } = record;
      if (message.role === 'tool') return `tool ${message.toolCallId}`;
      if (message.role === 'user') {
        const [part] = message.content;
        return `user ${part?.type === 'text' ? part.text : ''}`;
      }
      return message.role;
    });
  }

  function answeredStep(uuid: string, time: number): WireRecord[] {
    return [
      loopEvent({ type: 'step.begin', uuid }, time),
      loopEvent({ type: 'content.part', stepUuid: uuid, part: { type: 'text', text: 'answer' } }, time),
      loopEvent({ type: 'step.end', uuid }, time),
    ];
  }

  it('records how each turn ended right after its messages, with the error of a failed turn', () => {
    const folded = fold([
      appendMessage(userMessage('first', { kind: 'user' }), 1),
      ...answeredStep('s1', 2),
      turnEnded(0, 'completed', 3, { stopReason: 'end_turn' }),
      appendMessage(userMessage('second', { kind: 'user' }), 4),
      turnEnded(1, 'failed', 5, { error: refusal }),
      appendMessage(userMessage('third', { kind: 'user' }), 6),
      ...answeredStep('s3', 7),
      turnEnded(2, 'cancelled', 8),
      appendMessage(userMessage('fourth', { kind: 'user' }), 9),
      turnEnded(3, 'blocked', 10),
    ]);

    expect(outline(folded.replay)).toEqual([
      'user first',
      'assistant',
      'ended 0 completed',
      'user second',
      'ended 1 failed',
      'user third',
      'assistant',
      'ended 2 cancelled',
      'user fourth',
      'ended 3 blocked',
    ]);
    expect(folded.replay.filter((record) => record.type === 'turn_ended')).toEqual([
      { type: 'turn_ended', turnId: 0, reason: 'completed', time: 3 },
      { type: 'turn_ended', turnId: 1, reason: 'failed', error: refusal, time: 5 },
      { type: 'turn_ended', turnId: 2, reason: 'cancelled', time: 8 },
      { type: 'turn_ended', turnId: 3, reason: 'blocked', time: 10 },
    ]);
  });

  it('keeps the end of a turn after the result of a tool call the turn left open', () => {
    const toolCall = (time: number) =>
      loopEvent({ type: 'tool.call', stepUuid: 's1', toolCallId: 'tc1', name: 'Shell', args: {} }, time);

    const lateResult = fold([
      appendMessage(userMessage('run it', { kind: 'user' }), 1),
      loopEvent({ type: 'step.begin', uuid: 's1' }, 2),
      toolCall(3),
      turnEnded(0, 'cancelled', 4),
      loopEvent({ type: 'tool.result', toolCallId: 'tc1', result: { output: 'stopped late' } }, 5),
    ]);
    expect(outline(lateResult.replay)).toEqual(['user run it', 'assistant', 'tool tc1', 'ended 0 cancelled']);
    expect(lateResult.replay.at(-1)).toMatchObject({ type: 'turn_ended', time: 4 });

    const nextTurn = fold([
      appendMessage(userMessage('run it', { kind: 'user' }), 1),
      loopEvent({ type: 'step.begin', uuid: 's1' }, 2),
      toolCall(3),
      turnEnded(0, 'cancelled', 4),
      appendMessage(userMessage('next', { kind: 'user' }), 5),
      loopEvent({ type: 'step.begin', uuid: 's2' }, 6),
    ]);
    expect(outline(nextTurn.replay)).toEqual([
      'user run it',
      'assistant',
      'tool tc1',
      'ended 0 cancelled',
      'user next',
      'assistant',
    ]);
    expect(nextTurn.replay[3]).toMatchObject({ type: 'turn_ended', time: 4 });
  });

  it('drops the end of a turn the user undid and keeps the ends of earlier turns', () => {
    const folded = fold([
      appendMessage(userMessage('first', { kind: 'user' }), 1),
      ...answeredStep('s1', 2),
      turnEnded(0, 'failed', 3, { error: refusal }),
      appendMessage(userMessage('second', { kind: 'user' }), 4),
      ...answeredStep('s2', 5),
      turnEnded(1, 'cancelled', 6),
      { type: 'context.undo', count: 1, time: 7 },
    ]);
    expect(outline(folded.replay)).toEqual(['user first', 'assistant', 'ended 0 failed']);
  });

  it('still finishes a compaction that ends after the turn it ran in', () => {
    const cancelled = fold([
      appendMessage(userMessage('long task', { kind: 'user' }), 1),
      { type: 'full_compaction.begin', time: 2 },
      turnEnded(0, 'failed', 3, { error: refusal }),
      { type: 'full_compaction.cancel', time: 4 },
    ]);
    expect(cancelled.replay.slice(1)).toEqual([
      { type: 'compaction', instruction: undefined, time: 2, result: 'cancelled' },
      { type: 'turn_ended', turnId: 0, reason: 'failed', error: refusal, time: 3 },
    ]);
  });

  it('skips turn endings it cannot read and drops an error it cannot read', () => {
    const folded = fold([
      { type: 'turn.ended', agentId: 'main', reason: 'failed', error: refusal, time: 1 },
      turnEnded(1, 'paused', 2),
      turnEnded(2, 'failed', 3, { error: 'The example service refused this request.' }),
      turnEnded(3, 'failed', 4, { error: { message: 'no code' } }),
      turnEnded(4, 'failed', 5, {
        error: { code: 'provider.filtered', message: 'blocked', details: { finishReason: 'filtered' } },
      }),
    ]);
    expect(folded.replay).toEqual([
      { type: 'turn_ended', turnId: 2, reason: 'failed', time: 3 },
      { type: 'turn_ended', turnId: 3, reason: 'failed', time: 4 },
      {
        type: 'turn_ended',
        turnId: 4,
        reason: 'failed',
        error: {
          code: 'provider.filtered',
          message: 'blocked',
          details: { finishReason: 'filtered' },
          retryable: false,
        },
        time: 5,
      },
    ]);
  });

  it('keeps an open step across an error or interrupted step.end retry marker', () => {
    const folded = fold([
      appendMessage(userMessage('retry me', { kind: 'user' }), 1),
      loopEvent({ type: 'step.begin', uuid: 's-retry', turnId: '0' }, 2),
      loopEvent({ type: 'step.end', uuid: 's-retry', finishReason: 'error' }, 3),
      loopEvent({ type: 'content.part', stepUuid: 's-retry', part: { type: 'text', text: 'recovered' } }, 4),
      loopEvent(
        { type: 'tool.call', stepUuid: 's-retry', toolCallId: 'tc-retry', name: 'Read', args: {} },
        5,
      ),
      loopEvent({ type: 'tool.result', toolCallId: 'tc-retry', result: { output: 'ok' } }, 6),
      loopEvent({ type: 'step.end', uuid: 's-retry', finishReason: 'stop' }, 7),
    ]);
    expect(outline(folded.replay)).toEqual(['user retry me', 'assistant', 'tool tc-retry']);
    const assistant = folded.replay[1];
    if (assistant?.type !== 'message') throw new Error('expected assistant');
    expect(assistant.message.content).toEqual([{ type: 'text', text: 'recovered' }]);
  });

  it('salvages valid step records sequentially without cascading step_uuid failures', () => {
    const { kept, skipped } = selectFoldableWireRecords([
      { lineNumber: 1, record: METADATA },
      { lineNumber: 2, record: appendMessage(userMessage('hi', { kind: 'user' }), 1) },
      { lineNumber: 3, record: loopEvent({ type: 'step.begin', uuid: 's1' }, 2) },
      {
        lineNumber: 4,
        record: loopEvent({ type: 'content.part', stepUuid: 'missing-step', part: { type: 'text', text: 'orphan' } }, 3),
      },
      {
        lineNumber: 5,
        record: loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'valid' } }, 4),
      },
      { lineNumber: 6, record: loopEvent({ type: 'step.end', uuid: 's1' }, 5) },
    ]);
    expect(skipped.map((e) => e.lineNumber)).toEqual([4]);
    expect(kept.map((e) => e.lineNumber)).toEqual([1, 2, 3, 5, 6]);
  });
});
