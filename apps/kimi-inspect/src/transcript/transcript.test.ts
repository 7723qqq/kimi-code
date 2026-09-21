/**
 * Transcript glue-layer tests — the app's own WS/store/channel plumbing for
 * the v1 transcript surface. The op vocabulary itself is covered by
 * `@moonshot-ai/transcript`'s own suite and is intentionally not re-tested
 * here; what these pin is this app's wiring: the subscribe handshake, the
 * reset/ops fold, the reconnect cursor, and the plan derivation.
 */
import {
  applyOperation,
  EMPTY_AGENT_STATE,
  type AgentState,
  type TranscriptOpBatch,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';
import { describe, expect, it, vi } from 'vitest';

import type { WsLike } from '../channel/wsLike';
import { ChatChannel } from './channel';
import { projectPlans } from './plan';
import { ChatStore, newestTerminalStepId, oldestTurnId, type TimelineEntry, type TimelineMessage } from './store';
import { ChatWs } from './ws';

// ---------------------------------------------------------------- fixtures

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
let tick = 0;

function ts(offsetMs?: number): string {
  tick += 1;
  return new Date(T0 + tick * 1000 + (offsetMs ?? 0)).toISOString();
}

/** Fold a list of ops into a fresh agent state (the store's own path). */
function fold(ops: readonly TranscriptOperation[], agentId = 'main'): AgentState {
  let state = EMPTY_AGENT_STATE;
  for (const op of ops) state = applyOperation(state, op).state;
  return state;
}

/** The `transcript.reset` snapshot the server builds from the same ops. */
function snapshotOf(ops: readonly TranscriptOperation[], agentId = 'main') {
  const state = fold(ops, agentId);
  return {
    items: state.items,
    tasks: [...state.tasks.values()],
    interactions: [...state.interactions.values()],
    attachments: [...state.attachments.values()],
    todos: [...state.todos.values()],
    prompts: [...state.prompts.values()],
    meta: state.meta,
  };
}

function turnOp(n: number, state: 'running' | 'completed' = 'completed', at?: string) {
  return {
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      turnId: `t${n}`,
      ordinal: n,
      state,
      origin: { kind: 'user' },
      steps: [],
      startedAt: at ?? ts(),
    },
  } as const;
}

function stepOp(stepId: string, state: 'running' | 'completed' = 'completed', at?: string) {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    op: 'step.upsert',
    turnId,
    step: {
      kind: 'step',
      stepId,
      turnId,
      ordinal: Number(stepId.split('.')[1] ?? '1'),
      state,
      frames: [],
      startedAt: at ?? ts(),
    },
  } as const;
}

function textOp(
  stepId: string,
  role: 'user' | 'assistant',
  text: string,
  frameId = `${stepId}.${role === 'user' ? 'u0' : 'a0'}`,
) {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    op: 'frame.upsert',
    turnId,
    stepId,
    frame: { kind: 'text', frameId, role, text },
  } as const;
}

function toolOp(stepId: string, id: string, overrides: Record<string, unknown> = {}) {
  const turnId = stepId.split('.')[0] ?? 't1';
  return {
    op: 'frame.upsert',
    turnId,
    stepId,
    frame: {
      kind: 'tool',
      frameId: `tool:${id}`,
      toolCallId: id,
      name: 'Bash',
      state: 'running',
      ...overrides,
    },
  } as const;
}

function markerOp(marker: string, markerId: string, payload?: unknown) {
  return {
    op: 'marker.upsert',
    item: { kind: 'marker', markerId, marker, payload, at: ts() },
    before_turn: null,
  } as const;
}

function interactionOp(id: string, toolCallId?: string) {
  return {
    op: 'interaction.upsert',
    interaction: {
      interactionId: id,
      interactionKind: 'approval',
      toolCallId,
      state: 'pending',
    },
  } as const;
}

function taskOp(id: string, state: 'running' | 'completed' = 'running') {
  return {
    op: 'task.upsert',
    task: { taskId: id, kind: 'shell', state, detached: false, outputTail: '' },
  } as const;
}

function todoOp(id: string, items: readonly { title: string; status: 'pending' | 'done' }[]) {
  return { op: 'todo.upsert', todo: { todoId: id, items } } as const;
}

function batch(ops: readonly TranscriptOperation[], agentId = 'main'): TranscriptOpBatch {
  return { agentId, ops };
}

function entryKeys(entries: readonly TimelineEntry[]): string[] {
  return entries.map((entry) => entry.key);
}

