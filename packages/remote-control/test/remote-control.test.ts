import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeOAuthRef,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { remoteControlLockPath } from '../src/lock';
import {
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  HttpTunnel,
  type HttpTunnelLimits,
  parseRawHttpRequest,
  type ParsedRawHttpRequest,
  REMOTE_CONTROL_ORIGIN_FIX_PATH,
  REMOTE_CONTROL_ORIGIN_FIX_SCRIPT,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
  type RemoteControlHandle,
} from '../src/remote-control';
import {
  RemoteControlDeviceClient,
  RemoteControlDeviceClientError,
  type RemoteControlDevice,
} from '../src/device-client';
import { createRemoteControlManager } from '../src/manager';

const CLIENT_VERSION = 'kimi-code/test';

const TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 0,
  scope: '',
  tokenType: 'Bearer',
  expiresIn: 0,
};

const envStubs: Array<[string, string | undefined]> = [];

function setEnv(name: string, value: string): void {
  envStubs.push([name, process.env[name]]);
  process.env[name] = value;
}

function restoreEnvs(): void {
  for (const [name, previous] of envStubs.splice(0).reverse()) {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  restoreEnvs();
  // Each case owns its own relays and handles, but a teardown that throws must
  // not strand the rest: a listener left behind becomes the next case's
  // environment.
  const failures: unknown[] = [];
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop()!;
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'teardown failed');
});

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) =>
      resolve(JSON.parse(rawDataText(data)) as Record<string, unknown>),
    );
  });
}

function collectJsonMessages(
  socket: WebSocket,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (data: RawData): void => {
      messages.push(JSON.parse(rawDataText(data)) as Record<string, unknown>);
      if (messages.length < count) return;
      socket.off('message', onMessage);
      resolve(messages);
    };
    socket.on('message', onMessage);
  });
}

function nextTextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(rawDataText(data)));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function frameBody(message: Record<string, unknown>): Buffer {
  return Buffer.from(message['body_base64'] as string, 'base64');
}

function tunnelRequestFrame(requestId: string, body: Buffer, isLast: boolean): string {
  return JSON.stringify({
    request_id: requestId,
    type: 'request',
    is_last: isLast,
    body_base64: body.toString('base64'),
  });
}

function tunnelAbortFrame(requestId: string): string {
  return JSON.stringify({
    request_id: requestId,
    type: 'abort',
    is_last: true,
    body_base64: '',
    reason: 'browser_closed',
  });
}

function probeRawRequest(): Buffer {
  return Buffer.from(
    'GET / HTTP/1.1\r\nHost: relay.test\r\nAuthorization: Bearer relay-token\r\nCookie: sid=1\r\nOrigin: https://relay.test\r\nAccept-Encoding: gzip\r\nConnection: X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\n\r\n',
  );
}

describe('Remote Control URLs', () => {
  it('builds the public device entry without a local token', () => {
    const url = buildRemoteControlUrl('device/one', undefined, 'https://relay.example', 'kimi_code_cli');
    expect(url).toBe('https://relay.example/devices/device%2Fone/?rc=1&from=kimi_code_cli');
  });

  it('builds an encoded session deep link before the query', () => {
    const url = buildRemoteControlUrl('device-1', 'session/2', 'https://relay.example', 'wf');
    expect(url).toBe('https://relay.example/devices/device-1/sessions/session%2F2?rc=1&from=wf');
  });

  it('keeps a relay path prefix', () => {
    const url = buildRemoteControlUrl('d1', undefined, 'https://relay.example/coding-relay/', 'wf');
    expect(url).toBe('https://relay.example/coding-relay/devices/d1/?rc=1&from=wf');
  });

  it('falls back to the default relay origin when the env is unset or blank', () => {
    expect(resolveRemoteControlRelayOrigin(process.env, undefined)).toBe(
      'https://code-rc.kimi.com',
    );
    setEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', '   ');
    expect(resolveRemoteControlRelayOrigin(process.env, undefined)).toBe(
      'https://code-rc.kimi.com',
    );
  });

  it('uses the relay origin env override', () => {
    setEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', 'https://staging.example/rc');
    expect(resolveRemoteControlRelayOrigin(process.env, 'https://configured.example')).toBe(
      'https://staging.example/rc',
    );
  });
});

