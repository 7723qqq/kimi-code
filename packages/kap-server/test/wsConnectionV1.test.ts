import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { WebSocket } from 'ws';

import type { IConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import type { SessionEventBroadcaster } from '../src/transport/ws/v1/sessionEventBroadcaster';
import type { TaskSource } from '../src/transport/ws/v1/taskRequests';
import {
  type WsConnectionV1Options,
  WsConnectionV1,
  coalesceFrames,
} from '../src/transport/ws/v1/wsConnectionV1';
import { createFakeClock, type FakeClock } from './helpers/fakeClock';
import { waitForAssertion } from './helpers/waitFor';

class FakeSocket {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = this.CLOSED;
    this.emit('close');
  }

  emit(event: string, ...a: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...a);
  }

  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeBroadcaster(): SessionEventBroadcaster {
  return {
    subscribe: async () => true,
    flushTranscriptSeed: async () => {},
    addGlobalTarget: () => {},
    removeGlobalTarget: () => {},
    sendPendingInteractions: () => {},
  } as unknown as SessionEventBroadcaster;
}

function makeRegistry(): IConnectionRegistry {
  return {
    add: () => {},
    remove: () => {},
    get: () => undefined,
    values: () => [],
    closeAll: () => {},
    size: () => 0,
  };
}

function makeTaskSource(): TaskSource {
  return async () => ({ kind: 'task_not_found' });
}

function makeConn(socket: FakeSocket, opts: Partial<WsConnectionV1Options> = {}): WsConnectionV1 {
  return new WsConnectionV1({
    socket: socket as unknown as WebSocket,
    broadcaster: makeBroadcaster(),
    taskSource: makeTaskSource(),
    connectionRegistry: makeRegistry(),
    remoteAddress: null,
    userAgent: null,
    ...opts,
  });
}

function delta(
  sessionId: string,
  agentId: string,
  turnId: number,
  text: string,
  offset: number,
  type: 'assistant.delta' | 'thinking.delta' = 'assistant.delta',
) {
  return {
    type,
    seq: 1,
    volatile: true as const,
    offset,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId, sessionId, turnId, delta: text },
  };
}

function durable(type: string, sessionId: string, seq: number) {
  return {
    type,
    seq,
    session_id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type, agentId: 'main', sessionId },
  };
}

