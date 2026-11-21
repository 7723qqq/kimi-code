import { stubGlobals } from '../../vite-preset/test/globals';
import { rejectionOf } from '../../vite-preset/test/promises';
import { afterEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { DaemonHttpClient } from '../src/api/daemon/http';
import { DaemonEventSocket } from '../src/api/daemon/ws';
import type { CredentialStore, Tracer } from '../src/contracts';

const stubGlobal = stubGlobals();

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeClient(opts: {
  tracer?: Tracer;
  credentialStore?: CredentialStore;
  allowCodes?: number[];
}) {
  return new DaemonHttpClient({
    origin: 'http://test.local',
    identity,
    tracer: opts.tracer,
    credentialStore: opts.credentialStore,
  });
}

class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  static OPEN = 1;
  url: string;
  protocols: string[] | undefined;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

const noopHandlers = {
  onWireEvent: () => {},
  onInteraction: () => {},
  onInteractionsReset: () => {},
  onConnectionState: () => {},
  onError: () => {},
};

describe('DaemonHttpClient injection', () => {
  it('uses injected credentialStore for Authorization and tracer.restRequest', async () => {
    const fetchMock = mock()
      .mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    stubGlobal('fetch', fetchMock);
    const credentialStore: CredentialStore = {
      getToken: () => 'tok_abc',
      markAuthRequired: mock(),
    };
    const tracer: Tracer = { restRequest: mock(), restFailure: mock() };
    const client = makeClient({ tracer, credentialStore });

    await client.get('/api/v1/meta');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(tracer.restRequest).toHaveBeenCalledTimes(1);
  });

  it('traces request and response headers with the bearer token masked', async () => {
    stubGlobal('fetch', mock().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    })));
    const restRequest = mock();
    const restResponse = mock();
    const client = makeClient({ tracer: { restRequest, restResponse }, credentialStore: { getToken: () => 'tok_abc' } });

    await client.get('/api/v1/meta');

    expect(restRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer ***', 'X-Request-Id': expect.any(String) }),
    }));
    expect(restResponse).toHaveBeenCalledWith(expect.objectContaining({
      statusText: 'OK',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
    }));
  });

  it('traces the envelope details of a failed response', async () => {
    stubGlobal('fetch', mock().mockResolvedValue(new Response(JSON.stringify({
      code: 40401,
      msg: 'session not found',
      details: { session_id: 's1' },
    }), { status: 404 })));
    const restResponse = mock();
    const client = makeClient({ tracer: { restResponse } });

    expect(await rejectionOf(client.get('/sessions/s1'))).toMatchObject({ code: 40401 });
    expect(restResponse).toHaveBeenCalledWith(expect.objectContaining({ code: 40401, details: { session_id: 's1' } }));
  });

  it('omits Authorization when no credentialStore is provided', async () => {
    const fetchMock = mock()
      .mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});

    await client.get('/api/v1/meta');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('calls credentialStore.markAuthRequired on a 40101 envelope', async () => {
    const fetchMock = mock()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 40101, msg: 'unauthorized' }), { status: 200 }),
      );
    stubGlobal('fetch', fetchMock);
    const markAuthRequired = mock();
    const credentialStore: CredentialStore = { getToken: () => 'tok_abc', markAuthRequired };
    const client = makeClient({ credentialStore, allowCodes: [40101] });

    await client.post('/api/v1/sessions', {}, { allowCodes: [40101] }).catch(() => {});

    expect(markAuthRequired).toHaveBeenCalled();
  });
});

