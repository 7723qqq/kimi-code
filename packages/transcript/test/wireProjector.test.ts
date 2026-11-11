import { describe, expect, it } from 'bun:test';

import {
  createWireTranscriptProjector,
  type WireTranscriptContextReducer,
} from '#/projector/wireProjector';
import type { HistoryMessage } from '#/history/groupTurns';
import type { HistoryWireRecord } from '#/history/foldFacts';
import type { TranscriptTurn } from '#/model/turn';

interface MutableMessage {
  id?: string;
  role: string;
  content: unknown[];
  toolCalls: { id: string; name: string; arguments: string | null }[];
  toolCallId?: string;
  isError?: boolean;
  origin?: { kind?: string; [key: string]: unknown };
  usage?: unknown;
  llmTiming?: unknown;
}

interface MutableEntry {
  message: MutableMessage;
  time: number | undefined;
}

function createFakeContextReducer(): WireTranscriptContextReducer {
  const entries: MutableEntry[] = [];
  let open: MutableEntry | undefined;
  let clearFloor = 0;

  const push = (message: MutableMessage, time: number | undefined): void => {
    entries.push({ message, time });
  };

  const applyUndo = (count: number): void => {
    let removed = 0;
    for (let i = entries.length - 1; i >= clearFloor; i--) {
      const message = entries[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      entries.splice(i, 1);
      const origin = message.origin;
      const anchor =
        message.role === 'user' &&
        origin?.['inTurn'] !== true &&
        (origin?.kind === undefined || origin.kind === 'user');
      if (anchor) {
        removed += 1;
        if (removed >= count) break;
      }
    }
    open = undefined;
  };

  const add = (record: HistoryWireRecord): void => {
    switch (record.type) {
      case 'context.append_message':
        push(record['message'] as MutableMessage, record.time);
        return;
      case 'context.append_loop_event': {
        const event = record['event'] as
          | { type: 'step.begin'; uuid: string }
          | { type: 'content.part'; stepUuid: string; part: unknown }
          | { type: 'tool.call'; stepUuid: string; toolCallId: string; name: string; args?: unknown }
          | { type: 'tool.result'; toolCallId: string; result: { output: unknown; isError?: boolean } }
          | { type: 'step.end'; uuid: string; usage?: unknown };
        if (event.type === 'step.begin') {
          open = {
            message: { role: 'assistant', content: [], toolCalls: [] },
            time: record.time,
          };
          push(open.message, open.time);
          return;
        }
        if (event.type === 'content.part') {
          if (open !== undefined) open.message.content.push(event.part);
          return;
        }
        if (event.type === 'tool.call') {
          if (open !== undefined) {
            open.message.toolCalls.push({
              id: event.toolCallId,
              name: event.name,
              arguments: event.args === undefined ? null : JSON.stringify(event.args),
            });
          }
          return;
        }
        if (event.type === 'tool.result') {
          const output = event.result.output;
          push(
            {
              role: 'tool',
              content:
                typeof output === 'string' ? [{ type: 'text', text: output }] : (output as unknown[]),
              toolCalls: [],
              toolCallId: event.toolCallId,
              isError: event.result.isError,
            },
            record.time,
          );
          return;
        }
        if (event.type === 'step.end') {
          if (open !== undefined) {
            open.message.usage = event.usage;
            open = undefined;
          }
        }
        return;
      }
      case 'context.apply_compaction': {
        const summary = record['summary'];
        push(
          {
            role: 'user',
            content: [{ type: 'text', text: typeof summary === 'string' ? summary : '' }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          record.time,
        );
        return;
      }
      case 'context.undo':
        applyUndo(typeof record['count'] === 'number' ? (record['count'] as number) : 0);
        return;
      case 'context.clear':
        clearFloor = entries.length;
        open = undefined;
        return;
      default:
        return;
    }
  };

  return {
    add,
    result: () => ({
      entries: entries.map((entry) => entry.message as unknown as HistoryMessage),
      times: entries.map((entry) => entry.time),
      foldedLength: entries.length,
    }),
  };
}

function promptRecord(overrides: Record<string, unknown>): HistoryWireRecord {
  return {
    type: 'turn.prompt',
    agentId: 'main',
    input: [{ type: 'text', text: 'hello' }],
    origin: { kind: 'user' },
    promptId: 'p1',
    turnId: 1,
    time: 1000,
    ...overrides,
  };
}

function userMessage(
  text: string,
  id: string | undefined,
  origin: Record<string, unknown> | undefined,
  time: number,
): HistoryWireRecord {
  return {
    type: 'context.append_message',
    message: {
      ...(id === undefined ? {} : { id }),
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      ...(origin === undefined ? {} : { origin }),
    },
    time,
  };
}

function assistantMessage(text: string, time: number): HistoryWireRecord {
  return {
    type: 'context.append_message',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    time,
  };
}

function makeProjector() {
  return createWireTranscriptProjector({
    agentId: 'main',
    createContextReducer: createFakeContextReducer,
  });
}

function project(records: readonly HistoryWireRecord[]) {
  const projector = makeProjector();
  projector.sync(records);
  return projector.snapshot();
}

function turnByPrompt(snapshot: ReturnType<typeof project>, prompt: string): TranscriptTurn {
  const turn = snapshot.items.find(
    (item): item is TranscriptTurn => item.kind === 'turn' && item.prompt === prompt,
  );
  if (turn === undefined) throw new Error(`missing turn for ${prompt}`);
  return turn;
}

describe('wire transcript projector', () => {
  it('projects turns, groups, and durable prompt facts from the record stream', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({}),
      userMessage('hello', 'p1', { kind: 'user' }, 1001),
      assistantMessage('hi', 1002),
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', time: 1003 },
      { type: 'prompt.completed', agentId: 'main', promptId: 'p1', reason: 'completed', time: 1004 },
      promptRecord({
        promptId: 'p2',
        turnId: 2,
        origin: { kind: 'task', taskId: 'agent-x' },
        input: [{ type: 'text', text: 'task notification' }],
        time: 2000,
      }),
      userMessage('task notification', undefined, { kind: 'task', taskId: 'agent-x' }, 2001),
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed', time: 2002 },
      { type: 'prompt.completed', agentId: 'main', promptId: 'p2', reason: 'failed', time: 2003 },
    ];

    const snapshot = project(records);

    expect(turnByPrompt(snapshot, 'hello')).toMatchObject({
      turnId: 't1',
      ordinal: 1,
      origin: { kind: 'user' },
      state: 'completed',
      triggerPromptId: 'p1',
    });
    expect(turnByPrompt(snapshot, 'task notification')).toMatchObject({
      turnId: 't2',
      ordinal: 2,
      origin: { kind: 'task', taskId: 'agent-x' },
      state: 'completed',
    });
    expect(snapshot.prompts).toEqual([
      {
        promptId: 'p1',
        status: 'completed',
        userMessageId: 'p1',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: new Date(1000).toISOString(),
        finishedAt: new Date(1004).toISOString(),
      },
      {
        promptId: 'p2',
        status: 'failed',
        createdAt: new Date(2003).toISOString(),
        finishedAt: new Date(2003).toISOString(),
      },
    ]);
  });

  it('keeps queued prompts marked completed by a steer and strips skill activation blocks from prompt content', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({
        promptId: 'p1',
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'a1', skillName: 'deploy' }],
        },
        input: [
          { type: 'text', text: 'skill block' },
          { type: 'text', text: 'visible prompt' },
        ],
      }),
      userMessage('visible prompt', 'p1', { kind: 'user' }, 1001),
      {
        type: 'prompt.steered',
        agentId: 'main',
        activePromptId: 'p1',
        promptIds: ['p2'],
        content: [{ type: 'text', text: 'queued prompt' }],
        steeredAt: new Date(3000).toISOString(),
        time: 3000,
      },
    ];

    const snapshot = project(records);

    expect(snapshot.prompts).toEqual([
      {
        promptId: 'p1',
        status: 'running',
        userMessageId: 'p1',
        content: [{ type: 'text', text: 'visible prompt' }],
        createdAt: new Date(1000).toISOString(),
        steeredAt: new Date(3000).toISOString(),
      },
      {
        promptId: 'p2',
        status: 'completed',
        createdAt: new Date(3000).toISOString(),
        finishedAt: new Date(3000).toISOString(),
        steeredAt: new Date(3000).toISOString(),
      },
    ]);
  });

  it('removes prompts opened at or after an undo anchor while keeping earlier prompts', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({ promptId: 'p1', turnId: 1 }),
      userMessage('hello', 'p1', { kind: 'user' }, 1001),
      assistantMessage('hi', 1002),
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', time: 1003 },
      { type: 'prompt.completed', agentId: 'main', promptId: 'p1', reason: 'completed', time: 1004 },
      promptRecord({
        promptId: 'p2',
        turnId: 2,
        input: [{ type: 'text', text: 'undone' }],
        time: 2000,
      }),
      userMessage('undone', 'p2', { kind: 'user' }, 2001),
      assistantMessage('wip', 2002),
      { type: 'context.undo', count: 1, time: 3000 },
      promptRecord({
        promptId: 'p3',
        turnId: 3,
        input: [{ type: 'text', text: 'after undo' }],
        time: 4000,
      }),
      userMessage('after undo', 'p3', { kind: 'user' }, 4001),
      assistantMessage('done', 4002),
      { type: 'turn.ended', agentId: 'main', turnId: 3, reason: 'completed', time: 4003 },
      { type: 'prompt.aborted', agentId: 'main', promptId: 'p3', abortedAt: new Date(4004).toISOString(), time: 4004 },
    ];

    const snapshot = project(records);

    expect(snapshot.prompts).toEqual([
      {
        promptId: 'p1',
        status: 'completed',
        userMessageId: 'p1',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: new Date(1000).toISOString(),
        finishedAt: new Date(1004).toISOString(),
      },
      {
        promptId: 'p3',
        status: 'aborted',
        userMessageId: 'p3',
        content: [{ type: 'text', text: 'after undo' }],
        createdAt: new Date(4000).toISOString(),
        finishedAt: new Date(4004).toISOString(),
      },
    ]);
    expect(snapshot.items.filter((item) => item.kind === 'turn')).toHaveLength(2);
  });

  it('uses context message anchors so a blocked prompt can be undone without removing an earlier prompt', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({ promptId: 'p1', turnId: 1 }),
      userMessage('hello', 'p1', { kind: 'user' }, 1001),
      assistantMessage('hi', 1002),
      { type: 'prompt.completed', agentId: 'main', promptId: 'p1', reason: 'completed', time: 1003 },
      userMessage('blocked prompt', 'blocked-prompt', { kind: 'user' }, 2000),
      {
        type: 'prompt.completed',
        agentId: 'main',
        promptId: 'blocked-prompt',
        reason: 'blocked',
        time: 2001,
      },
      { type: 'context.undo', count: 1, time: 3000 },
    ];

    const snapshot = project(records);

    expect(snapshot.prompts).toEqual([
      {
        promptId: 'p1',
        status: 'completed',
        userMessageId: 'p1',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: new Date(1000).toISOString(),
        finishedAt: new Date(1003).toISOString(),
      },
    ]);
  });

  it('does not count an in-turn steered message as an undo anchor', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({ promptId: 'p1', turnId: 1 }),
      userMessage('hello', 'p1', { kind: 'user' }, 1001),
      assistantMessage('hi', 1002),
      userMessage('steer', 'm-steer', { kind: 'user', inTurn: true }, 2000),
      { type: 'context.undo', count: 1, time: 3000 },
    ];

    const snapshot = project(records);

    expect(snapshot.prompts).toEqual([]);
  });

  it('does not project a turn prompt whose opening message is absent from the active chain', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({ promptId: 'p1', turnId: 1 }),
      assistantMessage('orphan reply', 1001),
    ];

    expect(project(records).prompts).toEqual([]);
  });

  it('matches a full replay when records arrive in batches and rebuilds on a retroactive steer boundary', () => {
    const records: HistoryWireRecord[] = [
      promptRecord({ promptId: 'p1', turnId: 1 }),
      userMessage('hello', 'p1', { kind: 'user' }, 1001),
      assistantMessage('hi', 1002),
      { type: 'turn.ended', agentId: 'main', turnId: 1, reason: 'completed', time: 1003 },
      promptRecord({ promptId: 'p2', turnId: 2, input: [{ type: 'text', text: 'second' }], time: 2000 }),
      userMessage('second', 'p2', { kind: 'user' }, 2001),
      assistantMessage('working', 2002),
      userMessage('steer', 'm-steer', { kind: 'user' }, 3001),
      {
        type: 'turn.steer',
        agentId: 'main',
        input: [{ type: 'text', text: 'steer' }],
        origin: { kind: 'user' },
        messageId: 'm-steer',
        promptIds: ['p3'],
        turnId: 2,
        time: 3000,
      },
      assistantMessage('done', 3002),
      { type: 'turn.ended', agentId: 'main', turnId: 2, reason: 'completed', time: 3003 },
    ];

    const replay = project(records);

    const incremental = makeProjector();
    for (let index = 0; index < records.length; index += 3) {
      incremental.sync(records.slice(0, Math.min(records.length, index + 3)));
    }
    incremental.sync(records);
    expect(incremental.snapshot()).toEqual(replay);

    const retroactive = makeProjector();
    retroactive.sync(records.slice(0, 8));
    retroactive.sync(records);
    expect(retroactive.snapshot()).toEqual(replay);
  });
});
