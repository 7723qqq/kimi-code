import { afterEach, describe, expect, it } from 'bun:test';

import type { IHostTimerHandle, IHostTimers } from '#/os/interface/hostTimers';
import { DEFAULT_INITIALIZE_TIMEOUT_MS, RemoteExecConnection } from '#/remote/client/connection';
import { ConnectionClosedError, RequestTimeoutError } from '#/remote/protocol/errors';
import type { BytePipe } from '#/remote/client/execBridge';
import { RemoteProcessService } from '#/os/backends/remote/remoteProcess';
import {
  encodeFrame,
  LineFrameDecoder,
  MAX_MESSAGE_BYTES,
  ProtocolViolationError,
  compareVersions,
} from '#/remote/protocol/index';
import {
  FS_GET_METADATA_METHOD,
  FS_READ_FILE_METHOD,
  INITIALIZE_METHOD,
  PROCESS_OUTPUT_METHOD,
  PROCESS_SIGNAL_METHOD,
  PROCESS_START_METHOD,
} from '#/remote/protocol/methods';
import {
  connectInProcess,
  connectSubprocess,
  createScriptedServer,
  TEST_ENVIRONMENT,
  testInitializeResult,
  type ScriptedFrame,
} from './helpers/loopback';

async function viWaitFor(fn: () => void | Promise<void>, opts?: { timeout?: number }): Promise<void> {
  const deadline = Date.now() + (opts?.timeout ?? 1000);
  for (;;) {
    try {
      await fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

interface ScheduledHandshakeTimer extends IHostTimerHandle {
  readonly timeoutMs: number;
  readonly callback: () => void;
  readonly clearedBy: IHostTimerHandle[];
  fired: boolean;
}

function createHandshakeTimers(): {
  timers: IHostTimers;
  scheduled: ScheduledHandshakeTimer[];
  advance: (byMs: number) => Promise<void>;
} {
  let elapsed = 0;
  const scheduled: ScheduledHandshakeTimer[] = [];
  const timers: IHostTimers = {
    _serviceBrand: undefined,
    setClampedTimeout: (callback, timeoutMs) => timers.setTimeout(callback, timeoutMs),
    setTimeout: (callback, timeoutMs) => {
      const timer: ScheduledHandshakeTimer = {
        timeoutMs,
        callback,
        clearedBy: [],
        fired: false,
        unref: () => {},
      };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as ScheduledHandshakeTimer).clearedBy.push(handle);
    },
  };
  const advance = async (byMs: number): Promise<void> => {
    const target = elapsed + byMs;
    for (let guard = 0; guard < 100; guard += 1) {
      const due = scheduled
        .filter(
          (timer) => timer.clearedBy.length === 0 && !timer.fired && timer.timeoutMs <= target,
        )
        .toSorted((left, right) => left.timeoutMs - right.timeoutMs)[0];
      if (due === undefined) break;
      due.fired = true;
      due.callback();
      await Promise.resolve();
    }
    elapsed = target;
  };
  return { timers, scheduled, advance };
}

function pushAll(decoder: LineFrameDecoder, chunks: Uint8Array[]): unknown[] {
  const frames: unknown[] = [];
  for (const chunk of chunks) frames.push(...decoder.push(chunk));
  return frames;
}

describe('NDJSON line framing', () => {
  it('assembles frames split across packets', () => {
    const decoder = new LineFrameDecoder();
    const encoded = encodeFrame({ hello: 'world' });
    const frames = pushAll(decoder, [encoded.subarray(0, 5), encoded.subarray(5, encoded.length - 2), encoded.subarray(encoded.length - 2)]);
    expect(frames).toEqual([{ hello: 'world' }]);
  });

  it('assembles multi-byte UTF-8 split across packets', () => {
    const decoder = new LineFrameDecoder();
    const encoded = encodeFrame({ text: '你好🙂' });
    const frames: unknown[] = [];
    for (let i = 0; i < encoded.length; i += 3) {
      frames.push(...decoder.push(encoded.subarray(i, i + 3)));
    }
    expect(frames).toEqual([{ text: '你好🙂' }]);
  });

  it('rejects a message over the 64MiB cap', () => {
    const decoder = new LineFrameDecoder();
    const big = Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x61);
    expect(() => decoder.push(big)).toThrow(ProtocolViolationError);
  });

  it('rejects an incomplete line that grows past the cap without a newline', () => {
    const decoder = new LineFrameDecoder();
    decoder.push(Buffer.alloc(MAX_MESSAGE_BYTES, 0x61));
    expect(() => decoder.push(Buffer.from('x'))).toThrow(ProtocolViolationError);
  });
});

describe('version comparison', () => {
  it('orders semver-ish version strings', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
  });
});