describe('coalesceFrames', () => {
  it('merges adjacent compatible assistant deltas', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'Hello', 0),
      delta('s1', 'main', 1, ' ', 5),
      delta('s1', 'main', 1, 'world', 6),
    ]);
    expect(out).toHaveLength(1);
    const f = out[0] as {
      offset: number;
      volatile: boolean;
      seq: number;
      payload: { delta: string };
    };
    expect(f.payload.delta).toBe('Hello world');
    expect(f.offset).toBe(0);
    expect(f.volatile).toBe(true);
    expect(f.seq).toBe(1);
  });

  it('does not merge across a durable frame', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'a', 0),
      durable('turn.ended', 's1', 2),
      delta('s1', 'main', 1, 'b', 1),
    ]);
    expect(out).toHaveLength(3);
    expect((out[0] as { payload: { delta: string } }).payload.delta).toBe('a');
    expect((out[1] as { type: string }).type).toBe('turn.ended');
    expect((out[2] as { payload: { delta: string } }).payload.delta).toBe('b');
  });

  it('does not merge different delta types', () => {
    const out = coalesceFrames([
      delta('s1', 'main', 1, 'hi', 0, 'assistant.delta'),
      delta('s1', 'main', 1, 'think', 0, 'thinking.delta'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge deltas from different sessions / agents / turns', () => {
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s2', 'main', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'sub', 1, 'b', 0)]),
    ).toHaveLength(2);
    expect(
      coalesceFrames([delta('s1', 'main', 1, 'a', 0), delta('s1', 'main', 2, 'b', 0)]),
    ).toHaveLength(2);
  });

  it('leaves non-volatile and non-text frames untouched', () => {
    const toolCallDelta = {
      type: 'tool.call.delta',
      seq: 1,
      volatile: true as const,
      session_id: 's1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { type: 'tool.call.delta', agentId: 'main', turnId: 1, args: { x: 1 } },
    };
    expect(coalesceFrames([toolCallDelta, toolCallDelta])).toHaveLength(2);
  });

  it('does not mutate the input frames', () => {
    const a = delta('s1', 'main', 1, 'a', 0);
    const b = delta('s1', 'main', 1, 'b', 1);
    const out = coalesceFrames([a, b]);
    expect(out).toHaveLength(1);
    expect(a.payload.delta).toBe('a');
    expect(b.payload.delta).toBe('b');
  });

  it('handles empty and single-element input', () => {
    expect(coalesceFrames([])).toEqual([]);
    const only = delta('s1', 'main', 1, 'x', 0);
    const out = coalesceFrames([only]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(only);
  });
});

describe('WsConnectionV1 transcript subscriptions (subscribe_v2)', () => {
  interface SubscribeCall {
    sessionId: string;
    filter: unknown;
    grades: unknown;
    opts?: { transcriptSince?: Record<string, number> };
  }

  function makeCapturingBroadcaster(): {
    broadcaster: SessionEventBroadcaster;
    calls: SubscribeCall[];
    detaches: { sessionId: string; agentIds?: readonly string[] }[];
  } {
    const calls: SubscribeCall[] = [];
    const detaches: { sessionId: string; agentIds?: readonly string[] }[] = [];
    const broadcaster = {
      subscribe: async (
        sessionId: string,
        _target: unknown,
        filter: unknown,
        grades: unknown,
        opts?: { transcriptSince?: Record<string, number> },
      ) => {
        calls.push({ sessionId, filter, grades, opts });
        return true;
      },
      unsubscribeTranscript: (
        sessionId: string,
        _target: unknown,
        agentIds?: readonly string[],
      ) => {
        detaches.push({ sessionId, agentIds });
      },
      flushTranscriptSeed: async () => {},
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
      sendPendingInteractions: () => {},
    } as unknown as SessionEventBroadcaster;
    return { broadcaster, calls, detaches };
  }

  function controlFrame(type: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ type, id: 'req-1', payload });
  }

  it('sends the pending interactions of each accepted session right after the ack', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.sendPendingInteractions = (sessionId, target) => {
      target.send(
        {
          type: 'interaction',
          session_id: sessionId,
          agent_id: 'main',
          event_created_at: new Date(0).toISOString(),
          interaction_id: 'q1',
          status: 'pending',
          kind: 'question',
          request: { questions: [{ id: 'q_0', question: 'Pick', options: [] }] },
        },
        'immediate',
      );
    };
    const conn = makeConn(socket, { broadcaster });
    const types = () =>
      (socket.frames() as { type: string }[])
        .map((f) => f.type)
        .filter((type) => type !== 'server_hello');

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'block' } }),
    );
    await waitForAssertion(() => expect(types()).toEqual(['ack', 'interaction']));

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'delta' } }),
    );
    await waitForAssertion(() =>
      expect(types()).toEqual(['ack', 'interaction', 'ack', 'interaction']),
    );
    conn.close();
  });

  it('forwards subscribe_v2 grades and transcript_since to the broadcaster and stores them per session', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { '*': 'delta' },
        transcript_since: { main: 7, '*': 3 },
      }),
    );
    await waitForAssertion(() => expect(calls).toHaveLength(1));

    expect(calls[0]).toMatchObject({
      sessionId: 's1',
      grades: { '*': 'delta' },
      opts: { transcriptSince: { main: 7, '*': 3 } },
    });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: { '*': 'delta' },
    });
    await waitForAssertion(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'], not_found: [] } });
    conn.close();
  });



  it('acks (and logs) when a control-frame task rejects instead of leaving the client waiting', async () => {
    const socket = new FakeSocket();
    const errors: unknown[] = [];
    const broadcaster = Object.assign(makeBroadcaster(), {
      subscribe: async () => {
        throw new Error('subscribe exploded');
      },
    }) as unknown as SessionEventBroadcaster;
    const conn = makeConn(socket, {
      broadcaster,
      logger: { error: (...args: unknown[]) => errors.push(args), warn: () => {} } as never,
    });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'block' } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const acks = (socket.frames() as Array<{ type: string; code?: number; id?: string }>).filter(
      (frame) => frame.type === 'ack',
    );
    expect(acks.length).toBeGreaterThan(0);
    expect(acks.at(-1)?.code).toBe(1);
    expect(acks.at(-1)?.id).toBe('req-1');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('acks an invalid subscribe_v2 payload with an error and does not attach', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', {
        session_id: 's1',
        transcript: { main: 'everything' },
      }),
    );
    await waitForAssertion(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(conn.subscriptions.size).toBe(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack.code).toBe(1);
    conn.close();
  });


  it('keeps subscribe_v2 grades across a repeated subscribe_v2', async () => {
    const socket = new FakeSocket();
    let seenGrades: unknown;
    const broadcaster = {
      subscribe: async (
        _sid: string,
        target: { send: (e: unknown) => void },
        _filter: unknown,
        grades: unknown,
      ) => {
        seenGrades = grades;
        target.send({ type: 'transcript.reset', session_id: 's1', payload: {} });
        return true;
      },
      flushTranscriptSeed: async () => {},
      addGlobalTarget: () => {},
      removeGlobalTarget: () => {},
    } as unknown as SessionEventBroadcaster;
    const conn = makeConn(socket, { broadcaster, flushIntervalMs: 1 });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await waitForAssertion(() => expect(seenGrades).toEqual({ '*': 'delta' }));

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await waitForAssertion(() => expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }));
    expect(seenGrades).toEqual({ '*': 'delta' });
    conn.close();
  });

  it('reports an unknown session in the subscribe_v2 ack not_found list', async () => {
    const socket = new FakeSocket();
    const { broadcaster } = makeCapturingBroadcaster();
    broadcaster.subscribe = async () => false;
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 'gone', transcript: { '*': 'delta' } }),
    );
    await waitForAssertion(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: [], not_found: ['gone'] } });
    expect(conn.subscriptions.size).toBe(0);
    conn.close();
  });


  it('unsubscribe_v2 without agent_ids detaches the whole transcript stream', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    await waitForAssertion(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ '*': 'delta' }),
    );

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await waitForAssertion(() => expect(detaches).toHaveLength(1));

    expect(detaches[0]).toEqual({ sessionId: 's1', agentIds: undefined });
    expect(conn.subscriptions.get('s1')).toEqual({
      agentFilter: undefined,
      transcriptGrades: undefined,
    });
    conn.close();
  });

  it('unsubscribe_v2 is idempotent for an unsubscribed session and never touches the broadcaster', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await waitForAssertion(() =>
      expect(socket.sent.some((f) => JSON.parse(f).type === 'ack')).toBe(true),
    );

    expect(calls).toHaveLength(0);
    expect(detaches).toHaveLength(0);
    const ack = socket.sent.map((f) => JSON.parse(f)).find((f) => f.type === 'ack');
    expect(ack).toMatchObject({ code: 0, payload: { accepted: ['s1'] } });
    conn.close();
  });

  it('acks an invalid unsubscribe_v2 payload with an error', async () => {
    const socket = new FakeSocket();
    const { broadcaster, detaches } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit('message', controlFrame('unsubscribe_v2', { agent_ids: ['main'] }));
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1', agent_ids: [] }));
    await waitForAssertion(() =>
      expect(socket.sent.filter((f) => JSON.parse(f).type === 'ack')).toHaveLength(2),
    );

    expect(detaches).toHaveLength(0);
    const acks = socket.sent.map((f) => JSON.parse(f)).filter((f) => f.type === 'ack');
    expect(acks.every((a) => a.code === 1)).toBe(true);
    conn.close();
  });


  it('re-subscribes an agent at full grade after it was detached', async () => {
    const socket = new FakeSocket();
    const { broadcaster, calls } = makeCapturingBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { '*': 'delta' } }),
    );
    socket.emit('message', controlFrame('unsubscribe_v2', { session_id: 's1' }));
    await waitForAssertion(() =>
      expect(conn.subscriptions.get('s1')?.transcriptGrades).toBeUndefined(),
    );

    socket.emit(
      'message',
      controlFrame('subscribe_v2', { session_id: 's1', transcript: { main: 'turn' } }),
    );
    await waitForAssertion(() => expect(calls).toHaveLength(2));

    expect(calls[1]).toMatchObject({ sessionId: 's1', grades: { main: 'turn' } });
    expect(conn.subscriptions.get('s1')?.transcriptGrades).toEqual({ main: 'turn' });
    conn.close();
  });
});