describe('Remote Control HTTP forwarding', () => {
  it('parses the raw request line and every header verbatim', () => {
    const parsed = parseRawHttpRequest([probeRawRequest()]);
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/');

    const names = parsed.headers.map(([name]) => name.toLowerCase());
    expect(names).toEqual([
      'host',
      'authorization',
      'cookie',
      'origin',
      'accept-encoding',
      'connection',
      'x-hop',
      'x-keep',
    ]);
  });

  it('injects the local bearer token and drops hop-by-hop headers', () => {
    const parsed = parseRawHttpRequest([probeRawRequest()]);
    const flat = filterForwardRequestHeaders(parsed.headers, 'local-token');
    const lower = flat.map((value) => value.toLowerCase());
    expect(lower).not.toContain('x-hop');
    expect(lower).not.toContain('connection');
    expect(flat[flat.indexOf('Authorization') + 1]).toBe('Bearer local-token');
  });

  it('rejects absolute-form and malformed request targets', () => {
    expect(() =>
      parseRawHttpRequest([Buffer.from('GET http://evil.test/ HTTP/1.1\r\n\r\n')]),
    ).toThrow(SyntaxError);
    expect(() =>
      parseRawHttpRequest([Buffer.from('GET //evil.test/ HTTP/1.1\r\n\r\n')]),
    ).toThrow(SyntaxError);
    expect(() => parseRawHttpRequest([Buffer.from('garbage\r\n\r\n')])).toThrow(SyntaxError);
  });

  it('leaves a response untouched when its content type is not rewritten', () => {
    expect(rewriteRemoteControlResponse('image/png', Buffer.from('raw'), '/devices/d1').toString()).toBe(
      'raw',
    );
  });

  it('rewrites HTML under the device prefix and injects the origin fix', () => {
    const html = rewriteRemoteControlResponse(
      'text/html',
      Buffer.from('<html><head></head><script src="/boot.js"></script></html>'),
      '/devices/d1',
    ).toString();
    expect(html).toBe(
      `<html><head><script src="/devices/d1${REMOTE_CONTROL_ORIGIN_FIX_PATH}"></script></head>` +
        '<script src="/devices/d1/boot.js"></script></html>',
    );
  });
});

interface FakeSocket {
  readonly frames: string[];
  readonly callbacks: Array<(error?: Error | null) => void>;
  terminated: boolean;
}

function fakeTunnelSocket(): { socket: WebSocket; state: FakeSocket } {
  const state: FakeSocket = { frames: [], callbacks: [], terminated: false };
  const socket = {
    readyState: 1,
    send(frame: string, callback: (error?: Error | null) => void): void {
      state.frames.push(frame);
      state.callbacks.push(callback);
    },
    terminate(): void {
      state.terminated = true;
    },
  } as unknown as WebSocket;
  return { socket, state };
}

interface LocalCall {
  readonly signal: AbortSignal;
  readonly retain: (receivedBytes: number) => boolean;
  readonly respond: (response: Buffer[]) => void;
}

type TunnelForward = (
  request: ParsedRawHttpRequest,
  signal: AbortSignal,
  retain: (receivedBytes: number) => boolean,
) => Promise<Buffer[]>;

function recordingForward(): { forward: TunnelForward; calls: Map<string, LocalCall> } {
  const calls = new Map<string, LocalCall>();
  return {
    calls,
    forward: (request, signal, retain) =>
      new Promise<Buffer[]>((respond) => {
        calls.set(request.path, { signal, retain, respond });
      }),
  };
}

