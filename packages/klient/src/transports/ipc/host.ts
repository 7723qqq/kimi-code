/**
 * IPC host — serves one engine scope over a unix domain socket. Incoming
 * frames are bridged to the shared in-process dispatcher (the same code the
 * memory transport uses), so ipc and in-memory behavior are identical by
 * construction; only serialization separates them.
 */

import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { createMemoryDispatcher, type ScopeLike } from '../memory/dispatcher.js';
import { encodeFrame, NdjsonDecoder, type IpcFrame } from './codec.js';

const REQUEST_INVALID = 40001;
const UNAUTHORIZED = 40100;

export interface ServeKlientIpcOptions {
  /** A bootstrapped engine app scope (same value `createKlient({ scope })` takes). */
  readonly scope: ScopeLike;
  /** Unix socket path to listen on. A stale socket file at the path is removed first. */
  readonly socketPath: string;
  /**
   * Optional token; when set, the client's `hello` must carry the same token.
   * When omitted, a random token is generated and exposed on the returned
   * host — the socket is never left open to every local process.
   */
  readonly token?: string;
}

export interface KlientIpcHost {
  readonly socketPath: string;
  /** The bearer token clients must send in `hello`; always set. */
  readonly token: string;
  close(): Promise<void>;
}

function scopeRefFromFrame(frame: IpcFrame): ScopeRef {
  const scope: { workspaceId?: string; sessionId?: string; agentId?: string } = {};
  if (typeof frame.workspaceId === 'string') scope.workspaceId = frame.workspaceId;
  if (typeof frame.sessionId === 'string') scope.sessionId = frame.sessionId;
  if (typeof frame.agentId === 'string') scope.agentId = frame.agentId;
  return scope;
}

function eventSourceFromFrame(frame: IpcFrame): EventSourceRef {
  if (typeof frame.service === 'string' && typeof frame.event === 'string') {
    return { kind: 'emitter', service: frame.service, event: frame.event };
  }
  if (typeof frame.event === 'string' && frame.event.length > 0) {
    return { kind: 'stream', name: frame.event };
  }
  throw new RPCError(REQUEST_INVALID, `unknown event stream: ${String(frame.event)}`);
}