describe('DaemonEventSocket injection', () => {
  it('sends the bearer subprotocol from the injected credentialStore', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const credentialStore: CredentialStore = { getToken: () => 'ws_tok' };
    const tracer: Tracer = { wsEvent: mock() };
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
      tracer,
      credentialStore,
    });

    socket.connect();

    expect(FakeWebSocket.last?.protocols).toEqual(['kimi-code.bearer.ws_tok']);
  });

  it('sends nothing when the socket opens', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    expect(ws.sent).toEqual([]);
  });

  it('adds agents to a session’s conversation subscription and detaches one', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});
    ws.sent = [];

    socket.subscribeConversation('s1', 'agent-a');
    socket.subscribeConversation('s1', 'agent-b');
    socket.unsubscribeConversation('s1', ['agent-b']);

    expect(ws.sent).toEqual([
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a'] }),
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a', 'agent-b'] }),
      expect.objectContaining({ type: 'unsubscribe', session_id: 's1', agent_ids: ['agent-b'] }),
    ]);
  });

  it('resends every subscribed agent on reconnect', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    let ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    socket.subscribeConversation('s1', 'agent-a');
    socket.subscribeConversation('s1', 'agent-b');

    socket.reconnect();
    ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a', 'agent-b'] }),
    );
  });

  it('routes agent, usage, goal and todo frames to the agent feed handler', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const onAgentFeedFrame = mock();
    const onEvent = mock();
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: { ...noopHandlers, onEvent, onAgentFeedFrame },
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    const base = { session_id: 's1', agent_id: 'main', event_created_at: '2026-01-01T00:00:00.000Z' };
    const frames = [
      {
        type: 'agent',
        ...base,
        status: 'running',
        model: 'k2',
        plan_mode: true,
        swarm_mode: false,
        tower_mode: false,
      },
      { type: 'context', ...base, context_tokens: 10, max_context_tokens: 100 },
      { type: 'goal', ...base },
      { type: 'todo', ...base, items: [{ title: 'ship', status: 'pending' }] },
    ];
    for (const frame of frames) ws.onmessage?.({ data: JSON.stringify(frame) });

    expect(onAgentFeedFrame.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('routes conversation frames of subscribed agents outside the legacy event classifier', () => {
    stubGlobal('WebSocket', FakeWebSocket);
    const onConversation = mock();
    const onEvent = mock();
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: { ...noopHandlers, onEvent, onConversation },
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    socket.subscribeConversation('s1', 'agent-a');
    const base = { session_id: 's1', event_created_at: '2026-01-01T00:00:00.000Z' };
    const turns = { type: 'turns', ...base, agent_id: 'agent-a', turns: [], has_more: false };
    const delta = { type: 'item.delta', ...base, agent_id: 'agent-a', turn_id: 't0', item_id: 'i1', field: 'text', delta: 'hi' };
    const updated = { type: 'turn.updated', ...base, agent_id: 'agent-a', turn_id: 't0' };
    const unsubscribed = { type: 'turns', ...base, agent_id: 'agent-b', turns: [], has_more: false };
    const removed = { type: 'turns.removed', ...base, agent_id: 'agent-a', turn_ids: ['t0'] };
    for (const frame of [turns, delta, updated, unsubscribed, removed]) ws.onmessage?.({ data: JSON.stringify(frame) });

    expect(onConversation.mock.calls).toEqual([
      ['s1', 'agent-a', turns],
      ['s1', 'agent-a', delta],
      ['s1', 'agent-a', updated],
      ['s1', 'agent-a', removed],
    ]);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('DaemonHttpClient.getBlob maxBytes', () => {
  it('rejects at the Content-Length header and cancels the body stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = mock().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-length': String(20 * 1024 * 1024), 'content-type': 'application/json' },
      }),
    );
    stubGlobal('fetch', fetchMock);
    const restResponse = mock();
    const client = makeClient({ tracer: { restResponse } });

    expect(await rejectionOf(client.getBlob('/fs:content', { path: '/big.log' }, { maxBytes: 10_485_760 }))).toMatchObject({ name: 'FileTooLargeError', limit: 10_485_760 });
    expect(cancelled).toBe(true);
    expect(restResponse).toHaveBeenCalledTimes(1);
  });

  it('returns the blob when the Content-Length is within the cap', async () => {
    const fetchMock = mock().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-length': '3' },
      }),
    );
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/small.txt' }, { maxBytes: 10 });
    expect(blob.size).toBe(3);
  });
});

describe('DaemonHttpClient.getBlob error envelopes', () => {
  it('rejects a structured error envelope returned with HTTP 200', async () => {
    let responseRequestId = '';
    stubGlobal('fetch', mock().mockImplementation((_url, init) => {
      responseRequestId = init.headers['X-Request-Id'] as string;
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8', 'content-length': String(body.length) },
      }));
    }));
    const client = makeClient({});

    expect(await rejectionOf(client.getBlob('/fs:content', { path: '/missing.png' }))).toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      message: 'path not found',
      requestId: responseRequestId,
    });
    expect(responseRequestId).not.toBe('');
  });

  it('rejects a chunked error envelope without Content-Length', async () => {
    let responseRequestId = '';
    stubGlobal('fetch', mock().mockImplementation((_url, init) => {
      responseRequestId = init.headers['X-Request-Id'] as string;
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8' },
      }));
    }));
    const client = makeClient({});

    expect(await rejectionOf(client.getBlob('/fs:content', { path: '/missing.png' }))).toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      requestId: responseRequestId,
    });
  });

  it('returns a large chunked JSON file without waiting for the clone cancellation', async () => {
    const content = `{"data":"${'x'.repeat(70 * 1024)}"}`;
    stubGlobal('fetch', mock().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/large.json' });
    expect(blob.size).toBe(content.length);
    expect(await blob.text()).toBe(content);
  });

  it('does not reject ordinary JSON file content', async () => {
    const content = JSON.stringify({ code: 40409, msg: 'domain value', data: null, request_id: 'document' });
    stubGlobal('fetch', mock().mockResolvedValue(new Response(content, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/document.json' });
    expect(await blob.text()).toBe(content);
  });
});

function jsonResponse(data: unknown = null): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    headers: { 'content-type': 'application/json' },
  });
}