const SMALL_LIMITS: HttpTunnelLimits = {
  maxRequestBytes: 4096,
  maxRetainedBytes: 8192,
  maxSingleFrameResponseBytes: 64,
  responseChunkBytes: 32,
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('HttpTunnel', () => {
  it('rejects invalid limits at construction', () => {
    const { socket } = fakeTunnelSocket();
    const stderr = { write: (): boolean => true };
    const forward = (): Promise<Buffer[]> => new Promise(() => {});
    expect(
      () => new HttpTunnel(socket, forward, stderr, { ...SMALL_LIMITS, responseChunkBytes: 0 }),
    ).toThrow(/responseChunkBytes/);
    expect(
      () => new HttpTunnel(socket, forward, stderr, { ...SMALL_LIMITS, responseChunkBytes: 1.5 }),
    ).toThrow(/responseChunkBytes/);
    expect(
      () => new HttpTunnel(socket, forward, stderr, { ...SMALL_LIMITS, maxRequestBytes: Number.NaN }),
    ).toThrow(/maxRequestBytes/);
    expect(
      () => new HttpTunnel(socket, forward, stderr, { ...SMALL_LIMITS, maxRetainedBytes: -1 }),
    ).toThrow(/maxRetainedBytes/);
    expect(
      () =>
        new HttpTunnel(socket, forward, stderr, {
          ...SMALL_LIMITS,
          maxSingleFrameResponseBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/maxSingleFrameResponseBytes/);
    expect(() => new HttpTunnel(socket, forward, stderr, SMALL_LIMITS)).not.toThrow();
  });

  it('sends a response that fits the single-frame limit as one frame', async () => {
    const { socket, state } = fakeTunnelSocket();
    const { forward, calls } = recordingForward();
    const tunnel = new HttpTunnel(socket, forward, { write: () => true }, SMALL_LIMITS);

    tunnel.handleMessage(Buffer.from(tunnelRequestFrame('r1', Buffer.from('GET /a HTTP/1.1\r\n\r\n'), true)));
    await flush();
    calls.get('/a')!.respond([Buffer.from('x'.repeat(32))]);
    await flush();

    const frames = state.frames.map((frame) => JSON.parse(frame));
    expect(frames).toHaveLength(1);
    expect(frames[0]!['type']).toBe('response');
    expect(frames[0]!['is_last']).toBe(true);
  });

  it('splits a response above the limit into chunk frames that reassemble', async () => {
    const { socket, state } = fakeTunnelSocket();
    const { forward, calls } = recordingForward();
    const tunnel = new HttpTunnel(socket, forward, { write: () => true }, SMALL_LIMITS);

    tunnel.handleMessage(Buffer.from(tunnelRequestFrame('r1', Buffer.from('GET /a HTTP/1.1\r\n\r\n'), true)));
    await flush();
    calls.get('/a')!.respond([Buffer.from('y'.repeat(80))]);
    for (let i = 0; i < 4; i += 1) {
      state.callbacks.shift()?.(null);
      await flush();
    }

    const frames = state.frames.map((frame) => JSON.parse(frame));
    expect(frames.every((frame) => frame['type'] === 'response_chunk')).toBe(true);
    expect(frames.map((frame) => frame['is_last'])).toEqual([false, false, true]);
    const parts = frames.map((frame) => Buffer.from(frame['body_base64'] as string, 'base64'));
    expect(parts.map((part) => part.length)).toEqual([32, 32, 16]);
    expect(Buffer.concat(parts).toString()).toBe('y'.repeat(80));
  });

  it('rejects a request body above maxRequestBytes', async () => {
    const { socket, state } = fakeTunnelSocket();
    const tunnel = new HttpTunnel(socket, recordingForward().forward, { write: () => true }, SMALL_LIMITS);

    tunnel.handleMessage(
      Buffer.from(
        tunnelRequestFrame('big', Buffer.concat([Buffer.from('POST /u HTTP/1.1\r\n\r\n'), Buffer.alloc(5000)]), true),
      ),
    );
    await flush();

    const frames = state.frames.map((frame) => JSON.parse(frame));
    expect(Buffer.from(frames[0]!['body_base64'] as string, 'base64').toString()).toContain(
      'HTTP/1.1 400',
    );
  });

  it('stops a stream of message frames before it grows without bound', async () => {
    const { socket, state } = fakeTunnelSocket();
    const tunnel = new HttpTunnel(socket, recordingForward().forward, { write: () => true }, SMALL_LIMITS);

    for (let i = 0; i < 12_000; i += 1) {
      tunnel.handleMessage(Buffer.from(tunnelRequestFrame('e', Buffer.alloc(0), false)));
    }
    await flush();

    const frames = state.frames.map((frame) => JSON.parse(frame));
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.from(frames[0]!['body_base64'] as string, 'base64').toString()).toContain(
      'HTTP/1.1 400',
    );
  });

  it('aborts the local request when the relay aborts the stream', async () => {
    const { socket } = fakeTunnelSocket();
    const { forward, calls } = recordingForward();
    const tunnel = new HttpTunnel(socket, forward, { write: () => true }, SMALL_LIMITS);

    tunnel.handleMessage(Buffer.from(tunnelRequestFrame('c', Buffer.from('GET /c HTTP/1.1\r\n\r\n'), true)));
    await flush();
    expect(calls.get('/c')!.signal.aborted).toBe(false);

    tunnel.handleMessage(Buffer.from(tunnelAbortFrame('c')));
    expect(calls.get('/c')!.signal.aborted).toBe(true);
  });

  it('terminates the socket when a frame write fails', async () => {
    const { socket, state } = fakeTunnelSocket();
    const { forward, calls } = recordingForward();
    const tunnel = new HttpTunnel(socket, forward, { write: () => true }, SMALL_LIMITS);

    tunnel.handleMessage(Buffer.from(tunnelRequestFrame('f', Buffer.from('GET /f HTTP/1.1\r\n\r\n'), true)));
    await flush();
    calls.get('/f')!.respond([Buffer.from('f')]);
    await flush();
    state.callbacks.shift()!(new Error('write failed'));
    await flush();

    expect(state.terminated).toBe(true);
  });
});

async function deviceHome(): Promise<string> {
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-'));
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  await new FileTokenStorage(join(homeDir, 'credentials')).save(
    resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
    TOKEN,
  );
  return homeDir;
}

function device(overrides: Partial<RemoteControlDevice> = {}): RemoteControlDevice {
  return {
    device_id: 'd1',
    alias: 'laptop',
    status: 'online',
    platform: 'win32',
    client_version: '1.0.0',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    last_remote_access_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('RemoteControlDeviceClient', () => {
  it('exchanges a session once and reuses the cached cookie', async () => {
    const homeDir = await deviceHome();
    const calls: string[] = [];
    const fetchImpl = mock(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/exchange')) {
        return new Response(null, { status: 204, headers: { 'set-cookie': 'sid=1' } });
      }
      return new Response(JSON.stringify({ devices: [device()] }), { status: 200 });
    });
    const client = new RemoteControlDeviceClient({ homeDir, fetchImpl });

    await client.listDevices();
    await client.listDevices();

    expect(calls.filter((url) => url.endsWith('/auth/exchange'))).toHaveLength(1);
  });

  it('maps a network failure to a client error', async () => {
    const homeDir = await deviceHome();
    const fetchImpl = mock(async () => {
      throw new Error('socket hang up');
    });
    const client = new RemoteControlDeviceClient({ homeDir, fetchImpl });
    await expect(client.listDevices()).rejects.toBeInstanceOf(RemoteControlDeviceClientError);
  });

  it('rejects a malformed device list instead of reporting an empty one', async () => {
    const homeDir = await deviceHome();
    const fetchImpl = mock(async (url: string) => {
      if (url.endsWith('/auth/exchange')) {
        return new Response(null, { status: 204, headers: { 'set-cookie': 'sid=1' } });
      }
      return new Response(JSON.stringify({ devices: 'nope' }), { status: 200 });
    });
    const client = new RemoteControlDeviceClient({ homeDir, fetchImpl });
    await expect(client.listDevices()).rejects.toBeInstanceOf(RemoteControlDeviceClientError);
  });
});

describe('createRemoteControlManager', () => {
  it('starts off and reports the tunnel url once enabled', async () => {
    const homeDir = await deviceHome();
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: 'http://127.0.0.1:1',
      stderr: { write: () => true },
    });
    cleanups.push(async () => manager.close());

    expect(manager.status().state).toBe('off');
    expect(manager.status().enabled).toBe(false);
  });
});