describe('WsConnectionV1 outbound buffer', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = createFakeClock();
  });

  it('sends server_hello immediately', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 16 });
    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual(['server_hello']);
    conn.close();
  });

  it('buffers subscribe_v2 transcript frames without merging them', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(durable('transcript.reset', 's1', 7));
    conn.send(durable('transcript.ops', 's1', 8));
    expect(socket.sent).toHaveLength(0);
    await clock.advanceAsync(15);
    expect(socket.sent).toHaveLength(0);
    await clock.advanceAsync(1);

    const frames = socket.frames() as Array<{ type: string; seq: number }>;
    expect(frames.map((frame) => frame.type)).toEqual(['transcript.reset', 'transcript.ops']);
    expect(frames.map((frame) => frame.seq)).toEqual([7, 8]);
    conn.close();
  });

  it('coalesces adjacent subscribed deltas into one socket.send', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    conn.send(delta('s1', 'main', 1, ' ', 5));
    conn.send(delta('s1', 'main', 1, 'world', 6));
    expect(socket.sent).toHaveLength(0);
    await clock.advanceAsync(16);

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    const f = frames[0] as { type: string; offset: number; payload: { delta: string } };
    expect(f.type).toBe('assistant.delta');
    expect(f.offset).toBe(0);
    expect(f.payload.delta).toBe('Hello world');
    conn.close();
  });

  it('sends public events immediately and preserves FIFO with subscribed events', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 16 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'before', 0));
    expect(socket.sent).toHaveLength(0);
    conn.send(durable('event.session.work_changed', 's1', 2), 'immediate');

    expect(socket.frames().map((f) => (f as { type: string }).type)).toEqual([
      'assistant.delta',
      'event.session.work_changed',
    ]);
    await clock.advanceAsync(16);
    expect(socket.sent).toHaveLength(2);
    conn.close();
  });

  it('flushes immediately once the subscribed batch reaches maxBatchSize', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 1000, maxBatchSize: 3 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'a', 0));
    conn.send(delta('s1', 'main', 1, 'b', 1));
    conn.send(delta('s1', 'main', 1, 'c', 2));

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('abc');
    conn.close();
  });

  it('defers flushing while the peer is above the watermark, then coalesces on drain', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, {
      clock,
      flushIntervalMs: 16,
      highWaterMarkBytes: 100,
    });
    socket.sent = [];

    socket.bufferedAmount = 200;
    conn.send(delta('s1', 'main', 1, 'Hello', 0));
    await clock.advanceAsync(16);
    expect(socket.sent).toHaveLength(0);

    conn.send(delta('s1', 'main', 1, ' world', 5));
    await clock.advanceAsync(5);
    expect(socket.sent).toHaveLength(0);

    socket.bufferedAmount = 0;
    await clock.advanceAsync(5);
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('Hello world');
    conn.close();
  });

  it('force-flushes buffered subscription frames on close', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 1000 });
    socket.sent = [];

    conn.send(delta('s1', 'main', 1, 'tail', 0));
    expect(socket.sent).toHaveLength(0);

    conn.close();
    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    expect((frames[0] as { payload: { delta: string } }).payload.delta).toBe('tail');
  });

  it('drops buffered frames when the socket is already closed at flush time', async () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, flushIntervalMs: 16 });
    socket.sent = [];

    socket.readyState = socket.CLOSED;
    conn.send(delta('s1', 'main', 1, 'lost', 0));
    await clock.advanceAsync(16);
    expect(socket.sent).toHaveLength(0);
  });
});