describe('handshake', () => {
  it('disconnects when the peer sends bytes before the initialize response', async () => {
    await expect(
      connectSubprocess({ env: { EXEC_SERVER_BANNER: 'Welcome to the machine\n' } }),
    ).rejects.toThrow();
  });

  it('refuses an executor below MIN_EXECUTOR_VERSION with upgrade guidance', async () => {
    await expect(connectInProcess({ version: '0.0.1' })).rejects.toThrow(/below the minimum/);
  });

  it('accepts a Windows executor environment with the required process lifecycle', async () => {
    const { connection, loopback } = await connectInProcess({
      environment: { ...TEST_ENVIRONMENT, osKind: 'Windows', pathClass: 'win32', windowsProcessLifecycle: true },
    });
    expect(connection.environment.pathClass).toBe('win32');
    connection.close();
    await loopback.host.done;
  });

  it('refuses a Windows executor without the required process lifecycle', async () => {
    await expect(
      connectInProcess({
        environment: { ...TEST_ENVIRONMENT, osKind: 'Windows', pathClass: 'win32' },
      }),
    ).rejects.toThrow(/Windows executor does not support the required process lifecycle/);
  });

  it('refuses an unsupported executor path class', async () => {
    await expect(
      connectInProcess({
        environment: { ...TEST_ENVIRONMENT, pathClass: 'plan9' },
      }),
    ).rejects.toThrow(/unsupported path class plan9/);
  });

  it('fails pending calls when the connection drops', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
    });
    const rejections: Promise<unknown>[] = [] as Promise<unknown>[];
    for (let i = 0; i < 260; i += 1) {
      rejections.push(
        connection.call(FS_READ_FILE_METHOD, { path: `/nope-${i}` }).then(
          () => {
            throw new Error('expected rejection');
          },
          (error: unknown) => {
            if (!(error instanceof ConnectionClosedError)) throw error;
          },
        ),
      );
    }
    connection.close();
    await Promise.all(rejections);
  });
});

describe('request call timeout', () => {
  it('times out a stalled exec call without killing the connection', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      requestCallTimeoutMs: 100,
    });
    const started = Date.now();
    const call = connection.call(PROCESS_START_METHOD, {
      processId: 'p1',
      argv: ['sleep', '1'],
      cwd: '/tmp',
    });
    await expect(call).rejects.toThrow(RequestTimeoutError);
    await expect(call).rejects.toThrow(/timed out after 100ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });

  it('cancels a process start that timed out, so the late spawn cannot go orphan', async () => {
    const seen: ScriptedFrame[] = [];
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
        return;
      }
      seen.push(frame);

      if (frame.method === PROCESS_SIGNAL_METHOD) {
        reply({ id: frame.id, result: {} });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      requestCallTimeoutMs: 100,
    });
    const processes = new RemoteProcessService(connection, '/tmp', '/bin/bash');
    await expect(processes.spawn('sleep', ['300'])).rejects.toThrow(RequestTimeoutError);

    await viWaitFor(() => {
      const start = seen.find((frame) => frame.method === PROCESS_START_METHOD);
      const cancel = seen.find((frame) => frame.method === PROCESS_SIGNAL_METHOD);
      expect(start).toBeDefined();
      expect(cancel).toBeDefined();
      expect(cancel?.params).toMatchObject({
        processId: (start?.params as { processId: string }).processId,
        signal: 'terminate',
      });
    });
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });
});