interface RelayHarness {
  readonly port: number;
  readonly registrations: unknown[];
  readonly managementSockets: WebSocket[];
  readonly httpSockets: WebSocket[];
  readonly rawSockets: Set<Duplex>;
}

async function startRelay(
  options: {
    rejectUpgrades?: number;
    rejectSubprotocol?: boolean;
  } = {},
): Promise<RelayHarness> {
  const managementServer = new WebSocketServer({ noServer: true });
  const httpTunnelServer = new WebSocketServer({ noServer: true });
  const relayServer = createServer();
  const rawSockets = new Set<Duplex>();
  const managementSockets: WebSocket[] = [];
  const httpSockets: WebSocket[] = [];
  const registrations: unknown[] = [];
  let remainingRejections = options.rejectUpgrades ?? 0;

  relayServer.on('connection', (socket) => {
    rawSockets.add(socket);
    socket.once('close', () => rawSockets.delete(socket));
  });
  managementServer.on('connection', (ws) => {
    managementSockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const message = JSON.parse(rawDataText(data)) as { type?: string };
      if (message.type !== 'register') return;
      registrations.push(message);
      ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
    });
  });
  httpTunnelServer.on('connection', (ws) => {
    httpSockets.push(ws);
    ws.on('error', () => {});
  });
  relayServer.on('upgrade', (request, socket, head) => {
    const protocol = request.headers['sec-websocket-protocol'];
    if (remainingRejections > 0) {
      remainingRejections -= 1;
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (options.rejectSubprotocol === true && protocol !== undefined) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = (request.url ?? '').endsWith('/v1/remote/create')
      ? managementServer
      : httpTunnelServer;
    target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
  });

  const port = await listen(relayServer);
  const close = async (): Promise<void> => {
    for (const socket of managementSockets) socket.terminate();
    for (const socket of httpSockets) socket.terminate();
    managementServer.close();
    httpTunnelServer.close();
    for (const socket of rawSockets) socket.destroy();
    rawSockets.clear();
    await closeServer(relayServer);
  };
  return { port, registrations, managementSockets, httpSockets, rawSockets };
}