describe('WsConnectionV1 heartbeat', () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = createFakeClock();
  });

  function sentTypes(socket: FakeSocket): string[] {
    return socket.frames().map((f) => (f as { type: string }).type);
  }

  function sentPings(socket: FakeSocket): Array<{ type: string; payload: { nonce: string } }> {
    return socket.frames() as Array<{ type: string; payload: { nonce: string } }>;
  }

  it('advertises the heartbeat interval in server_hello', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, heartbeatIntervalMs: 10 });
    const hello = socket.frames()[0] as { type: string; payload: { heartbeat_ms?: number } };
    expect(hello.type).toBe('server_hello');
    expect(hello.payload.heartbeat_ms).toBe(10);
    conn.close();
  });

  it('defaults to a 10s heartbeat interval', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock });
    const hello = socket.frames()[0] as { payload: { heartbeat_ms?: number } };
    expect(hello.payload.heartbeat_ms).toBe(10_000);
    conn.close();
  });

  it('sends a ping every interval while the peer keeps answering', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, heartbeatIntervalMs: 10 });
    socket.sent = [];

    for (let i = 0; i < 3; i++) {
      clock.advance(10);
      expect(sentTypes(socket)).toHaveLength(i + 1);
      socket.emit('message', JSON.stringify({ type: 'pong', payload: { nonce: 'n' } }));
    }

    const pings = sentPings(socket);
    expect(pings.every((f) => f.type === 'ping')).toBe(true);
    expect(typeof pings[0]!.payload.nonce).toBe('string');
    expect(new Set(pings.map((f) => f.payload.nonce)).size).toBe(3);
    expect(socket.closeCalls).toHaveLength(0);
    conn.close();
  });

  it('reaps the connection after two silent cycles', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, heartbeatIntervalMs: 10 });
    socket.sent = [];

    clock.advance(10);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);

    clock.advance(10);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
    expect(sentTypes(socket)).toEqual(['ping']);

    clock.advance(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('treats any inbound frame — not just pong — as proof of life', () => {
    const socket = new FakeSocket();
    const conn = makeConn(socket, { clock, heartbeatIntervalMs: 10 });
    socket.sent = [];

    clock.advance(15);
    socket.emit('message', JSON.stringify({ type: 'some_future_frame', payload: {} }));

    clock.advance(20);
    expect(sentTypes(socket)).toEqual(['ping', 'ping', 'ping']);
    expect(socket.closeCalls).toHaveLength(0);

    clock.advance(5);
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'heartbeat timeout' }]);
  });

  it('stops heartbeating once the socket closes on its own', () => {
    const socket = new FakeSocket();
    makeConn(socket, { clock, heartbeatIntervalMs: 10 });
    socket.sent = [];

    clock.advance(10);
    expect(sentTypes(socket)).toEqual(['ping']);

    socket.terminate();
    clock.advance(100);
    expect(sentTypes(socket)).toEqual(['ping']);
    expect(socket.closeCalls).toHaveLength(0);
  });
});

describe('WsConnectionV1 global target registration', () => {
  function makeGlobalTargetBroadcaster() {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const broadcaster = {
      subscribe: async () => true,
      addGlobalTarget: (target: unknown) => added.push(target),
      removeGlobalTarget: (target: unknown) => removed.push(target),
      sendPendingInteractions: () => {},
    } as unknown as SessionEventBroadcaster;
    return { broadcaster, added, removed };
  }

  it('registers the connection as a global target on construction and unregisters on close', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });

    expect(added).toEqual([conn]);
    expect(removed).toEqual([]);

    conn.close();
    expect(removed).toEqual([conn]);
  });

  it('unregisters when the socket closes on its own', () => {
    const socket = new FakeSocket();
    const { broadcaster, added, removed } = makeGlobalTargetBroadcaster();
    const conn = makeConn(socket, { broadcaster });
    expect(added).toEqual([conn]);

    socket.emit('close');
    expect(removed).toEqual([conn]);
  });

});