describe('initialize timeout default', () => {
  afterEach(() => {
  });

  it('fails only when the injected handshake timer reaches the default window', async () => {
    const { timers, scheduled, advance } = createHandshakeTimers();
    const pipe = createScriptedServer(() => {});
    let settled = false;
    const pending = RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      handshakeTimers: timers,
    }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    expect(scheduled).toHaveLength(1);
    const [handshakeTimer] = scheduled;
    if (handshakeTimer === undefined) throw new Error('missing handshake timer');
    expect(handshakeTimer.timeoutMs).toBe(DEFAULT_INITIALIZE_TIMEOUT_MS);
    expect(handshakeTimer.clearedBy).toEqual([]);
    await advance(DEFAULT_INITIALIZE_TIMEOUT_MS - 1);
    expect(handshakeTimer.fired).toBe(false);
    expect(settled).toBe(false);
    await advance(1);
    expect(handshakeTimer.fired).toBe(true);
    expect(settled).toBe(true);
    await expect(pending).rejects.toMatchObject({
      name: 'HandshakeError',
      kind: 'timeout',
      message: `initialize timed out after ${DEFAULT_INITIALIZE_TIMEOUT_MS}ms`,
    });
    expect(handshakeTimer.clearedBy).toEqual([handshakeTimer]);
  });

  it('clears the injected timer after a successful initialize', async () => {
    const { timers, scheduled, advance } = createHandshakeTimers();
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      handshakeTimers: timers,
    });
    expect(scheduled).toHaveLength(1);
    const [handshakeTimer] = scheduled;
    if (handshakeTimer === undefined) throw new Error('missing handshake timer');
    expect(handshakeTimer.clearedBy).toEqual([handshakeTimer]);
    expect(handshakeTimer.timeoutMs).toBe(DEFAULT_INITIALIZE_TIMEOUT_MS);
    await advance(DEFAULT_INITIALIZE_TIMEOUT_MS);
    expect(handshakeTimer.fired).toBe(false);
    expect(connection.closed).toBe(false);
    connection.close();
  });
});

describe('liveness heartbeat', () => {
  afterEach(() => {
  });

  it('closes the connection and fails pending calls when the pong does not arrive', async () => {
    const pipe = createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
      }
    });
    const connection = await RemoteExecConnection.connect(pipe, {
      clientName: 'test',
      clientVersion: '0.0.0',
      livenessIntervalMs: 100,
      livenessTimeoutMs: 50,
    });
    const stalled = connection.call(FS_READ_FILE_METHOD, { path: '/x' });
    const settled = stalled.catch((error: unknown) => error);
    await Bun.sleep(200);
    await expect(settled).resolves.toBeInstanceOf(ConnectionClosedError);
    expect(connection.closed).toBe(true);
    expect(connection.closeReason?.reason).toMatch(/liveness ping timed out/);
    expect(connection.closeReason?.kind).toBe('liveness');
  });
});

describe('notification dispatch', () => {
  function notificationScripting(script: (notify: (value: unknown) => void) => void): BytePipe {
    return createScriptedServer((frame, reply) => {
      if (frame.method === INITIALIZE_METHOD) {
        reply({ id: frame.id, result: testInitializeResult() });
        script((value: unknown) => {
          reply(value);
        });
        return;
      }
      if (frame.method === FS_GET_METADATA_METHOD) {
        reply({ id: frame.id, result: { isDirectory: true } });
      }
    });
  }

  async function settleDispatch(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
  }

  it('contains a throwing notification handler instead of crashing the process', async () => {
    const pipe = notificationScripting((notify) => {
      notify({
        method: PROCESS_OUTPUT_METHOD,
        params: { processId: 'p1', seq: 1, stream: 'stdout', chunkBase64: Buffer.from('x').toString('base64') },
      });
    });
    const connection = await RemoteExecConnection.connect(pipe, { clientName: 'test', clientVersion: '0.0.0' });
    connection.onNotification(PROCESS_OUTPUT_METHOD, () => {
      throw new Error('boom');
    });
    await settleDispatch();
    expect(connection.closed).toBe(false);
    await expect(connection.call(FS_GET_METADATA_METHOD, { path: '/' })).resolves.toMatchObject({ isDirectory: true });
    connection.close();
  });
});