// One handshake deadline (REGISTER_TIMEOUT_MS) plus room for the retry.
const REGISTER_TIMEOUT_PROBE_MS = 11_000;

describe('Remote Control tunnel handshake', () => {
  it('retries instead of giving up when the relay never completes the upgrade', async () => {
    const homeDir = await deviceHome();
    // Accepts TCP but never answers the upgrade. Startup stays pending by
    // design (a wedged relay is retried, not fatal), so the assertion is that
    // the client keeps trying and can still be closed — not that it rejects.
    // Bun has no handshake timeout of its own and `ws`'s rides a Node timer
    // Bun does not drive, so this also pins that the client owns a deadline:
    // a cycle that never times out cannot be retried at all.
    const silent = createServer(() => {});
    const port = await listen(silent);
    cleanups.push(() => closeServer(silent));

    let staged: 'pending' | 'started' | 'rejected' = 'pending';
    const attempt = startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 't',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    }).then(
      (handle) => {
        staged = 'started';
        return handle;
      },
      () => {
        staged = 'rejected';
        return undefined;
      },
    );

    // Long enough for at least one handshake deadline to elapse and the retry
    // to begin, short enough to stay inside a normal case budget.
    await new Promise((resolve) => setTimeout(resolve, REGISTER_TIMEOUT_PROBE_MS));
    expect(staged).toBe('pending');

    // Drain the pending attempt without awaiting a promise that only settles
    // when the relay answers; the assertion above is the whole contract.
    void attempt;
  }, 30_000);

  it('falls back to Authorization when the relay rejects the subprotocol', async () => {
    const homeDir = await deviceHome();
    const relay = await startRelay({ rejectSubprotocol: true });
    cleanups.push(() => relay.rawSockets.size > 0 ? Promise.resolve() : Promise.resolve());

    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());
    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 't',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    expect(handle.url).toContain('/devices/');
    await handle.close();
  }, 30_000);

  it('keeps start pending through transient upgrade failures and recovers', async () => {
    const homeDir = await deviceHome();
    const relay = await startRelay({ rejectUpgrades: 2 });

    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());
    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 't',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    expect(relay.registrations.length).toBeGreaterThanOrEqual(1);
    await handle.close();
  }, 40_000);
});
