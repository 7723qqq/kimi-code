import { readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IEventService, IMcpManagementService } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { createKlient, serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { IpcChannel } from '../src/transports/ipc/channel.js';
import { NdjsonDecoder } from '../src/transports/ipc/codec.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

// Windows cannot listen on Unix-socket paths at all (Node throws EACCES),
// so the whole socket-behavior suite is POSIX-only.
if (process.platform !== 'win32') {
  defineKlientConformance('ipc', async () => {
    const { homeDir, app } = await makeEngine();
    const socketPath = join(homeDir, 'klient.sock');
    const host = await serveKlientIpc({ scope: app, socketPath });
    const klient = createKlient({ socketPath, token: host.token });
    return {
      klient,
      app,
      cleanup: async () => {
        await klient.close();
        await host.close();
        app.dispose();
        await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
      },
    };
  });
}

// Windows cannot listen on Unix-socket paths at all (Node throws EACCES),
// so the whole socket-behavior suite is POSIX-only.
describe.skipIf(process.platform === 'win32')('ipc transport specifics', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;

  async function setup(opts: { token?: string } = {}): Promise<string> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, token: opts.token });
    return socketPath;
  }

  async function teardown(): Promise<void> {
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it('rejects calls when the socket path does not exist', async () => {
    const klient = createKlient({ socketPath: join(tmpdir(), 'klient-no-such.sock') });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();
  });

  it('rejects calls made after close', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath, token: host?.token });
    await klient.global.env();
    await klient.close();
    // env() is served from its frozen-snapshot cache after the first call, so
    // probe the closed channel with an uncached method instead.
    await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    await teardown();
  });

  it('generates a token when none is supplied and rejects token-less clients', async () => {
    const socketPath = await setup();
    expect(host?.token).toBeTypeOf('string');
    expect(host?.token.length).toBeGreaterThan(0);

    // A client without the token must be refused even though the host did
    // not configure one explicitly.
    const noToken = createKlient({ socketPath });
    await expect(noToken.global.env()).rejects.toThrow();
    await noToken.close();

    const withToken = createKlient({ socketPath, token: host?.token });
    await expect(withToken.global.env()).resolves.toMatchObject({ platform: process.platform });
    await withToken.close();
    await teardown();
  });

  it('refuses to remove a non-socket file at the socket path', async () => {
    const target = join(tmpdir(), `klient-ipc-not-socket-${Date.now()}.txt`);
    await writeFile(target, 'precious data');
    try {
      await expect(
        serveKlientIpc({ scope: await makeEngine().then((e) => e.app), socketPath: target }),
      ).rejects.toThrow('not a socket');
      // The file must be untouched.
      await expect(readFile(target, 'utf8')).resolves.toBe('precious data');
    } finally {
      await rm(target, { force: true });
    }
  });

  it('drops clients whose hello token mismatches', async () => {
    const socketPath = await setup({ token: 'right' });
    const klient = createKlient({ socketPath, token: 'wrong' });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();

    const ok = createKlient({ socketPath, token: 'right' });
    await expect(ok.global.env()).resolves.toMatchObject({ platform: process.platform });
    await ok.close();
    await teardown();
  });

  it('completeAuth outlives the channel default call timeout', async () => {
    const socketPath = await setup();
    // A slow engine-side wait: without the facade's per-call deadline the
    // channel's default would kill the long poll mid-flight.
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    const cancelSpy = vi
      .spyOn(management, 'cancelServerAuth')
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    const klient = createKlient({ socketPath, token: host!.token, callTimeoutMs: 25 });
    try {
      // completeAuth passes the engine wait + margin as its per-call deadline,
      // so the 200ms wait resolves instead of dying at the 25ms default.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 100 }),
      ).resolves.toBeUndefined();
      // Calls without the override still die at the channel default.
      await expect(klient.global.mcp.cancelAuth({ flowId: 'flow-1' })).rejects.toThrow(
        'call timed out after 25ms',
      );
    } finally {
      completeSpy.mockRestore();
      cancelSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });

  it('completeAuth clamps a near-max timeoutMs instead of overflowing the call timer', async () => {
    const socketPath = await setup();
    const management = app.accessor.get(IMcpManagementService);
    const completeSpy = vi
      .spyOn(management, 'completeServerAuth')
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    const klient = createKlient({ socketPath, token: host!.token, callTimeoutMs: 25 });
    try {
      // timeoutMs at the contract max plus the facade margin would overflow
      // Node's 32-bit setTimeout into ~1ms; the clamp keeps the call alive
      // until the engine-side wait resolves.
      await expect(
        klient.global.mcp.completeAuth({ flowId: 'flow-1', timeoutMs: 2 ** 31 - 1 }),
      ).resolves.toBeUndefined();
      expect(completeSpy).toHaveBeenCalled();
    } finally {
      completeSpy.mockRestore();
      await klient.close();
    }
    await teardown();
  });

  // D1: a stream whose terminal frame never arrives used to wait forever. The
  // deadline is opt-in so the default behaviour is unchanged.
  it('stream timeoutMs bounds a stalled stream; without it the iteration waits', async () => {
    const socketPath = await setup();

    // A peer that completes the handshake and then ignores stream frames.
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        for (const line of d.toString().split('\n')) {
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line);
            if (frame.type === 'hello') {
              sock.write(`${JSON.stringify({ type: 'hello_ack' })}\n`);
            }
          } catch {
            // Ignore partial lines.
          }
        }
      });
    });
    const altPath = `${socketPath}-stalled`;
    await new Promise<void>((resolve) => server.listen(altPath, resolve));

    async function drain(options?: { timeoutMs: number }): Promise<string> {
      const channel = new IpcChannel({ socketPath: altPath, callTimeoutMs: 2000 });
      try {
        const iter = channel.stream({}, 'svc', 'method', [], options)?.[Symbol.asyncIterator]();
        const first = await Promise.race([
          iter?.next(),
          new Promise<'WAITING'>((resolve) => setTimeout(() => resolve('WAITING'), 1500)),
        ]);
        return first === 'WAITING' ? 'waiting' : `resolved ${JSON.stringify(first).slice(0, 40)}`;
      } catch (error) {
        return `rejected ${(error as Error).message.slice(0, 40)}`;
      } finally {
        await channel.close();
      }
    }

    try {
      expect(await drain()).toBe('waiting');
      expect(await drain({ timeoutMs: 200 })).toMatch(/rejected stream timed out after 200ms/);
    } finally {
      server.close();
      await rm(altPath, { force: true });
      await teardown();
    }
  });

  // A26/F1: the decoder used to decode each socket chunk on its own, so a
  // multi-byte character split by a read boundary became U+FFFD on both sides.
  // These two cases pin the byte-wise contract: only whole lines are decoded.
  it('decodes a UTF-8 character split across two pushes', () => {
    const text = '中文标题 · emoji 🚀';
    const bytes = Buffer.from(`${JSON.stringify({ type: 'result', data: text })}\n`, 'utf8');

    // Cut at the first UTF-8 continuation byte, i.e. inside a character.
    let cut = -1;
    for (let i = 1; i < bytes.length; i += 1) {
      if (((bytes[i] as number) & 0xc0) === 0x80) {
        cut = i;
        break;
      }
    }
    expect(cut).toBeGreaterThan(0);

    const decoder = new NdjsonDecoder();
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([]);
    const frames = decoder.push(bytes.subarray(cut));
    expect(frames).toEqual([{ type: 'result', data: text }]);
    expect(frames[0]?.data).not.toContain('\uFFFD');
  });

  it('round-trips a >1 MB Chinese title over a real socket byte-for-byte', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath, token: host?.token });
    try {
      // 1 MiB of non-ASCII text: the reply spans many socket reads, so a
      // per-chunk decode corrupts characters at every read boundary.
      const title = '中文标题😀'.repeat(70_000);
      expect(Buffer.byteLength(title, 'utf8')).toBeGreaterThan(1_000_000);

      const created = await klient.global.sessions.create({ workDir: process.cwd(), title });
      const fetched = await klient.global.sessions.get(created.id);
      const roundTripped = fetched?.title ?? '';
      expect(roundTripped.length).toBe(title.length);
      expect(roundTripped).toBe(title);
      expect(roundTripped.includes('\uFFFD')).toBe(false);
    } finally {
      await klient.close();
      await teardown();
    }
  });

  // A26/F5: only `stream_data` respected socket back-pressure; every other
  // frame path called `send`, which ignored `socket.write`'s return value. A
  // client that stops reading (TCP receive window closes) therefore let the
  // host's outbound buffer grow with the event rate — unbounded memory in the
  // long-lived host. These two cases pin the bound and the no-loss guarantee.
  it('bounds the host write buffer while a client is not reading, then delivers every event in order', async () => {
    const socketPath = await setup();
    const events = app.accessor.get(IEventService);

    // Observe the host-side connection object: capture the accepted socket
    // (the server peer has `.server`) so `writableLength` can be asserted.
    const net = await import('node:net');
    const originalWrite = net.Socket.prototype.write;
    let hostSocket: net.Socket | undefined;
    Object.defineProperty(net.Socket.prototype, 'write', {
      configurable: true,
      writable: true,
      value: function (this: net.Socket, ...args: Parameters<net.Socket['write']>) {
        if (hostSocket === undefined && (this as { server?: unknown }).server !== undefined) {
          hostSocket = this as unknown as net.Socket;
        }
        return (originalWrite as (...a: unknown[]) => boolean).apply(this, args);
      },
    });

    const total = 600;
    const seqs: number[] = [];
    const client = net.createConnection(socketPath);
    const received: string[] = [];
    let buffered = '';
    client.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim().length === 0) continue;
        received.push(line);
      }
    });

    const countEvents = (): number =>
      received.filter((line) => (JSON.parse(line) as { type?: string }).type === 'event').length;

    try {
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.write(`${JSON.stringify({ type: 'hello', token: host?.token })}\n`);
      client.write(`${JSON.stringify({ type: 'listen', id: 'L', event: 'events' })}\n`);

      // Wait for `listen_result` so the dispatcher subscription exists before
      // the burst starts.
      await vi.waitFor(
        () => {
          expect(received.some((line) => JSON.parse(line).type === 'listen_result')).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(hostSocket).toBeDefined();

      client.pause();
      for (let i = 0; i < total; i += 1) {
        events.publish({
          type: 'test.push',
          seq: i,
          pad: 'x'.repeat(1000),
        } as unknown as Parameters<typeof events.publish>[0]);
      }

      // Wait for the outbound queue to stop growing (either it hit the bound,
      // or the burst has been fully buffered).
      let settledAt = -1;
      for (let i = 0; i < 40; i += 1) {
        const before = hostSocket!.writableLength;
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (hostSocket!.writableLength === before && before > 0) {
          settledAt = before;
          break;
        }
      }
      expect(settledAt).toBeGreaterThan(0);

      const hwm = hostSocket!.writableHighWaterMark;
      expect(hostSocket!.writableLength).toBeLessThanOrEqual(4 * hwm);

      client.resume();
      await vi.waitFor(() => expect(countEvents()).toBe(total), { timeout: 10_000 });

      const parsed = received
        .map((line) => JSON.parse(line) as { type: string; data?: { seq?: number } })
        .filter((frame) => frame.type === 'event');
      for (const frame of parsed) {
        if (frame.data?.seq !== undefined) seqs.push(frame.data.seq);
      }
      expect(seqs).toHaveLength(total);
      expect(seqs).toEqual(Array.from({ length: total }, (_, i) => i));
    } finally {
      Object.defineProperty(net.Socket.prototype, 'write', {
        configurable: true,
        writable: true,
        value: originalWrite,
      });
      client.destroy();
      await teardown();
    }
  });

  // A26/F2: with a dead socket path the handshake rejects, so a listener or
  // stream registered before it must fail loudly instead of waiting forever —
  // the derived `ready.then(...)` promises had no rejection handler.
  it('reports a failed handshake to listeners and streams', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const socketPath = join(tmpdir(), `klient-no-such-${Date.now()}.sock`);
    const klient = createKlient({ socketPath });
    try {
      const sessionEvents = klient.session('s').events;
      const errors: Error[] = [];
      sessionEvents.onError((error) => {
        errors.push(error);
      });
      const dispose = sessionEvents.on('metadata.changed', () => undefined);

      await new Promise((resolve) => setTimeout(resolve, 500));
      dispose.dispose();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);

      // A stream has no default deadline: `next()` must reject, not hang.
      const iter = klient.global.kosong
        .generate('no-such-model', { systemPrompt: '', messages: [] })[Symbol.asyncIterator]();
      await expect(iter.next()).rejects.toThrow();

      // The rejected `ready` promises were handled, so nothing bubbled up.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await klient.close();
    }
  });
});