function streamingResponse(): {
  response: Response;
  finish: (data?: unknown) => void;
  fail: (error: unknown) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'application/json' } }),
    finish(data = null) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 0, msg: '', data })));
      controller.close();
    },
    fail(error) { controller.error(error); },
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushRequests(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('DaemonHttpClient background requests', () => {
  afterEach(() => {
    jest.useRealTimers();
    mock.restore();
    stubGlobal.restore();
  });

  it('holds two slots through response bodies and admits the remaining requests FIFO', async () => {
    const firstBody = streamingResponse();
    const secondBody = streamingResponse();
    const thirdBody = streamingResponse();
    const fetchMock = mock()
      .mockResolvedValueOnce(firstBody.response)
      .mockResolvedValueOnce(secondBody.response)
      .mockResolvedValueOnce(thirdBody.response)
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    stubGlobal('fetch', fetchMock);
    const tracer = { restRequest: mock(), restResponse: mock(), restFailure: mock() };
    const client = makeClient({ tracer });
    const controller = new AbortController();
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true });
    const cancelled = client.get('/cancelled', undefined, { background: true, signal: controller.signal });
    const cancellation = rejectionOf(cancelled).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    const fifth = client.get('/fifth', undefined, { background: true });
    await flushRequests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tracer.restResponse).not.toHaveBeenCalled();

    controller.abort();
    await cancellation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    firstBody.finish('first');
    expect(await first).toBe('first');
    await flushRequests();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/first', '/api/v1/second', '/api/v1/third',
    ]);

    secondBody.finish('second');
    await second;
    await flushRequests();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/first', '/api/v1/second', '/api/v1/third', '/api/v1/fifth',
    ]);
    thirdBody.finish('third');
    await Promise.all([third, fifth]);
    expect(tracer.restRequest).toHaveBeenCalledTimes(4);
    expect(tracer.restResponse).toHaveBeenCalledTimes(4);
    expect(tracer.restFailure).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'timeout', 'http', 'auth', 'json', 'body'] as const)(
    'releases the slot after a %s failure without changing the error contract',
    async (kind) => {
      const response = deferredResponse();
      const blockedBody = streamingResponse();
      const brokenBody = streamingResponse();
      const fetchMock = mock()
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValueOnce(blockedBody.response)
        .mockImplementation(() => Promise.resolve(jsonResponse('next')));
      stubGlobal('fetch', fetchMock);
      const markAuthRequired = mock();
      const client = makeClient({ credentialStore: { getToken: () => 'token', markAuthRequired } });
      const first = client.get('/failure', undefined, { background: true }).catch((error: unknown) => error);
      const second = client.get('/blocked', undefined, { background: true });
      const third = client.get('/next', undefined, { background: true });
      await flushRequests();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      if (kind === 'fetch') response.reject(new TypeError('fetch failed'));
      else if (kind === 'timeout') response.reject(new DOMException('timed out', 'TimeoutError'));
      else if (kind === 'http') response.resolve(new Response(JSON.stringify({ msg: 'failed' }), { status: 503 }));
      else if (kind === 'auth') response.resolve(new Response(JSON.stringify({ code: 40101, msg: 'unauthorized' }), { status: 401 }));
      else if (kind === 'json') response.resolve(new Response('not JSON'));
      else {
        response.resolve(brokenBody.response);
        await flushRequests();
        brokenBody.fail(new TypeError('body failed'));
      }

      const error = await first;
      if (kind === 'http' || kind === 'auth') {
        expect(error).toMatchObject({ name: 'DaemonApiError', code: kind === 'auth' ? 40101 : 503 });
      } else {
        expect(error).toMatchObject({
          name: 'DaemonNetworkError',
          phase: kind === 'json' || kind === 'body' ? 'parse' : 'fetch',
        });
      }
      if (kind === 'json') expect(error).toMatchObject({ bodyPreview: 'not JSON' });
      expect(markAuthRequired).toHaveBeenCalledTimes(kind === 'auth' ? 1 : 0);
      expect(await third).toBe('next');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      blockedBody.finish();
      await second;
    },
  );

  it.each(['fetch', 'body'] as const)('releases a caller-aborted %s request with an abort trace instead of a failure trace', async (phase) => {
    const body = streamingResponse();
    const blockedBody = streamingResponse();
    const controller = new AbortController();
    const fetchMock = mock()
      .mockImplementationOnce((_url, init: RequestInit) => {
        if (phase === 'body') {
          init.signal?.addEventListener('abort', () => body.fail(init.signal?.reason), { once: true });
          return Promise.resolve(body.response);
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      })
      .mockResolvedValueOnce(blockedBody.response)
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    stubGlobal('fetch', fetchMock);
    const tracer = { restFailure: mock(), restAbort: mock() };
    const client = makeClient({ tracer });
    const request = client.get('/abort', undefined, { background: true, signal: controller.signal });
    const assertion = rejectionOf(request).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    const blocked = client.get('/blocked', undefined, { background: true });
    const next = client.get('/next', undefined, { background: true });
    await flushRequests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    await assertion;
    await next;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    expect(tracer.restAbort).toHaveBeenCalledTimes(1);
    expect(tracer.restAbort).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/abort' }));
    blockedBody.finish();
    await blocked;
  });

  it('does not fetch pre-aborted requests or requests aborted between admission and fetch', async () => {
    const fetchMock = mock().mockImplementation(() => Promise.resolve(jsonResponse()));
    stubGlobal('fetch', fetchMock);
    const tracer = { restFailure: mock(), restAbort: mock() };
    const client = makeClient({ tracer });
    const preAborted = new AbortController();
    preAborted.abort();
    expect(await rejectionOf(client.get('/pre-aborted', undefined, { background: true, signal: preAborted.signal }))).toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    const request = client.get('/admitted', undefined, { background: true, signal: controller.signal });
    controller.abort();
    expect(await rejectionOf(request)).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 3 }, () => client.get('/next', undefined, { background: true })));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    expect(tracer.restAbort).not.toHaveBeenCalled();
  });

  it('starts the network timeout after admission and traces queue wait separately', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const fetchMock = mock()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    stubGlobal('fetch', fetchMock);
    const tracer = { restRequest: mock(), restResponse: mock(), restFailure: mock() };
    const client = makeClient({ tracer });
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true, timeoutMs: 20 }).catch((error: unknown) => error);
    await flushRequests();
    expect(timeout).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(2);

    firstResponse.resolve(jsonResponse());
    await first;
    await flushRequests();
    expect(timeout).toHaveBeenLastCalledWith(20);
    expect(tracer.restRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/third', queueMs: 100 }));
    jest.advanceTimersByTime(19);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(await third).toMatchObject({ name: 'DaemonNetworkError', timeoutMs: 20, durationMs: 20 });
    expect(tracer.restFailure).toHaveBeenCalledTimes(1);
    expect(tracer.restFailure).toHaveBeenCalledWith(expect.objectContaining({ queueMs: 100, durationMs: 20 }));
    secondResponse.resolve(jsonResponse());
    await second;
  });

  it('settles pending requests on dispose, lets sent requests finish, and rejects later JSON requests', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const fetchMock = mock()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true });
    const fourth = client.get('/fourth', undefined, { background: true });
    const assertion = rejectionOf(Promise.all([third, fourth])).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    await flushRequests();
    client.dispose();
    client.dispose();
    await assertion;
    expect(await rejectionOf(client.get('/later', undefined, { background: true }))).toMatchObject({ name: 'AbortError' });
    expect(await rejectionOf(client.post('/later'))).toMatchObject({ name: 'AbortError' });
    firstResponse.resolve(jsonResponse('first'));
    secondResponse.resolve(jsonResponse('second'));
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when disposed between admission and fetch', async () => {
    const fetchMock = mock();
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const request = client.get('/admitted', undefined, { background: true });
    client.dispose();
    expect(await rejectionOf(request)).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves blob, ZIP and form fetches outside the JSON request budget', async () => {
    const firstBody = streamingResponse();
    const secondBody = streamingResponse();
    const fetchMock = mock()
      .mockResolvedValueOnce(firstBody.response)
      .mockResolvedValueOnce(secondBody.response)
      .mockResolvedValueOnce(new Response('image'))
      .mockResolvedValueOnce(new Response('zip', { headers: { 'content-type': 'application/zip' } }))
      .mockResolvedValueOnce(jsonResponse('uploaded'));
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    await flushRequests();
    const blob = client.getBlob('/blob');
    const zip = client.postZip('/export', {}, {});
    const form = client.postForm('/upload', new FormData());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((await blob).size).toBe(5);
    expect((await zip).blob.size).toBe(3);
    expect(await form).toBe('uploaded');
    firstBody.finish();
    secondBody.finish();
    await Promise.all([first, second]);
  });

  it('preserves 204 responses, allowed envelope errors and wire query parameters', async () => {
    const fetchMock = mock()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40903, data: { aborted: false } })));
    stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    expect(await client.get('/empty', { page_size: 10, id: ['a', 'b'] }, { background: true })).toBeNull();
    expect(await client.post('/abort', {}, { background: true, allowCodes: [40903] })).toEqual({ aborted: false });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://test.local/api/v1/empty?page_size=10&id=a&id=b');
  });
});