export async function serveKlientIpc(options: ServeKlientIpcOptions): Promise<KlientIpcHost> {
  // The socket grants full engine control (shell execution, permission
  // changes, session deletion) to any process that can reach it — never
  // leave it token-less. Generate one when the caller did not supply it.
  const token = options.token ?? randomBytes(32).toString('hex');

  // The IPC codec (`encodeFrame`) already JSON-serializes every frame at the
  // socket boundary, so the dispatcher's wire-clone per value is the same
  // isolation the codec provides — no extra round-trip is needed here.
  const dispatcher = createMemoryDispatcher(options.scope);

  // Best-effort cleanup of a stale socket file. Only a real socket (or a
  // missing file) is removed — a regular file at the path is a caller bug
  // and must not be deleted (e.g. a typo'd `~/.bashrc` as the socket path).
  try {
    const st = await lstat(options.socketPath);
    if (st.isSocket()) {
      await unlink(options.socketPath);
    } else {
      throw new Error(
        `refusing to remove non-socket path ${options.socketPath} (file exists and is not a socket)`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const connections = new Set<Socket>();

  const server: Server = createServer((socket) => {
    connections.add(socket);
    const decoder = new NdjsonDecoder();
    const listens = new Map<string, IDisposable>();
    const activeStreams = new Map<string, AbortController>();
    let helloDone = false;

    /**
     * Write one frame and report whether the socket's buffer accepted it.
     * `false` means the kernel/stream buffer is full — the caller should stop
     * producing and wait for `drain` (`awaitSocketDrain`).
     *
     * Ungated by design: `ready` (the greeting) and the `hello` verdict must
     * leave immediately, and `stream_end` / `stream_error` fire once per stream
     * — waiting on a drain for those trades a tiny frame for a stalled
     * handshake. Everything a slow client can provoke repeatedly goes through
     * `sendThrottled`.
     */
    const send = (frame: IpcFrame): boolean => {
      if (socket.destroyed) return true;
      return socket.write(encodeFrame(frame));
    };
    /** Same as `send`, kept as the name the `stream_data` loop reads by. */
    const tryWrite = (frame: IpcFrame): boolean => send(frame);
    /** Resolve when the socket drains (buffer flushed) or is destroyed/closed. */
    const awaitSocketDrain = (): Promise<void> =>
      new Promise((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        const settle = (): void => {
          socket.off('drain', settle);
          socket.off('close', settle);
          resolve();
        };
        socket.once('drain', settle);
        socket.once('close', settle);
      });
    /**
     * Write a frame and apply back-pressure: when the socket buffer is full the
     * caller waits for `drain` instead of queueing more below it. A client that
     * stops reading must not make the host buffer unbounded — the same
     * treatment the `stream_data` loop already applies to stream chunks.
     *
     * Frames queue behind one another (FIFO) so the bound actually holds: the
     * engine delivers an event burst synchronously, so a per-frame check that
     * did not serialize would let every frame in the burst through before the
     * first one observed a full buffer. Callers keep the producer's
     * fire-and-forget shape (`void sendThrottled(...)`); ordering is unchanged,
     * still one write at a time.
     */
    let outbound: Promise<void> = Promise.resolve();
    let droppedFrames = 0;
    const sendThrottled = (frame: IpcFrame): Promise<void> => {
      outbound = outbound.then(async () => {
        try {
          if (!send(frame)) await awaitSocketDrain();
        } catch (error) {
          droppedFrames += 1;
          if (droppedFrames === 1) {
            process.stderr.write(
              `[klient/ipc] dropping frames the socket refused: ${String(error)}\n`,
            );
          }
        }
      });
      return outbound;
    };
    const sendError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        void sendThrottled({
          type: 'error',
          id,
          code: error.code,
          msg: error.message,
          data: error.details,
        });
      } else {
        void sendThrottled({
          type: 'error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const sendStreamError = (id: string, error: unknown): void => {
      if (error instanceof RPCError) {
        send({ type: 'stream_error', id, code: error.code, msg: error.message });
      } else {
        send({
          type: 'stream_error',
          id,
          code: 50001,
          msg: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleFrame = (frame: IpcFrame): void => {
      const id = typeof frame.id === 'string' ? frame.id : '';
      switch (frame.type) {
        case 'hello': {
          // Validate against the resolved token (the caller-supplied one or the
          // generated one exposed on `host.token`). Validating `options.token`
          // instead would accept every `hello` when the caller omitted a token,
          // silently disabling the auth the generated token is meant to provide.
          if (frame.token !== token) {
            send({ type: 'error', id: 'hello', code: UNAUTHORIZED, msg: 'unauthorized' });
            socket.end();
            return;
          }
          helloDone = true;
          return;
        }
        case 'call': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg)
            ? frame.arg
            : frame.arg === undefined
              ? []
              : [frame.arg];
          dispatcher
            .call(scopeRefFromFrame(frame), String(frame.service), String(frame.method), args)
            .then((data) => {
              void sendThrottled({ type: 'result', id, data });
            })
            .catch((error: unknown) => {
              sendError(id, error);
            });
          return;
        }
        case 'listen': {
          if (!helloDone) {
            sendError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          try {
            const source = eventSourceFromFrame(frame);
            const sub = dispatcher.listen(
              scopeRefFromFrame(frame),
              source,
              (data) => {
                void sendThrottled({ type: 'event', id, data });
              },
              (error) => {
                sendError(id, error);
              },
            );
            listens.set(id, sub);
            void sendThrottled({ type: 'listen_result', id });
          } catch (error) {
            sendError(id, error);
          }
          return;
        }
        case 'unlisten': {
          listens.get(id)?.dispose();
          listens.delete(id);
          return;
        }
        case 'stream': {
          if (!helloDone) {
            sendStreamError(id, new RPCError(REQUEST_INVALID, 'expected hello first'));
            return;
          }
          const args = Array.isArray(frame.arg)
            ? frame.arg
            : frame.arg === undefined
              ? []
              : [frame.arg];
          const ac = new AbortController();
          activeStreams.set(id, ac);
          const iterable = dispatcher.stream(
            scopeRefFromFrame(frame),
            String(frame.service),
            String(frame.method),
            args,
          );
          void (async () => {
            try {
              for await (const chunk of iterable) {
                if (ac.signal.aborted || socket.destroyed) break;
                // Respect socket backpressure: when the consumer is slower
                // than the engine, `write` returns false once the buffer is
                // full — pause the pull until the socket drains instead of
                // letting the outbound buffer grow unbounded.
                if (!tryWrite({ type: 'stream_data', id, data: chunk })) {
                  await awaitSocketDrain();
                }
              }
              if (!ac.signal.aborted && !socket.destroyed) {
                send({ type: 'stream_end', id });
              }
            } catch (error) {
              if (!ac.signal.aborted && !socket.destroyed) {
                sendStreamError(id, error);
              }
            } finally {
              activeStreams.delete(id);
            }
          })();
          return;
        }
        case 'stream_cancel': {
          const ac = activeStreams.get(id);
          if (ac !== undefined) {
            ac.abort();
            activeStreams.delete(id);
          }
          return;
        }
        default:
          return;
      }
    };

    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        handleFrame(frame);
      }
    });
    const teardown = (): void => {
      for (const sub of listens.values()) sub.dispose();
      listens.clear();
      for (const ac of activeStreams.values()) ac.abort();
      activeStreams.clear();
      connections.delete(socket);
      if (droppedFrames > 0) {
        process.stderr.write(
          `[klient/ipc] closed after dropping ${droppedFrames} frame(s) the socket refused\n`,
        );
      }
    };
    socket.on('close', teardown);
    socket.on('error', teardown);

    send({ type: 'ready' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });

  return {
    socketPath: options.socketPath,
    token,
    close: () => {
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      return new Promise<void>((resolve) => {
        server.close(() => {
          void unlink(options.socketPath).then(
            () => {
              resolve();
            },
            () => {
              resolve();
            },
          );
        });
      });
    },
  };
}