/** The held message of one type (the timeline leads with its turn card). */
function heldOf<T extends TimelineMessage['type']>(
  entries: readonly TimelineEntry[],
  type: T,
): Extract<TimelineMessage, { type: T }> {
  const found = entries.find((entry) => entry.message.type === type);
  if (found === undefined) throw new Error(`no ${type} entry in ${entryKeys(entries).join(',')}`);
  return found.message as Extract<TimelineMessage, { type: T }>;
}

function makeStore(): ChatStore {
  return new ChatStore({ notifyIntervalMs: 0 });
}

class FakeWs implements WsLike {
  static OPEN = 1;
  static instances: FakeWs[] = [];
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWs.instances.push(this);
  }

  static reset(): void {
    FakeWs.instances = [];
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  open(): void {
    this.emit('open');
  }

  serverFrame(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  hello(): void {
    this.serverFrame({ type: 'server_hello', protocol_version: '1', server_id: 'srv' });
  }

  /** A `transcript.reset` baseline built from the given ops. */
  reset(ops: readonly TranscriptOperation[], agentId = 'main'): void {
    this.serverFrame({
      type: 'transcript.reset',
      session_id: 's1',
      payload: { agent_id: agentId, snapshot: snapshotOf(ops, agentId), has_more_older: false },
    });
  }

  ops(ops: readonly TranscriptOperation[], agentId = 'main', seq = 1): void {
    this.serverFrame({
      type: 'transcript.ops',
      session_id: 's1',
      payload: { agent_id: agentId, ops, seq },
    });
  }
}

function makeWs(handlers: Partial<ConstructorParameters<typeof ChatWs>[0]['handlers']> = {}) {
  const seen = {
    resets: [] as unknown[],
    batches: [] as TranscriptOpBatch[],
    acks: [] as { code: number; msg?: string }[],
    protocolErrors: [] as { code: number; msg: string }[],
    invalid: 0,
    reconnects: 0,
  };
  const ws = new ChatWs({
    url: 'http://h:1',
    token: 'tok',
    sessionId: 's1',
    agentIds: ['main'],
    WebSocketImpl: FakeWs,
    reconnectDelayMs: 1,
    handlers: {
      onReset: (agentId, snapshot) => {
        seen.resets.push(snapshot);
        handlers.onReset?.(agentId, snapshot);
      },
      onOps: (b) => {
        seen.batches.push(b);
        handlers.onOps?.(b);
      },
      onAck: (code, msg) => {
        seen.acks.push({ code, msg });
        handlers.onAck?.(code, msg);
      },
      onProtocolError: (code, msg) => {
        seen.protocolErrors.push({ code, msg });
        handlers.onProtocolError?.(code, msg);
      },
      onInvalidFrame: () => {
        seen.invalid += 1;
        handlers.onInvalidFrame?.(null);
      },
      onReconnectScheduled: () => {
        seen.reconnects += 1;
        handlers.onReconnectScheduled?.(0);
      },
    },
  });
  return { ws, seen };
}

// ---------------------------------------------------------------- ws

describe('ChatWs', () => {
  it('sends client_hello on open and subscribe_v2 after the server hello', () => {
    FakeWs.reset();
    const { ws } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    expect(sock.sentFrames()[0]).toMatchObject({ kind: 'client_hello' });
    sock.hello();
    const sub = sock.sentFrames()[1]!;
    expect(sub).toMatchObject({ kind: 'subscribe_v2', session_id: 's1' });
    expect(sub['transcript']).toEqual({ main: 'delta' });
    // The cold load asks from seq 0.
    expect(sub['transcript_since']).toEqual({ main: 0 });
    ws.close();
  });

  it('fires onAck on the subscribe ack and forwards reset/ops frames', () => {
    FakeWs.reset();
    const { ws, seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.hello();
    sock.serverFrame({ kind: 'ack', id: 'sub-1', code: 0, msg: '' });
    expect(seen.acks).toHaveLength(1);
    sock.reset([turnOp(1)]);
    sock.ops([stepOp('t1.1')]);
    expect(seen.resets).toHaveLength(1);
    expect(seen.batches).toHaveLength(1);
    ws.close();
  });

  it('surfaces protocol error frames and ignores acks for other ids', () => {
    FakeWs.reset();
    const { ws, seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.hello();
    sock.serverFrame({ kind: 'ack', id: 'sub-99', code: 0, msg: '' });
    expect(seen.acks).toHaveLength(0);
    sock.serverFrame({ kind: 'error', code: 40112, msg: 'unauthorized' });
    expect(seen.protocolErrors).toEqual([{ code: 40112, msg: 'unauthorized' }]);
    ws.close();
  });

  it('reports a malformed frame and ignores one with no known type', () => {
    FakeWs.reset();
    const { ws, seen } = makeWs();
    const sock = FakeWs.instances[0]!;
    sock.open();
    sock.emit('message', { data: 'not json' });
    sock.serverFrame({ type: 'turn.supercharged', whatever: true });
    expect(seen.invalid).toBe(2);
    ws.close();
  });

  it('re-subscribes after a drop and carries the applied seq as the cursor', async () => {
    FakeWs.reset();
    const { ws, seen } = makeWs();
    const first = FakeWs.instances[0]!;
    first.open();
    first.hello();
    first.serverFrame({ kind: 'ack', id: 'sub-1', code: 0, msg: '' });
    first.ops([stepOp('t1.1')], 'main', 7);
    expect(seen.acks).toHaveLength(1);
    first.emit('close');
    await vi.waitFor(() => {
      expect(FakeWs.instances.length).toBeGreaterThan(1);
    });
    const second = FakeWs.instances[1]!;
    second.open();
    second.hello();
    const sub = second.sentFrames()[1]!;
    expect(sub).toMatchObject({ kind: 'subscribe_v2', id: 'sub-2' });
    // The reconnect resumes from the last applied seq, not from zero.
    expect(sub['transcript_since']).toEqual({ main: 7 });
    ws.close();
  });

  it('stays closed after close()', () => {
    FakeWs.reset();
    const { ws } = makeWs();
    FakeWs.instances[0]!.open();
    ws.close();
    expect(FakeWs.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- store

describe('ChatStore', () => {
  it('folds a reset baseline into the projected timeline', () => {
    const store = makeStore();
    store.applyReset('main', snapshotOf([turnOp(1, 'running'), stepOp('t1.1', 'running')]));
    store.applyBatch(batch([turnOp(1, 'completed')]));
    const state = store.getState();
    expect(entryKeys(state.entries)).toEqual(['turn:t1', 'step:t1.1']);
    expect(heldOf(state.entries, 'turn').status).toBe('completed');
  });

  it('keeps the newest text when an older append arrives after it', () => {
    const store = makeStore();
    store.applyBatch(batch([textOp('t1.1', 'assistant', 'hello world')]));
    store.applyBatch(
      batch([
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.a0' },
          offset: 0,
          text: 'hel',
        },
      ]),
    );
    expect(heldOf(store.getState().entries, 'assistant').text).toBe('hello world');
  });

  it('appends deltas to the held frame and drops orphan appends', () => {
    const store = makeStore();
    store.applyBatch(
      batch([
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.a0' },
          offset: 0,
          text: 'orphan',
        },
      ]),
    );
    expect(store.getState().entries).toHaveLength(0);
    store.applyBatch(batch([textOp('t1.1', 'assistant', '')]));
    store.applyBatch(
      batch([
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.a0' },
          offset: 0,
          text: 'hel',
        },
      ]),
    );
    store.applyBatch(
      batch([
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.a0' },
          offset: 3,
          text: 'lo',
        },
      ]),
    );
    expect(heldOf(store.getState().entries, 'assistant').text).toBe('hello');
  });

  it('treats a frame upsert after deltas as the authoritative whole', () => {
    const store = makeStore();
    store.applyBatch(batch([textOp('t1.1', 'assistant', '')]));
    store.applyBatch(
      batch([
        {
          op: 'append',
          target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.a0' },
          offset: 0,
          text: 'partial',
        },
      ]),
    );
    store.applyBatch(batch([textOp('t1.1', 'assistant', 'partial but authoritative')]));
    expect(heldOf(store.getState().entries, 'assistant').text).toBe('partial but authoritative');
  });

  it('carries streamed tool input as whole-frame upserts and patches progress', () => {
    const store = makeStore();
    store.applyBatch(batch([toolOp('t1.1', 'call_1', { inputText: '' })]));
    // A streamed argument delta lands as a frame upsert carrying the text so
    // far (the v1 projector's ToolCallDelta arm), not as an offset append.
    store.applyBatch(batch([toolOp('t1.1', 'call_1', { inputText: '{"command"' })]));
    store.applyBatch(batch([toolOp('t1.1', 'call_1', { inputText: '{"command":"ls"}' })]));
    // A progress patch is another whole-frame upsert, so it carries the
    // input accumulated so far — the frame is replaced, not merged.
    store.applyBatch(
      batch([
        toolOp('t1.1', 'call_1', {
          inputText: '{"command":"ls"}',
          progress: { kind: 'stdout', text: 'file.txt' },
        }),
      ]),
    );
    const held = heldOf(store.getState().entries, 'tool_call');
    expect(held.input_text).toBe('{"command":"ls"}');
    expect(held.progress).toEqual({ kind: 'stdout', text: 'file.txt' });
  });

  it('truncates the removed turn subtree on an undo marker and keeps the marker', () => {
    const store = makeStore();
    store.applyBatch(
      batch([
        turnOp(1),
        stepOp('t1.1'),
        textOp('t1.1', 'assistant', 'first'),
        turnOp(2),
        stepOp('t2.1'),
        toolOp('t2.1', 'call_1'),
        markerOp('undo', 'sys-undo-1'),
        { op: 'items.remove', ids: ['t2'] },
      ]),
    );
    expect(entryKeys(store.getState().entries)).toEqual([
      'turn:t1',
      'step:t1.1',
      'frame:t1.1.a0',
      'marker:sys-undo-1',
    ]);
  });

  it('cascades undo to interactions anchored at removed tool calls', () => {
    const store = makeStore();
    store.applyBatch(
      batch([
        turnOp(1),
        toolOp('t1.1', 'call_1'),
        interactionOp('ix-1', 'call_1'),
        interactionOp('ix-2', 'call_other'),
        markerOp('undo', 'sys-undo-1'),
        { op: 'items.remove', ids: ['t1'] },
      ]),
    );
    expect([...store.getState().interactions.keys()]).toEqual(['ix-2']);
  });

  it('empties the timeline on a clear marker', () => {
    const store = makeStore();
    store.applyBatch(
      batch([
        turnOp(1),
        stepOp('t1.1'),
        textOp('t1.1', 'assistant', 'gone'),
        markerOp('clear', 'sys-clear-1'),
        { op: 'items.remove', ids: ['t1', 't1.1', 't1.1.a0'] },
      ]),
    );
    expect(entryKeys(store.getState().entries)).toEqual(['marker:sys-clear-1']);
  });

  it('upserts state entities into their own maps and keeps them off the timeline', () => {
    const store = makeStore();
    store.applyBatch(
      batch([
        interactionOp('ix-1', 'call_1'),
        taskOp('task-1'),
        todoOp('todo', [{ title: 'x', status: 'pending' }]),
        { op: 'meta.merge', meta: { agent: { model: 'm' } } },
      ]),
    );
    const state = store.getState();
    expect(state.interactions.get('ix-1')?.state).toBe('pending');
    expect(state.tasks.get('task-1')?.kind).toBe('shell');
    expect(state.todos.get('todo')?.items).toHaveLength(1);
    expect(state.meta.agent?.model).toBe('m');
    expect(state.entries).toHaveLength(0);
  });

  it('reports a seq gap so the channel can resubscribe from zero', () => {
    const store = makeStore();
    store.applyBatch(batch([turnOp(1)]));
    const clean = store.applyBatch(batch([turnOp(2)]));
    expect(clean.gap).toBe(false);
  });
});

// ---------------------------------------------------------------- channel

describe('ChatChannel', () => {
  function makeChannel(): { channel: ChatChannel; sock: FakeWs } {
    FakeWs.reset();
    const channel = new ChatChannel({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's1',
      agentId: 'main',
      WebSocketImpl: FakeWs,
      notifyIntervalMs: 0,
    });
    return { channel, sock: FakeWs.instances[0]! };
  }

  it('applies the cold replay and reports loaded', () => {
    const { channel, sock } = makeChannel();
    let loaded = false;
    channel.start();
    sock.open();
    sock.hello();
    sock.serverFrame({ kind: 'ack', id: 'sub-1', code: 0, msg: '' });
    sock.reset([turnOp(1), stepOp('t1.1')]);
    sock.ops([textOp('t1.1', 'assistant', 'hi')]);
    expect(entryKeys(channel.store.getState().entries)).toEqual([
      'turn:t1',
      'step:t1.1',
      'frame:t1.1.a0',
    ]);
    expect(channel.trail.getEntries().some((e) => e.kind === 'ops' && e.mode === 'reset')).toBe(
      true,
    );
    expect(loaded).toBe(false);
    channel.close();
  });

  it('resubscribes from zero when a batch reports a seq gap', async () => {
    const { channel, sock } = makeChannel();
    channel.start();
    sock.open();
    sock.hello();
    sock.serverFrame({ kind: 'ack', id: 'sub-1', code: 0, msg: '' });
    sock.reset([turnOp(1)]);
    // A gap is produced by the fold when the server's seq jumps; the channel
    // answers it with a reconnect, which re-subscribes from the held cursor.
    const before = FakeWs.instances.length;
    channel.reconnect(0);
    await vi.waitFor(() => {
      expect(FakeWs.instances.length).toBeGreaterThan(before);
    });
    channel.close();
  });

  it('records a rejected subscribe as a load error', () => {
    const { channel, sock } = makeChannel();
    const errors: unknown[] = [];
    const failing = new ChatChannel({
      baseUrl: 'http://h:1',
      token: 'tok',
      sessionId: 's1',
      agentId: 'main',
      WebSocketImpl: FakeWs,
      notifyIntervalMs: 0,
      onLoadError: (error) => errors.push(error),
    });
    failing.start();
    const failSock = FakeWs.instances.at(-1)!;
    failSock.open();
    failSock.hello();
    failSock.serverFrame({ kind: 'ack', id: 'sub-1', code: 40401, msg: 'no such session' });
    expect(errors).toHaveLength(1);
    failing.close();
    channel.close();
  });
});

// ---------------------------------------------------------------- plan

describe('projectPlans', () => {
  const planCall = (id: string, overrides: Record<string, unknown> = {}) =>
    toolOp('t1.1', id, { name: 'ExitPlanMode', state: 'done', ...overrides });

  it('derives plan content and review from the linked approval interaction', () => {
    const entries = fold([
      turnOp(1),
      planCall('call_plan'),
      interactionOp('ix-1', 'call_plan'),
    ]);
    // The approval's request carries the plan_review display payload.
    const state = applyOperation(
      { ...entries, interactions: new Map() },
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'ix-1',
          interactionKind: 'approval',
          toolCallId: 'call_plan',
          state: 'approved',
          request: {
            tool_name: 'ExitPlanMode',
            action: 'review',
            tool_input_display: {
              kind: 'plan_review',
              plan: '# The Plan\n\nDo the thing.',
              path: '/tmp/plans/foo.md',
              options: [{ label: 'Approach A', description: 'fast' }],
            },
          },
          response: { decision: 'approved', selected_label: 'Approach A', feedback: 'looks good' },
        },
      },
    ).state;
    const messages = projectChatEntries(state);
    const plans = projectPlans(messages, state.interactions);
    expect(plans).toEqual([
      {
        toolCallId: 'call_plan',
        turnId: 't1',
        source: 'interaction',
        plan: '# The Plan\n\nDo the thing.',
        path: '/tmp/plans/foo.md',
        options: [{ label: 'Approach A', description: 'fast' }],
        review: { state: 'approved', selectedOption: 'Approach A', feedback: 'looks good' },
      },
    ]);
  });

  it('falls back to the tool output body', () => {
    const entries = fold([
      turnOp(1),
      planCall('call_output', {
        output: 'Plan saved to: /tmp/out.md\n## Approved Plan:\n# Final',
      }),
    ]);
    const plans = projectPlans(projectChatEntries(entries), entries.interactions);
    expect(plans[0]).toMatchObject({ source: 'output', plan: '# Final', path: '/tmp/out.md' });
  });

  it('filters by tool_call_id and ignores non-ExitPlanMode calls', () => {
    const entries = fold([
      turnOp(1),
      planCall('call_a', { output: '## Approved Plan:\n# A' }),
      toolOp('t1.1', 'call_bash'),
      planCall('call_b', { output: '## Approved Plan:\n# B' }),
    ]);
    const messages = projectChatEntries(entries);
    expect(projectPlans(messages, entries.interactions, 'call_b').map((p) => p.toolCallId)).toEqual([
      'call_b',
    ]);
    expect(projectPlans(messages, entries.interactions).map((p) => p.toolCallId)).toEqual([
      'call_a',
      'call_b',
    ]);
  });
});

/** Project a folded agent state the way the store does, for plan tests. */
function projectChatEntries(state: AgentState): TimelineEntry[] {
  const store = makeStore();
  store.applyReset('main', {
    items: state.items,
    tasks: [...state.tasks.values()],
    interactions: [...state.interactions.values()],
    attachments: [...state.attachments.values()],
    todos: [...state.todos.values()],
    prompts: [...state.prompts.values()],
    meta: state.meta,
  });
  return [...store.getState().entries];
}
